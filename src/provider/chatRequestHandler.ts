import * as vscode from 'vscode';
import { GatewayClient } from '../api/client';
import { OpenAIChatCompletionRequest, OpenAIMessage } from '../api/types';
import { buildChatRequest, OpenAIToolDefinition, ToolChoice } from '../api/requestBuilder';
import { GatewayConfig } from '../config/gatewayConfig';
import { resolvePerModelOptions } from '../config/perModelOptions';
import { REQUEST_SAMPLER_KEYS } from '../discovery/types';
import {
  TOKEN_CONSTANTS,
  buildInputText,
  calculateMaxInputTokens,
  calculateSafeMaxOutputTokens,
  estimateTextTokens,
} from '../chat/tokenBudget';
import { compactConversationHistory } from '../chat/compaction';
import { prepareToolCallBatch, PreparedToolCallBatch, ToolCallArguments } from '../chat/toolArguments';
import {
  StreamChunk,
  StreamReporter,
  ToolCallBatchError,
  isEmptyStreamResult,
  streamResponse,
} from '../chat/responseStreamer';
import { friendlyModelName } from '../models/modelDisplay';
import { TokenUsage } from '../status/sessionStats';
import { ModelCatalog } from './modelCatalog';
import { convertAllMessages } from './vscodeParts';
import { handleChatError } from './notifications';
import {
  buildForcedSummaryInstruction,
  buildReplanInstruction,
  DEFAULT_PROGRESS_POLICY,
  evaluateCandidateToolBatchProgress,
  evaluateTranscriptProgress,
} from '../agent/progress';
import {
  limitToolsBySchemaTokenBudget,
  selectToolsForRequest,
} from '../agent/toolSelection';
import {
  CompactionPolicy,
  ProgressEvaluation,
  ProgressPolicy,
  ToolFamily,
} from '../agent/types';

const DEFAULT_TEMPERATURE = 0.7;
const DEBUG_REQUEST_MAX_LOG_LENGTH = 2000;
const MAX_CHAT_ATTEMPTS = 4;
const TOOL_FREE_RECOVERY_INSTRUCTION =
  'Do not call tools. Return a concise, grounded summary or explanation based only on the conversation, and clearly state any missing information.';
const COMPACTION_POLICY: CompactionPolicy = {
  taskAnchorCharacters: 1200,
  archivedSummaryCharacters: 2000,
  groundedAssistantCharacters: 200,
  toolResultSummaryCharacters: 400,
  reserveTokensForSyntheticMessages: 256,
};

/** Return `value` when it's a finite number, else `undefined`. */
function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Forward the backend-discovered sampler params (see REQUEST_SAMPLER_KEYS —
 * excludes temperature, which is resolved explicitly, and context/seed) so
 * the server doesn't default an omitted value — notably `top_p`, which
 * Ollama's OpenAI endpoint otherwise fills with 1.0, overriding the
 * Modelfile.
 */
function discoveredSamplerOptions(
  discovered: Readonly<Record<string, number>> | undefined
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!discovered) { return out; }
  for (const key of REQUEST_SAMPLER_KEYS) {
    if (typeof discovered[key] === 'number') { out[key] = discovered[key]; }
  }
  return out;
}

export function buildProgressPolicy(
  config: Pick<
    GatewayConfig,
    'maxConsecutiveToolCalls' | 'maxRepeatedToolCallCount' | 'maxToolResultCharacters'
  >
): ProgressPolicy {
  const maximumTurns = Math.max(1, Math.floor(config.maxConsecutiveToolCalls));
  const thresholds = (family: ToolFamily) => ({
    ...DEFAULT_PROGRESS_POLICY.toolFamilyProgress[family],
    noProgressTurnsBeforeNarrow: Math.max(1, Math.ceil(maximumTurns * 0.25)),
    noProgressTurnsBeforeReplan: Math.max(1, Math.ceil(maximumTurns * 0.5)),
    noProgressTurnsBeforeSummary: Math.max(1, Math.ceil(maximumTurns * 0.75)),
    noProgressTurnsBeforeBlock: maximumTurns,
  });

  return {
    exactRepeatedToolCallLimit: Math.max(
      1,
      Math.floor(config.maxRepeatedToolCallCount)
    ),
    groundedAssistantCharacters: DEFAULT_PROGRESS_POLICY.groundedAssistantCharacters,
    toolResultSummaryCharacters: Math.min(
      config.maxToolResultCharacters,
      DEFAULT_PROGRESS_POLICY.toolResultSummaryCharacters
    ),
    toolFamilyProgress: {
      memory: thresholds('memory'),
      completion: thresholds('completion'),
      editing: thresholds('editing'),
      discovery: thresholds('discovery'),
      execution: thresholds('execution'),
      network: thresholds('network'),
      other: thresholds('other'),
    },
  };
}

