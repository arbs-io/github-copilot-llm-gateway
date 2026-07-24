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
    const { log, catalog } = this.deps;
    log(`Sending chat request to model: ${model.id}`);
    log(
      `Tool mode: ${describeToolMode(options.toolMode)}, Tools: ${options.tools?.length ?? 0}`
    );
    log(`Message count: ${messages.length}`);

    const modelName = friendlyModelName(model.id);
    this.deps.onRequestState({ kind: 'start', modelId: model.id, modelName });

    const config = this.deps.getConfig();
    const openAIMessages = convertAllMessages(
      messages,
      config.enableImageInput,
      log,
      config.maxToolResultCharacters
    );
    log(`Converted to ${openAIMessages.length} OpenAI messages`);
    this.logMessageStructure(openAIMessages);

    const configuredMaxOutput =
      model.maxOutputTokens || TOKEN_CONSTANTS.DEFAULT_OUTPUT_TOKENS;
    const progressPolicy = buildProgressPolicy(config);
    const transcriptProgress = evaluateTranscriptProgress(openAIMessages, progressPolicy);
    const planningMessages = this.injectProgressInstruction(
      openAIMessages,
      transcriptProgress
    );
    const toolPlan = this.buildToolsConfig(
      config,
      model,
      options,
      openAIMessages,
      transcriptProgress
    );

    // Once anything has been streamed to the chat view we can no longer
    // transparently re-issue the request without duplicating output, so track
    // whether the wrapped progress ever fired.
    let partsReported = false;
    const trackingProgress: vscode.Progress<vscode.LanguageModelResponsePart> = {
      report: (part) => {
        partsReported = true;
        progress.report(part);
      },
    };

    let capturedUsage: TokenUsage | undefined;
    let candidateHistory = [...openAIMessages];

    // The whole budget → request → stream pipeline, resolved against the
    // model's current context size, so a corrected context can re-run it.
    const attempt = async (stage: RequestRecoveryStage): Promise<AttemptResult> => {
      const useTools = stage !== 'tool-free-summary';
      const attemptToolPlan = useTools
        ? toolPlan
        : this.emptyToolPlan(options.tools?.length ?? 0);
      const hasTools =
        attemptToolPlan.tools !== undefined && attemptToolPlan.tools.length > 0;
      const attemptMessages =
        stage === 'tool-free-summary'
          ? [
              { role: 'system', content: TOOL_FREE_RECOVERY_INSTRUCTION } as OpenAIMessage,
              ...planningMessages,
            ]
          : planningMessages;
      const toolsSerializedLength = attemptToolPlan.tools
        ? JSON.stringify(attemptToolPlan.tools).length
        : 0;
      const modelMaxContext = catalog.resolveModelMaxContext(model);
      const maxInputTokens = calculateMaxInputTokens({
        modelMaxContext,
        configuredMaxOutput,
        toolsSerializedLength,
      });
      const workingInputTokens = calculateWorkingInputTokens(
        maxInputTokens,
        config.maxAgentInputTokens,
        hasTools
      );
      const compaction = compactConversationHistory({
        messages: attemptMessages,
        maxInputTokens: workingInputTokens,
        policy: COMPACTION_POLICY,
      });
      const requestMessages = compaction.messages;
      const inputText = buildInputText(requestMessages);
      const toolsOverhead = Math.ceil(toolsSerializedLength / TOKEN_CONSTANTS.CHARS_PER_TOKEN);
      const estimatedInputTokens = compaction.estimatedInputTokens;
      const safeMaxOutputTokens = calculateSafeMaxOutputTokens({
        estimatedInputTokens,
        toolsOverhead,
        modelMaxContext,
        configuredMaxOutput,
      });
      assertUsableRequestPlan({
        originalMessageCount: attemptMessages.length,
        requestMessageCount: requestMessages.length,
        preservedActiveToolChain: compaction.preservedActiveToolChain,
        safeMaxOutputTokens,
        modelMaxContext,
      });

      log(
        `Token estimate: input=${estimatedInputTokens}, tools=${toolsOverhead}, model_context=${modelMaxContext}, chosen_max_tokens=${safeMaxOutputTokens}`
      );

      this.logStructuredDiagnostics(config, {
        event: 'request-plan',
        attemptStage: stage,
        selectedToolCount: attemptToolPlan.selectedCount,
        droppedToolCount: attemptToolPlan.droppedCount,
        selectedToolSchemaTokens: attemptToolPlan.schemaTokens,
        toolSchemaTokenBudget: config.maxToolSchemaTokens,
        originalMessageCount: attemptMessages.length,
        requestMessageCount: requestMessages.length,
        droppedMessageCount: compaction.droppedMessageCount,
        compacted: compaction.wasCompacted,
        taskAnchorApplied: compaction.taskAnchorApplied,
        archivedSummaryApplied: compaction.archivedSummaryApplied,
        preservedActiveToolChain: compaction.preservedActiveToolChain,
        progressStage: transcriptProgress.stage,
        progressScore: transcriptProgress.score,
        progressReasons: transcriptProgress.reasons.slice(0, 3),
      });

      // Sampler resolution, precedence high -> low:
      //   caller modelOptions > perModelOptions > extraModelOptions >
      //   backend-discovered params (e.g. Ollama Modelfile via /api/show) >
      //   agentTemperature / DEFAULT_TEMPERATURE fallback.
      // agentTemperature was previously applied unconditionally because
      // backend params were never discovered; it is now a genuine last-resort
      // fallback. Forwarding the discovered top_p also stops Ollama's OpenAI
      // endpoint defaulting an omitted top_p to 1.0.
      const perModel = resolvePerModelOptions(model.id, config.perModelOptions);
      const discovered = catalog.getDiscoveredParams(model.id);

      const configuredTemperature =
        pickNumber(options.modelOptions?.temperature) ??
        pickNumber(perModel.temperature) ??
        pickNumber(config.extraModelOptions?.temperature);
      const temperature =
        configuredTemperature ??
        pickNumber(discovered?.temperature) ??
        (hasTools ? config.agentTemperature : DEFAULT_TEMPERATURE);

      const requestOptions = buildChatRequest({
        model: model.id,
        messages: requestMessages,
        maxTokens: safeMaxOutputTokens,
        temperature,
        tools: attemptToolPlan.tools,
        toolChoice: hasTools
          ? stage === 'serialized-tools'
            ? 'auto'
            : this.mapToolChoice(options.toolMode)
          : undefined,
        parallelToolCalls: hasTools
          ? stage === 'serialized-tools'
            ? false
            : config.parallelToolCalling
          : undefined,
        extraOptions: {
          ...discoveredSamplerOptions(discovered),
          ...config.extraModelOptions,
          ...perModel,
          ...options.modelOptions,
        },
      });

      if (hasTools) {
        const parallelToolCalls =
          stage === 'serialized-tools' ? false : config.parallelToolCalling;
        log(
          `Sending ${attemptToolPlan.selectedCount} tools to model (parallel: ${parallelToolCalls})`
        );
      }

      this.logRequest(config, requestOptions);

      const reporter = this.createStreamReporter(trackingProgress, (usage) => {
        capturedUsage = usage;
      });
      const chunks = this.deps.client.streamChatCompletion(requestOptions, token);
      const stats = await streamResponse({
        chunks: chunks as AsyncIterable<StreamChunk>,
        reporter,
        isCancelled: () => token.isCancellationRequested,
        prepareToolCallBatch: (toolCalls) => {
          const prepared = this.prepareCandidateToolBatch(
            toolCalls,
            attemptToolPlan.schemas,
            candidateHistory,
            progressPolicy,
            config
          );
          if (prepared.calls) {
            candidateHistory = [
              ...candidateHistory,
              this.asAssistantToolCallMessage(toolCalls),
            ];
          }
          return prepared;
        },
      });

      log(
        `Completed chat request, received ${stats.totalContentLength} chars, ${stats.totalTextParts} text parts, ${stats.totalToolCalls} tool calls`
      );

      return {
        empty: isEmptyStreamResult(stats),
        inputText,
        toolCount: attemptToolPlan.selectedCount,
      };
    };

    try {
      let stage: RequestRecoveryStage = 'original';
      let contextRetryUsed = false;
      let attempts = 0;
      let complete = false;

      while (!complete && attempts < MAX_CHAT_ATTEMPTS) {
        attempts++;
        try {
          const result = await attempt(stage);
          if (!result.empty || token.isCancellationRequested) {
            complete = true;
            continue;
          }

          const nextStage: RequestRecoveryStage | undefined =
            partsReported ? undefined : nextRecoveryStage(stage, toolPlan.selectedCount);
          if (nextStage && attempts < MAX_CHAT_ATTEMPTS) {
            this.logRecovery(config, 'empty-response', stage, nextStage, attempts);
            stage = nextStage;
            continue;
          }

          this.handleEmptyResponse(
            model,
            result.inputText,
            openAIMessages.length,
            result.toolCount,
            trackingProgress
          );
          complete = true;
        } catch (error) {
          // Context-overflow errors carry the server's real context size
          // (issue #55: llama-server router mode reports nothing up-front).
          // Preserve the learned limit even when visible output prevents a
          // retry, but retry at most once across the recovery sequence.
          const learnedContext =
            !contextRetryUsed && catalog.learnContextSizeFromError(model, error);
          if (
            learnedContext &&
            !partsReported &&
            !token.isCancellationRequested &&
            attempts < MAX_CHAT_ATTEMPTS
          ) {
            contextRetryUsed = true;
            log('Retrying chat request with corrected context size...');
            this.logStructuredDiagnostics(config, {
              event: 'request-retry',
              retryStage: 'context-overflow',
              attemptStage: stage,
              attemptCount: attempts,
              visibleOutputReported: false,
            });
            continue;
          }

          const failure = classifyRecoverableFailure(error);
          const nextStage: RequestRecoveryStage | undefined =
            failure && !partsReported && !token.isCancellationRequested
              ? nextRecoveryStage(stage, toolPlan.selectedCount)
              : undefined;
          if (failure && nextStage && attempts < MAX_CHAT_ATTEMPTS) {
            this.logRecovery(config, failure, stage, nextStage, attempts);
            stage = nextStage;
            continue;
          }
          throw error;
        }
      }

      if (!complete) {
        throw new Error('Chat recovery attempt limit was exhausted.');
      }
      this.deps.onCompleted(model.id, modelName, capturedUsage);
      this.deps.onRequestState({
        kind: 'complete',
        modelId: model.id,
        modelName,
        usage: capturedUsage,
      });
    } catch (error) {
      this.deps.onRequestState({
        kind: 'error',
        modelId: model.id,
        modelName,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      handleChatError(error, log, this.deps.showOutput);
    }
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