export function shouldExposeTools(
  configEnabled: boolean,
  modelToolCalling: boolean | number | undefined
): boolean {
  return configEnabled && Boolean(modelToolCalling);
}

export function assertUsableRequestPlan(params: {
  originalMessageCount: number;
  requestMessageCount: number;
  preservedActiveToolChain: boolean;
  safeMaxOutputTokens: number;
  modelMaxContext: number;
}): void {
  if (
    (params.originalMessageCount > 0 && params.requestMessageCount === 0) ||
    !params.preservedActiveToolChain ||
    params.safeMaxOutputTokens < TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS
  ) {
    throw new Error(
      `The request cannot fit safely in ${params.modelMaxContext} context tokens after reserving ` +
      `the prompt and tool schemas. Reduce the conversation or tool budget, or increase the model context window.`
    );
  }
}

export function calculateWorkingInputTokens(
  maxInputTokens: number,
  maxAgentInputTokens: number,
  hasTools: boolean
): number {
  const limit = hasTools
    ? Math.min(maxInputTokens, maxAgentInputTokens)
    : maxInputTokens;
  return Math.max(0, Math.floor(limit));
}

export type RequestRecoveryStage = 'original' | 'serialized-tools' | 'tool-free-summary';
export type RecoverableFailure =
  | 'empty-response'
  | 'strict-tool-batch'
  | 'tool-format';

export function nextRecoveryStage(
  current: RequestRecoveryStage,
  selectedToolCount: number
): RequestRecoveryStage | undefined {
  if (current === 'original') {
    return selectedToolCount > 0 ? 'serialized-tools' : 'tool-free-summary';
  }
  if (current === 'serialized-tools') {
    return 'tool-free-summary';
  }
  return undefined;
}

export function classifyRecoverableFailure(error: unknown): RecoverableFailure | undefined {
  if (error instanceof ToolCallBatchError) {
    return 'strict-tool-batch';
  }

  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (
    name === 'GatewayPartialStreamError' ||
    name === 'AbortError' ||
    /\b(?:cancelled|canceled|abort(?:ed)?)\b/i.test(message) ||
    /\b(?:401|403)\b|\b(?:unauthori[sz]ed|forbidden|authentication)\b/i.test(message) ||
    /\b(?:fetch failed|econnrefused|enotfound|etimedout|network|socket|tls)\b/i.test(message)
  ) {
    return undefined;
  }

  const knownToolFormatSignal =
    /\bHarmonyError\b/i.test(message) ||
    /\b(?:PEG|grammar)\b.{0,120}\b(?:reject|parse|parser|constraint|invalid|fail|error|tool|function|output)\b/i.test(message) ||
    /\b(?:reject|parse|parser|invalid|malformed|fail|error)\b.{0,120}\b(?:PEG|grammar)\b/i.test(message) ||
    /\b(?:tool|function)[_ -]?(?:call|calling|format)\b.{0,120}\b(?:parse|parser|format|grammar|invalid|malformed|reject|fail|error)\b/i.test(message) ||
    /\b(?:parse|parser|format|grammar|invalid|malformed|reject|fail|error)\b.{0,120}\b(?:tool|function)[_ -]?(?:call|calling|format)\b/i.test(message) ||
    /\b(?:tool|function)[_ -]?(?:arguments?|parameters?)\b.{0,120}\b(?:parse|parser|invalid|malformed|reject|fail|error)\b/i.test(message) ||
    /\b(?:parse|parser|invalid|malformed|reject|fail|error)\b.{0,120}\b(?:tool|function)[_ -]?(?:arguments?|parameters?)\b/i.test(message);
  return knownToolFormatSignal ? 'tool-format' : undefined;
}

/**
 * MIME type VS Code 1.120 watches for on `LanguageModelDataPart`s to extract
 * BYOK / language-model-provider token usage and feed it into the chat
 * context-window widget. See microsoft/vscode#315394.
 */
const USAGE_DATA_PART_MIME_TYPE = 'usage';

/**
 * Lifecycle event the status bar (and any other listener) consumes to render
 * live request state. Exactly one terminal event (`complete` or `error`)
 * follows every `start` event for the same request.
 */
export type RequestStateEvent =
  | { readonly kind: 'start'; readonly modelId: string; readonly modelName: string }
  | {
      readonly kind: 'complete';
      readonly modelId: string;
      readonly modelName: string;
      readonly usage?: TokenUsage;
    }
  | {
      readonly kind: 'error';
      readonly modelId: string;
      readonly modelName: string;
      readonly errorMessage: string;
    };

/**
 * Map a `LanguageModelChatToolMode` enum value to a human-readable label for
 * the output channel. The enum is numeric at runtime, so the raw `${toolMode}`
 * was rendering as `0` / `1` and looked like a stray index.
 */
function describeToolMode(toolMode: vscode.LanguageModelChatToolMode | undefined): string {
  if (toolMode === undefined) { return 'unset'; }
  if (toolMode === vscode.LanguageModelChatToolMode.Required) { return 'required'; }
  if (toolMode === vscode.LanguageModelChatToolMode.Auto) { return 'auto'; }
  return String(toolMode);
}

interface ChatRequestHandlerDeps {
  client: GatewayClient;
  catalog: ModelCatalog;
  getConfig: () => GatewayConfig;
  log: (message: string) => void;
  /** Fired on start / complete / error so the status bar renders live state. */
  onRequestState: (event: RequestStateEvent) => void;
  /** Capture a successful request in the session totals / status dialog. */
  onCompleted: (modelId: string, modelName: string, usage: TokenUsage | undefined) => void;
  /** Opens the extension's output channel (used by error prompts). */
  showOutput: () => void;
}

interface ToolPlan {
  tools: OpenAIToolDefinition[] | undefined;
  schemas: Map<string, Record<string, unknown> | undefined>;
  selectedCount: number;
  droppedCount: number;
  schemaTokens: number;
}

interface AttemptResult {
  empty: boolean;
  inputText: string;
  toolCount: number;
}

interface TrackedProgress {
  readonly reporter: vscode.Progress<vscode.LanguageModelResponsePart>;
  hasReported(): boolean;
}

interface RequestContext {
  readonly model: vscode.LanguageModelChatInformation;
  readonly modelName: string;
  readonly options: vscode.ProvideLanguageModelChatResponseOptions;
  readonly token: vscode.CancellationToken;
  readonly config: GatewayConfig;
  readonly openAIMessages: OpenAIMessage[];
  readonly planningMessages: OpenAIMessage[];
  readonly configuredMaxOutput: number;
  readonly progressPolicy: ProgressPolicy;
  readonly transcriptProgress: ProgressEvaluation;
  readonly toolPlan: ToolPlan;
  readonly trackedProgress: TrackedProgress;
  candidateHistory: OpenAIMessage[];
  capturedUsage?: TokenUsage;
}

interface AttemptPlan {
  readonly toolPlan: ToolPlan;
  readonly hasTools: boolean;
  readonly requestMessages: OpenAIMessage[];
  readonly inputText: string;
  readonly safeMaxOutputTokens: number;
}

interface AttemptPlanDiagnostics {
  readonly stage: RequestRecoveryStage;
  readonly toolPlan: ToolPlan;
  readonly originalMessageCount: number;
  readonly compaction: ReturnType<typeof compactConversationHistory>;
  readonly toolsOverhead: number;
  readonly modelMaxContext: number;
  readonly safeMaxOutputTokens: number;
}

interface RecoveryState {
  stage: RequestRecoveryStage;
  attempts: number;
  contextRetryUsed: boolean;
}

/**
 * Executes one chat request end-to-end: convert VS Code messages to the
 * OpenAI wire format, budget the context window, build and stream the
 * request, and transparently retry once when the server's context-overflow
 * error teaches us the model's real window (issue #55). Before any output is
 * exposed, known tool-format failures also use a bounded two-stage recovery.
 *
 * Stateless between requests — all cross-request knowledge (learned context
 * sizes, cached model data) lives in the {@link ModelCatalog}.
 */
export class ChatRequestHandler {
  constructor(private readonly deps: ChatRequestHandlerDeps) {}

  public async handle(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const modelName = friendlyModelName(model.id);
    this.deps.onRequestState({ kind: 'start', modelId: model.id, modelName });

    try {
      const context = this.createRequestContext(
        model,
        modelName,
        messages,
        options,
        progress,
        token
      );
      await this.runRecoveryLoop(context);
      this.completeRequest(context);
    } catch (error) {
      this.failRequest(model.id, modelName, error);
      handleChatError(error, this.deps.log, this.deps.showOutput);
    }
  }

  private createRequestContext(
    model: vscode.LanguageModelChatInformation,
    modelName: string,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): RequestContext {
    const { log } = this.deps;
    log(`Sending chat request to model: ${model.id}`);
    log(
      `Tool mode: ${describeToolMode(options.toolMode)}, Tools: ${options.tools?.length ?? 0}`
    );
    log(`Message count: ${messages.length}`);

    const config = this.deps.getConfig();
    const openAIMessages = convertAllMessages(
      messages,
      config.enableImageInput,
      log,
      config.maxToolResultCharacters
    );
    log(`Converted to ${openAIMessages.length} OpenAI messages`);
    this.logMessageStructure(openAIMessages);

    const progressPolicy = buildProgressPolicy(config);
    const transcriptProgress = evaluateTranscriptProgress(openAIMessages, progressPolicy);
    return {
      model,
      modelName,
      options,
      token,
      config,
      openAIMessages,
      planningMessages: this.injectProgressInstruction(
        openAIMessages,
        transcriptProgress
      ),
      configuredMaxOutput:
        model.maxOutputTokens || TOKEN_CONSTANTS.DEFAULT_OUTPUT_TOKENS,
      progressPolicy,
      transcriptProgress,
      toolPlan: this.buildToolsConfig(
        config,
        model,
        options,
        openAIMessages,
        transcriptProgress
      ),
      trackedProgress: this.trackProgress(progress),
      candidateHistory: [...openAIMessages],
    };
  }

  private trackProgress(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): TrackedProgress {
    let reported = false;
    return {
      reporter: {
        report: (part) => {
          reported = true;
          progress.report(part);
        },
      },
      hasReported: () => reported,
    };
  }

  private async runRecoveryLoop(context: RequestContext): Promise<void> {
    const state: RecoveryState = {
      stage: 'original',
      attempts: 0,
      contextRetryUsed: false,
    };

    while (state.attempts < MAX_CHAT_ATTEMPTS) {
      state.attempts++;
      let result: AttemptResult;
      try {
        result = await this.executeAttempt(context, state.stage);
      } catch (error) {
        if (this.recoverFromError(context, state, error)) {
          continue;
        }
        throw error;
      }

      if (!result.empty || context.token.isCancellationRequested) {
        return;
      }

      const nextStage = this.safeNextRecoveryStage(context, state.stage);
      if (nextStage && this.canAttemptAgain(state)) {
        this.logRecovery(
          context.config,
          'empty-response',
          state.stage,
          nextStage,
          state.attempts
        );
        state.stage = nextStage;
        continue;
      }

      this.handleEmptyResponse(
        context.model,
        result.inputText,
        context.openAIMessages.length,
        result.toolCount,
        context.trackedProgress.reporter
      );
      return;
    }

    throw new Error('Chat recovery attempt limit was exhausted.');
  }

  private recoverFromError(
    context: RequestContext,
    state: RecoveryState,
    error: unknown
  ): boolean {
    const learnedContext =
      !state.contextRetryUsed &&
      this.deps.catalog.learnContextSizeFromError(context.model, error);
    if (learnedContext && this.canRetry(context, state)) {
      state.contextRetryUsed = true;
      this.deps.log('Retrying chat request with corrected context size...');
      this.logStructuredDiagnostics(context.config, {
        event: 'request-retry',
        retryStage: 'context-overflow',
        attemptStage: state.stage,
        attemptCount: state.attempts,
        visibleOutputReported: false,
      });
      return true;
    }

    const failure = classifyRecoverableFailure(error);
    const nextStage = this.safeNextRecoveryStage(context, state.stage);
    if (!failure || !nextStage || !this.canAttemptAgain(state)) {
      return false;
    }

    this.logRecovery(
      context.config,
      failure,
      state.stage,
      nextStage,
      state.attempts
    );
    state.stage = nextStage;
    return true;
  }

  private canRetry(context: RequestContext, state: RecoveryState): boolean {
    return (
      !context.trackedProgress.hasReported() &&
      !context.token.isCancellationRequested &&
      this.canAttemptAgain(state)
    );
  }

  private canAttemptAgain(state: RecoveryState): boolean {
    return state.attempts < MAX_CHAT_ATTEMPTS;
  }

  private safeNextRecoveryStage(
    context: RequestContext,
    current: RequestRecoveryStage
  ): RequestRecoveryStage | undefined {
    if (
      context.trackedProgress.hasReported() ||
      context.token.isCancellationRequested
    ) {
      return undefined;
    }
    return nextRecoveryStage(current, context.toolPlan.selectedCount);
  }

  private async executeAttempt(
    context: RequestContext,
    stage: RequestRecoveryStage
  ): Promise<AttemptResult> {
    const plan = this.buildAttemptPlan(context, stage);
    const request = this.buildAttemptRequest(context, stage, plan);
    this.logAttemptTools(context, stage, plan);
    this.logRequest(context.config, request);
    const stats = await this.streamAttempt(context, request, plan);

    this.deps.log(
      `Completed chat request, received ${stats.totalContentLength} chars, ${stats.totalTextParts} text parts, ${stats.totalToolCalls} tool calls`
    );
    return {
      empty: isEmptyStreamResult(stats),
      inputText: plan.inputText,
      toolCount: plan.toolPlan.selectedCount,
    };
  }

  private buildAttemptPlan(
    context: RequestContext,
    stage: RequestRecoveryStage
  ): AttemptPlan {
    const toolPlan = this.toolPlanForStage(context, stage);
    const hasTools = this.hasTools(toolPlan);
    const attemptMessages = this.messagesForStage(context.planningMessages, stage);
    const toolsSerializedLength = toolPlan.tools
      ? JSON.stringify(toolPlan.tools).length
      : 0;
    const modelMaxContext = this.deps.catalog.resolveModelMaxContext(context.model);
    const maxInputTokens = calculateMaxInputTokens({
      modelMaxContext,
      configuredMaxOutput: context.configuredMaxOutput,
      toolsSerializedLength,
    });
    const workingInputTokens = calculateWorkingInputTokens(
      maxInputTokens,
      context.config.maxAgentInputTokens,
      hasTools
    );
    const compaction = compactConversationHistory({
      messages: attemptMessages,
      maxInputTokens: workingInputTokens,
      policy: COMPACTION_POLICY,
    });
    const toolsOverhead = Math.ceil(
      toolsSerializedLength / TOKEN_CONSTANTS.CHARS_PER_TOKEN
    );
    const safeMaxOutputTokens = calculateSafeMaxOutputTokens({
      estimatedInputTokens: compaction.estimatedInputTokens,
      toolsOverhead,
      modelMaxContext,
      configuredMaxOutput: context.configuredMaxOutput,
    });
    assertUsableRequestPlan({
      originalMessageCount: attemptMessages.length,
      requestMessageCount: compaction.messages.length,
      preservedActiveToolChain: compaction.preservedActiveToolChain,
      safeMaxOutputTokens,
      modelMaxContext,
    });
    this.logAttemptPlan(context, {
      stage,
      toolPlan,
      originalMessageCount: attemptMessages.length,
      compaction,
      toolsOverhead,
      modelMaxContext,
      safeMaxOutputTokens,
    });
    return {
      toolPlan,
      hasTools,
      requestMessages: compaction.messages,
      inputText: buildInputText(compaction.messages),
      safeMaxOutputTokens,
    };
  }

  private toolPlanForStage(
    context: RequestContext,
    stage: RequestRecoveryStage
  ): ToolPlan {
    if (stage === 'tool-free-summary') {
      return this.emptyToolPlan(context.options.tools?.length ?? 0);
    }
    return context.toolPlan;
  }

  private messagesForStage(
    planningMessages: OpenAIMessage[],
    stage: RequestRecoveryStage
  ): OpenAIMessage[] {
    if (stage !== 'tool-free-summary') {
      return planningMessages;
    }
    return [
      { role: 'system', content: TOOL_FREE_RECOVERY_INSTRUCTION },
      ...planningMessages,
    ];
  }

  private hasTools(toolPlan: ToolPlan): boolean {
    return Boolean(toolPlan.tools && toolPlan.tools.length > 0);
  }

  private logAttemptPlan(
    context: RequestContext,
    diagnostics: AttemptPlanDiagnostics
  ): void {
    this.deps.log(
      `Token estimate: input=${diagnostics.compaction.estimatedInputTokens}, tools=${diagnostics.toolsOverhead}, model_context=${diagnostics.modelMaxContext}, chosen_max_tokens=${diagnostics.safeMaxOutputTokens}`
    );
    this.logStructuredDiagnostics(context.config, {
      event: 'request-plan',
      attemptStage: diagnostics.stage,
      selectedToolCount: diagnostics.toolPlan.selectedCount,
      droppedToolCount: diagnostics.toolPlan.droppedCount,
      selectedToolSchemaTokens: diagnostics.toolPlan.schemaTokens,
      toolSchemaTokenBudget: context.config.maxToolSchemaTokens,
      originalMessageCount: diagnostics.originalMessageCount,
      requestMessageCount: diagnostics.compaction.messages.length,
      droppedMessageCount: diagnostics.compaction.droppedMessageCount,
      compacted: diagnostics.compaction.wasCompacted,
      taskAnchorApplied: diagnostics.compaction.taskAnchorApplied,
      archivedSummaryApplied: diagnostics.compaction.archivedSummaryApplied,
      preservedActiveToolChain: diagnostics.compaction.preservedActiveToolChain,
      progressStage: context.transcriptProgress.stage,
      progressScore: context.transcriptProgress.score,
      progressReasons: context.transcriptProgress.reasons.slice(0, 3),
    });
  }

  private buildAttemptRequest(
    context: RequestContext,
    stage: RequestRecoveryStage,
    plan: AttemptPlan
  ): OpenAIChatCompletionRequest {
    const perModel = resolvePerModelOptions(
      context.model.id,
      context.config.perModelOptions
    );
    const discovered = this.deps.catalog.getDiscoveredParams(context.model.id);
    const temperature = this.resolveTemperature(
      context,
      plan.hasTools,
      perModel,
      discovered
    );
    return buildChatRequest({
      model: context.model.id,
      messages: plan.requestMessages,
      maxTokens: plan.safeMaxOutputTokens,
      temperature,
      tools: plan.toolPlan.tools,
      toolChoice: this.resolveToolChoice(
        plan.hasTools,
        stage,
        context.options.toolMode
      ),
      parallelToolCalls: this.resolveParallelToolCalls(
        plan.hasTools,
        stage,
        context.config.parallelToolCalling
      ),
      extraOptions: {
        ...discoveredSamplerOptions(discovered),
        ...context.config.extraModelOptions,
        ...perModel,
        ...context.options.modelOptions,
      },
    });
  }

  private resolveTemperature(
    context: RequestContext,
    hasTools: boolean,
    perModel: Readonly<Record<string, unknown>>,
    discovered: Readonly<Record<string, number>> | undefined
  ): number {
    const configured =
      pickNumber(context.options.modelOptions?.temperature) ??
      pickNumber(perModel.temperature) ??
      pickNumber(context.config.extraModelOptions?.temperature);
    const fallback = hasTools ? context.config.agentTemperature : DEFAULT_TEMPERATURE;
    return configured ?? pickNumber(discovered?.temperature) ?? fallback;
  }

  private resolveToolChoice(
    hasTools: boolean,
    stage: RequestRecoveryStage,
    toolMode: vscode.LanguageModelChatToolMode | undefined
  ): ToolChoice | undefined {
    if (!hasTools) {
      return undefined;
    }
    if (stage === 'serialized-tools') {
      return 'auto';
    }
    return this.mapToolChoice(toolMode);
  }

  private resolveParallelToolCalls(
    hasTools: boolean,
    stage: RequestRecoveryStage,
    configured: boolean
  ): boolean | undefined {
    if (!hasTools) {
      return undefined;
    }
    return stage === 'serialized-tools' ? false : configured;
  }

  private logAttemptTools(
    context: RequestContext,
    stage: RequestRecoveryStage,
    plan: AttemptPlan
  ): void {
    if (!plan.hasTools) {
      return;
    }
    const parallel = this.resolveParallelToolCalls(
      true,
      stage,
      context.config.parallelToolCalling
    );
    this.deps.log(
      `Sending ${plan.toolPlan.selectedCount} tools to model (parallel: ${parallel})`
    );
  }

  private async streamAttempt(
    context: RequestContext,
    request: OpenAIChatCompletionRequest,
    plan: AttemptPlan
  ): Promise<Awaited<ReturnType<typeof streamResponse>>> {
    const reporter = this.createStreamReporter(
      context.trackedProgress.reporter,
      (usage) => {
        context.capturedUsage = usage;
      }
    );
    const chunks = this.deps.client.streamChatCompletion(request, context.token);
    return streamResponse({
      chunks: chunks as AsyncIterable<StreamChunk>,
      reporter,
      isCancelled: () => context.token.isCancellationRequested,
      prepareToolCallBatch: (toolCalls) =>
        this.prepareStreamToolBatch(context, plan, toolCalls),
    });
  }

  private prepareStreamToolBatch(
    context: RequestContext,
    plan: AttemptPlan,
    toolCalls: readonly ToolCallArguments[]
  ): PreparedToolCallBatch {
    const prepared = this.prepareCandidateToolBatch(
      toolCalls,
      plan.toolPlan.schemas,
      context.candidateHistory,
      context.progressPolicy,
      context.config
    );
    if (prepared.calls) {
      context.candidateHistory = [
        ...context.candidateHistory,
        this.asAssistantToolCallMessage(toolCalls),
      ];
    }
    return prepared;
  }

  private completeRequest(context: RequestContext): void {
    this.deps.onCompleted(
      context.model.id,
      context.modelName,
      context.capturedUsage
    );
    this.deps.onRequestState({
      kind: 'complete',
      modelId: context.model.id,
      modelName: context.modelName,
      usage: context.capturedUsage,
    });
  }

  private failRequest(modelId: string, modelName: string, error: unknown): void {
    this.deps.onRequestState({
      kind: 'error',
      modelId,
      modelName,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  // ---------- tool config + stream adapters ----------

  private mapToolChoice(toolMode: vscode.LanguageModelChatToolMode | undefined): ToolChoice | undefined {
    switch (toolMode) {
      case vscode.LanguageModelChatToolMode.Required:
        return 'required';
      case vscode.LanguageModelChatToolMode.Auto:
        return 'auto';
      default:
        return undefined;
    }
  }

  private emptyToolPlan(droppedCount: number): ToolPlan {
    return {
      tools: undefined,
      schemas: new Map(),
      selectedCount: 0,
      droppedCount,
      schemaTokens: 0,
    };
  }

  private buildToolsConfig(
    config: GatewayConfig,
    model: vscode.LanguageModelChatInformation,
    options: vscode.ProvideLanguageModelChatResponseOptions,
    messages: readonly OpenAIMessage[],
    progress: ProgressEvaluation
  ): ToolPlan {
    const schemas = new Map<string, Record<string, unknown> | undefined>();
    const exposeTools = shouldExposeTools(
      config.enableToolCalling,
      model.capabilities?.toolCalling
    );
    if (
      !exposeTools ||
      progress.forceSummary ||
      !options.tools ||
      options.tools.length === 0
    ) {
      return {
        tools: undefined,
        schemas,
        selectedCount: 0,
        droppedCount: options.tools?.length ?? 0,
        schemaTokens: 0,
      };
    }

    const selected = selectToolsForRequest({
      tools: options.tools,
      maxTools: config.maxToolsPerRequest,
      messages,
      pinnedToolNames: config.pinnedTools,
      progress,
    });
    const toDefinition = (
      tool: (NonNullable<typeof options.tools>)[number]
    ): OpenAIToolDefinition => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      });
    const schemaBudget = limitToolsBySchemaTokenBudget(
      selected.items,
      config.maxToolSchemaTokens,
      toDefinition
    );
    const tools = schemaBudget.items.map((tool) => {
      schemas.set(
        tool.name,
        tool.inputSchema as Record<string, unknown> | undefined
      );
      return toDefinition(tool);
    });

    return {
      tools: tools.length > 0 ? tools : undefined,
      schemas,
      selectedCount: tools.length,
      droppedCount: options.tools.length - tools.length,
      schemaTokens: tools.length > 0 ? schemaBudget.serializedTokens : 0,
    };
  }

  private injectProgressInstruction(
    messages: readonly OpenAIMessage[],
    progress: ProgressEvaluation
  ): OpenAIMessage[] {
    if (progress.forceSummary) {
      return [
        ...messages,
        { role: 'system', content: buildForcedSummaryInstruction(progress) },
      ];
    }
    if (progress.injectReplan) {
      return [
        ...messages,
        { role: 'system', content: buildReplanInstruction(progress) },
      ];
    }
    return [...messages];
  }

  private prepareCandidateToolBatch(
    toolCalls: readonly ToolCallArguments[],
    schemas: ReadonlyMap<string, Record<string, unknown> | undefined>,
    messages: readonly OpenAIMessage[],
    policy: ProgressPolicy,
    config: GatewayConfig
  ): PreparedToolCallBatch {
    const prepared = prepareToolCallBatch(toolCalls, schemas);
    if (prepared.error) {
      this.deps.log(
        `Rejected tool batch: ${prepared.error.reason}. No tool calls were reported.`
      );
      return prepared;
    }

    const candidateProgress = evaluateCandidateToolBatchProgress(
      messages,
      policy,
      toolCalls
    );
    this.logStructuredDiagnostics(config, {
      event: 'tool-batch',
      toolCallCount: toolCalls.length,
      progressStage: candidateProgress.stage,
      progressScore: candidateProgress.score,
      repeatedToolCallCount: candidateProgress.repeatedToolCallCount,
      noProgressToolCallTurns: candidateProgress.noProgressToolCallTurns,
      progressReasons: candidateProgress.reasons.slice(0, 3),
    });
    if (candidateProgress.shouldBlock) {
      return {
        error: {
          toolCall: toolCalls[0],
          reason:
            candidateProgress.reasons[0] ??
            'the candidate tool batch exceeded the no-progress policy',
        },
      };
    }

    this.deps.log(`Validated tool batch with ${prepared.calls.length} call(s).`);
    return prepared;
  }

  private asAssistantToolCallMessage(
    toolCalls: readonly ToolCallArguments[]
  ): OpenAIMessage {
    return {
      role: 'assistant',
      content: null,
      tool_calls: toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      })),
    };
  }

  private createStreamReporter(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    onUsage?: (usage: TokenUsage) => void
  ): StreamReporter {
    return {
      reportText: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
      reportThinking: (text) => progress.report(new vscode.LanguageModelThinkingPart(text)),
      reportThinkingDone: () =>
        progress.report(new vscode.LanguageModelThinkingPart('', '', { vscode_reasoning_done: true })),
      reportToolCall: (id, name, args) =>
        progress.report(new vscode.LanguageModelToolCallPart(id, name, args)),
      reportUsage: (usage) => {
        // VS Code 1.120 picks up token usage emitted as a LanguageModelDataPart
        // with the literal mime type `usage` (see microsoft/vscode#315394).
        // The shape mirrors OpenAI's `usage` object. Surfacing it here makes
        // the chat view's context-window widget render real numbers instead
        // of `0%` for gateway models (issue #24).
        this.deps.log(
          `Usage: prompt=${usage.prompt_tokens}, completion=${usage.completion_tokens}, total=${usage.total_tokens}`
        );
        onUsage?.({
          prompt: usage.prompt_tokens,
          completion: usage.completion_tokens,
          total: usage.total_tokens,
        });
        const payload = new TextEncoder().encode(JSON.stringify(usage));
        progress.report(new vscode.LanguageModelDataPart(payload, USAGE_DATA_PART_MIME_TYPE));
      },
    };
  }

  // ---------- logging / error helpers ----------

  private logStructuredDiagnostics(
    config: GatewayConfig,
    metrics: Record<string, unknown>
  ): void {
    if (!config.verboseDiagnostics) { return; }
    const reasons = Array.isArray(metrics.progressReasons)
      ? metrics.progressReasons
          .filter((reason): reason is string => typeof reason === 'string')
          .slice(0, 3)
          .map((reason) => reason.slice(0, 160))
      : undefined;
    this.deps.log(
      `Request diagnostics: ${JSON.stringify({
        ...metrics,
        ...(reasons ? { progressReasons: reasons } : {}),
      })}`
    );
  }

  private logRecovery(
    config: GatewayConfig,
    failure: RecoverableFailure,
    from: RequestRecoveryStage,
    to: RequestRecoveryStage,
    attemptCount: number
  ): void {
    this.deps.log(`Retrying chat request with recovery stage: ${to}.`);
    this.logStructuredDiagnostics(config, {
      event: 'request-retry',
      retryTrigger: failure,
      previousStage: from,
      retryStage: to,
      attemptCount,
      visibleOutputReported: false,
    });
  }

  private logMessageStructure(openAIMessages: readonly OpenAIMessage[]): void {
    for (let i = 0; i < openAIMessages.length; i++) {
      const msg = openAIMessages[i];
      const toolCallId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : 'none';
      let hasContent: boolean;
      if (typeof msg.content === 'string') {
        hasContent = msg.content.length > 0;
      } else if (Array.isArray(msg.content)) {
        hasContent = msg.content.length > 0;
      } else {
        hasContent = msg.content !== null && msg.content !== undefined;
      }
      const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      this.deps.log(
        `  Message ${i + 1}: role=${msg.role}, hasContent=${hasContent}, hasToolCalls=${hasToolCalls}, toolCallId=${toolCallId}`
      );
    }
  }

  private logRequest(config: GatewayConfig, request: OpenAIChatCompletionRequest): void {
    if (!config.verboseLogging) {
      // By default log only the non-content envelope so user conversation
      // data (file contents, tool args, credentials pasted into chat) is
      // not captured in logs they may share for support.
      const toolCount = Array.isArray(request.tools) ? request.tools.length : 0;
      this.deps.log(
        `Request: model=${request.model}, messages=${request.messages.length}, tools=${toolCount}, max_tokens=${request.max_tokens}, temperature=${request.temperature}`
      );
      return;
    }
    const debugRequest = JSON.stringify(request, null, 2);
    this.deps.log(
      debugRequest.length > DEBUG_REQUEST_MAX_LOG_LENGTH
        ? `Request (truncated): ${debugRequest.substring(0, DEBUG_REQUEST_MAX_LOG_LENGTH)}...`
        : `Request: ${debugRequest}`
    );
  }

  private handleEmptyResponse(
    model: vscode.LanguageModelChatInformation,
    inputText: string,
    messageCount: number,
    toolCount: number,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): void {
    const { log } = this.deps;
    const inputTokenCount = estimateTextTokens(inputText);
    const modelMaxContext = this.deps.catalog.resolveModelMaxContext(model);

    log(`WARNING: Model returned empty response with no tool calls.`);
    log(`  Input tokens estimated: ${inputTokenCount}`);
    log(`  Messages in conversation: ${messageCount}`);
    log(`  Tools provided: ${toolCount}`);

    const errorHint =
      toolCount > 0
        ? `The model returned an empty response. This typically indicates the model failed to generate valid output with tool calling enabled. Check the inference server logs for errors.`
        : `The model returned an empty response. Check the inference server logs for details.`;

    log(`  Issue: ${errorHint}`);

    const errorMessage =
      `I was unable to generate a response. ${errorHint}\n\n` +
      `Diagnostic info:\n- Model: ${model.id}\n- Tools provided: ${toolCount}\n` +
      `- Estimated input tokens: ${inputTokenCount}\n- Context limit: ${modelMaxContext}\n\n` +
      `Check the "GitHub Copilot LLM Gateway" output panel for detailed logs.`;

    progress.report(new vscode.LanguageModelTextPart(errorMessage));
  }
}
