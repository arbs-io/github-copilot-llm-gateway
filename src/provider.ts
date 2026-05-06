import * as vscode from 'vscode';
import { GatewayClient } from './client';
import { GatewayConfig, OpenAIChatCompletionRequest, OpenAIMessage } from './types';
import {
  convertMessage,
  NormalizedMessage,
  NormalizedPart,
  NormalizedRole,
} from './messageConverter';
import {
  TOKEN_CONSTANTS,
  buildInputText,
  calculateMaxInputTokens,
  calculateSafeMaxOutputTokens,
  estimateTextTokens,
  truncateMessagesToFit,
} from './tokenBudget';
import { tryRepairJson } from './jsonRepair';
import { fillMissingRequiredProperties } from './toolSchema';
import { buildChatRequest, OpenAIToolDefinition, ToolChoice } from './requestBuilder';
import {
  StreamChunk,
  StreamReporter,
  isEmptyStreamResult,
  streamResponse,
} from './responseStreamer';
import {
  dedupeModels,
  describeModel,
  friendlyModelName,
  inferModelFamily,
} from './modelDisplay';
import { diagnoseModelFetchError } from './errorDiagnostics';

const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
const DEFAULT_TEMPERATURE = 0.7;
const DEBUG_REQUEST_MAX_LOG_LENGTH = 2000;
const MAX_TOOL_ARGS_LOG_LENGTH = 1000;
const MAX_TOOL_DESCRIPTION_LOG_LENGTH = 100;

/**
 * Format a tool's description for the output channel: trim, truncate at
 * MAX_TOOL_DESCRIPTION_LOG_LENGTH characters, and only append `...` when an
 * actual truncation happened. Returns `'(none)'` when the tool didn't supply
 * a description at all.
 */
function formatToolDescription(description: string | undefined): string {
  if (!description) { return '(none)'; }
  if (description.length <= MAX_TOOL_DESCRIPTION_LOG_LENGTH) { return description; }
  return `${description.substring(0, MAX_TOOL_DESCRIPTION_LOG_LENGTH)}...`;
}

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

/**
 * Setting keys that change the shape of the model list returned from the
 * server (and so require VS Code to re-request it). Other keys like
 * `agentTemperature` don't, so we don't want to fire the change event for
 * them — otherwise every keystroke in the settings UI triggers a re-fetch.
 */
const MODEL_AFFECTING_KEYS: readonly string[] = [
  'github.copilot.llm-gateway.serverUrl',
  'github.copilot.llm-gateway.apiKey',
  'github.copilot.llm-gateway.requestTimeout',
  'github.copilot.llm-gateway.defaultMaxTokens',
  'github.copilot.llm-gateway.defaultMaxOutputTokens',
  'github.copilot.llm-gateway.enableImageInput',
  'github.copilot.llm-gateway.enableToolCalling',
  'github.copilot.llm-gateway.customHeaders',
];

/**
 * Language model provider for OpenAI-compatible inference servers.
 *
 * This class is the VS Code surface area; most of the logic lives in focused
 * pure modules (messageConverter, tokenBudget, responseStreamer, etc.) which
 * are unit-tested independently.
 */
export class GatewayProvider implements vscode.LanguageModelChatProvider {
  private readonly client: GatewayClient;
  private config: GatewayConfig;
  private readonly outputChannel: vscode.OutputChannel;
  /**
   * Real server-reported context per model id (`max_model_len` / etc.).
   * Needed because the picker-facing `maxInputTokens` is the full context
   * on purpose — the chat-response code path needs the separate true value
   * so it doesn't double-count when budgeting output tokens.
   */
  private readonly contextByModelId: Map<string, number> = new Map();
  /**
   * In-flight model-fetch promise + its completion timestamp. Shared between
   * `provideLanguageModelChatInformation` (called by VS Code's picker) and
   * the status-bar probe, so rapid-fire calls don't stack HTTP requests
   * against the inference server.
   */
  private modelFetchInFlight?: Promise<vscode.LanguageModelChatInformation[]>;
  private modelFetchLast?: { at: number; result: vscode.LanguageModelChatInformation[] };
  private hasShownWelcomeNotification = false;
  /** Tracks the last values we warned about, to avoid notification spam on each keystroke in the settings UI. */
  private lastInvalidUrlNotified?: string;
  private lastOutputTokenAdjustmentNotified?: { output: number; total: number };

  private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

  constructor(context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('GitHub Copilot LLM Gateway');
    this.config = this.loadConfig();
    this.client = new GatewayClient(this.config, (msg) => this.outputChannel.appendLine(msg));

    context.subscriptions.push(
      this.outputChannel,
      this._onDidChangeLanguageModelChatInformation,
      vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
        if (!e.affectsConfiguration('github.copilot.llm-gateway')) {
          return;
        }
        this.outputChannel.appendLine('Configuration changed, reloading...');
        this.reloadConfig();
        // Only nudge VS Code to refetch models when a setting that actually
        // affects the model list has changed.
        const affectsModels = MODEL_AFFECTING_KEYS.some((key) => e.affectsConfiguration(key));
        if (affectsModels) {
          this._onDidChangeLanguageModelChatInformation.fire();
        }
      })
    );
  }

  /**
   * Force a refresh of the language model list. Called from the
   * `Refresh Models` command so users can re-probe the server without
   * editing settings.
   */
  public refreshModels(): void {
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  /**
   * Invalidate the in-memory model-fetch cache so the next call re-probes
   * the server. Called from the `Refresh Models` command.
   */
  public invalidateModelCache(): void {
    this.modelFetchLast = undefined;
  }

  /**
   * Provide language model information - fetches available models from
   * inference server. Multiple concurrent callers share a single HTTP
   * request; successful results are cached for a short window so the picker
   * and the status bar don't double-probe.
   */
  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const outcome = await this.getOrFetchModels(token);
    if (!options.silent && outcome.error) {
      this.promptOpenSettings(
        `GitHub Copilot LLM Gateway: Failed to fetch models. ${diagnoseModelFetchError(outcome.error)}`
      );
    }
    return outcome.models;
  }

  /**
   * Underlying model-fetch with cache + single-flight dedup. Never shows any
   * UI itself — that decision belongs to the caller based on its `silent` flag.
   */
  private async getOrFetchModels(
    token: vscode.CancellationToken
  ): Promise<{ models: vscode.LanguageModelChatInformation[]; error?: string }> {
    const now = Date.now();
    const cacheTtlMs = 1000;
    if (this.modelFetchLast && now - this.modelFetchLast.at < cacheTtlMs) {
      return { models: this.modelFetchLast.result };
    }
    if (this.modelFetchInFlight) {
      try {
        return { models: await this.modelFetchInFlight };
      } catch (error) {
        return { models: [], error: error instanceof Error ? error.message : String(error) };
      }
    }

    const inFlight = this.doFetchModels(token);
    this.modelFetchInFlight = inFlight;
    try {
      const result = await inFlight;
      // Don't poison the cache with cancelled-empty results — the next caller
      // should re-probe instead of seeing a stale empty list.
      if (!token.isCancellationRequested) {
        this.modelFetchLast = { at: Date.now(), result };
      }
      return { models: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { models: [], error: message };
    } finally {
      if (this.modelFetchInFlight === inFlight) {
        this.modelFetchInFlight = undefined;
      }
    }
  }

  private async doFetchModels(
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    this.outputChannel.appendLine('Fetching models from inference server...');
    let response;
    try {
      response = await this.client.fetchModels(token);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.outputChannel.appendLine(`ERROR: Failed to fetch models: ${errorMessage}`);
      throw error;
    }

    if (token.isCancellationRequested) {
      return [];
    }

    const uniqueModels = dedupeModels(response.data);
    if (uniqueModels.length !== response.data.length) {
      this.outputChannel.appendLine(
        `Server returned ${response.data.length} models, ${uniqueModels.length} unique after dedupe`
      );
    }

    // Rebuild the per-id context map from the latest fetch. If the server
    // removed a model, drop its entry so stale data can't leak into future
    // chat requests.
    this.contextByModelId.clear();

    const models = uniqueModels.map((model) => {
      const serverContext = model.max_model_len ?? model.context_length ?? model.context_window;
      const totalContext = serverContext ?? this.config.defaultMaxTokens;
      this.contextByModelId.set(model.id, totalContext);
      const maxOutputTokens = Math.min(
        this.config.defaultMaxOutputTokens,
        Math.max(
          TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS,
          totalContext - TOKEN_CONSTANTS.ADJUST_TOKEN_BUFFER
        )
      );
      // Expose the full server-reported context as `maxInputTokens` so the
      // VS Code model picker displays the true window size. The chat-response
      // path uses `contextByModelId` to get the real context for budgeting.
      const maxInputTokens = totalContext;

      if (serverContext) {
        this.outputChannel.appendLine(
          `  Model ${model.id}: server-reported context ${serverContext} tokens (exposed as input=${maxInputTokens}, output=${maxOutputTokens})`
        );
      }

      const detail = describeModel(model);
      const info: vscode.LanguageModelChatInformation = {
        id: model.id,
        name: friendlyModelName(model.id),
        family: inferModelFamily(model.id),
        maxInputTokens,
        maxOutputTokens,
        version: friendlyModelName(model.id),
        capabilities: {
          imageInput: this.config.enableImageInput,
          toolCalling: this.config.enableToolCalling,
        },
        ...(detail ? { description: detail, detail } : {}),
        tooltip: detail ? `${model.id} — ${detail}` : model.id,
      };
      return info;
    });

    this.outputChannel.appendLine(
      `Found ${models.length} models: ${models.map((m) => m.id).join(', ')}`
    );
    return models;
  }

  /**
   * Provide language model chat response - streams responses from inference server
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    this.outputChannel.appendLine(`Sending chat request to model: ${model.id}`);
    this.outputChannel.appendLine(
      `Tool mode: ${describeToolMode(options.toolMode)}, Tools: ${options.tools?.length ?? 0}`
    );
    this.outputChannel.appendLine(`Message count: ${messages.length}`);

    this.showWelcomeNotification(model.id);

    const openAIMessages = this.convertAllMessages(messages);
    this.outputChannel.appendLine(`Converted to ${openAIMessages.length} OpenAI messages`);
    this.logMessageStructure(openAIMessages);

    const modelMaxContext = this.resolveModelMaxContext(model);
    const configuredMaxOutput =
      model.maxOutputTokens || TOKEN_CONSTANTS.DEFAULT_OUTPUT_TOKENS;
    const toolsSerializedLength = options.tools ? JSON.stringify(options.tools).length : 0;

    const maxInputTokens = calculateMaxInputTokens({
      modelMaxContext,
      configuredMaxOutput,
      toolsSerializedLength,
    });

    const truncatedMessages = truncateMessagesToFit(openAIMessages, maxInputTokens, (msg) =>
      this.outputChannel.appendLine(msg)
    );
    if (truncatedMessages.length < openAIMessages.length) {
      this.outputChannel.appendLine(
        `WARNING: Truncated conversation from ${openAIMessages.length} to ${truncatedMessages.length} messages to fit context limit`
      );
    }

    const inputText = buildInputText(truncatedMessages);
    const toolsOverhead = Math.ceil(toolsSerializedLength / TOKEN_CONSTANTS.CHARS_PER_TOKEN);
    const estimatedInputTokens = await this.provideTokenCount(model, inputText, token);
    const safeMaxOutputTokens = calculateSafeMaxOutputTokens({
      estimatedInputTokens,
      toolsOverhead,
      modelMaxContext,
      configuredMaxOutput,
    });

    this.outputChannel.appendLine(
      `Token estimate: input=${estimatedInputTokens}, tools=${toolsOverhead}, model_context=${modelMaxContext}, chosen_max_tokens=${safeMaxOutputTokens}`
    );

    const { tools, schemas: toolSchemas } = this.buildToolsConfig(options);
    const hasTools = tools !== undefined && tools.length > 0;
    const temperature = hasTools ? this.config.agentTemperature : DEFAULT_TEMPERATURE;

    const requestOptions = buildChatRequest({
      model: model.id,
      messages: truncatedMessages,
      maxTokens: safeMaxOutputTokens,
      temperature,
      tools,
      toolChoice: hasTools ? this.mapToolChoice(options.toolMode) : undefined,
      parallelToolCalls: hasTools ? this.config.parallelToolCalling : undefined,
      extraOptions: { ...this.config.extraModelOptions, ...options.modelOptions },
    });

    if (hasTools) {
      this.outputChannel.appendLine(
        `Sending ${tools.length} tools to model (parallel: ${this.config.parallelToolCalling})`
      );
    }

    this.logRequest(requestOptions);

    try {
      const reporter = this.createStreamReporter(progress);
      const chunks = this.client.streamChatCompletion(requestOptions, token);
      const stats = await streamResponse({
        chunks: chunks as AsyncIterable<StreamChunk>,
        reporter,
        isCancelled: () => token.isCancellationRequested,
        resolveToolCallArgs: (toolCall) => this.resolveToolCallArgs(toolCall, toolSchemas),
      });

      this.outputChannel.appendLine(
        `Completed chat request, received ${stats.totalContentLength} chars, ${stats.totalTextParts} text parts, ${stats.totalToolCalls} tool calls`
      );

      if (isEmptyStreamResult(stats)) {
        const toolCount = tools?.length ?? 0;
        await this.handleEmptyResponse(model, inputText, openAIMessages.length, toolCount, token, progress);
      }
    } catch (error) {
      this.handleChatError(error);
    }
  }

  /**
   * Provide token count estimation (rough char/4 approximation).
   *
   * Non-text parts contribute too: tool calls / tool results are serialized
   * and counted, and each image contributes a conservative fixed overhead so
   * we don't undercount multimodal conversations (otherwise the output-token
   * budget overshoots the real context window).
   */
  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    if (typeof text === 'string') {
      return estimateTextTokens(text);
    }
    let tokens = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        tokens += estimateTextTokens(part.value);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        tokens += estimateTextTokens(part.name + JSON.stringify(part.input ?? {}));
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        const body = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
        tokens += estimateTextTokens(body);
      } else if (part instanceof vscode.LanguageModelDataPart) {
        // Images don't map cleanly to tokens — reserve a conservative fixed
        // overhead so multimodal requests aren't massively undercounted.
        tokens += 800;
      }
    }
    return tokens;
  }

  /**
   * Resolve the real server-reported context size for a model. The
   * picker-facing `maxInputTokens` equals `totalContext`, so naive
   * `maxInputTokens + maxOutputTokens` would overshoot by `maxOutputTokens`
   * and cause context-length errors at the server.
   */
  private resolveModelMaxContext(model: vscode.LanguageModelChatInformation): number {
    const cached = this.contextByModelId.get(model.id);
    if (cached && cached > 0) {
      return cached;
    }
    // Fallback path: the model list hasn't been fetched yet in this session
    // (e.g. VS Code routed a cached chat directly to the provider). Use the
    // picker-facing input window, which equals totalContext after the
    // provideLanguageModelChatInformation change.
    if (model.maxInputTokens && model.maxInputTokens > 0) {
      return model.maxInputTokens;
    }
    return TOKEN_CONSTANTS.DEFAULT_CONTEXT_TOKENS;
  }

  // ---------- message classification ----------

  private convertAllMessages(messages: readonly vscode.LanguageModelChatMessage[]): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];
    const log = (msg: string): void => this.outputChannel.appendLine(msg);
    for (const msg of messages) {
      const normalized: NormalizedMessage = {
        role: this.mapRole(msg.role),
        parts: msg.content.map((part) => this.classifyPart(part)),
      };
      result.push(
        ...convertMessage(normalized, { enableImageInput: this.config.enableImageInput }, log)
      );
    }
    return result;
  }

  private mapRole(role: vscode.LanguageModelChatMessageRole): NormalizedRole {
    if (role === vscode.LanguageModelChatMessageRole.Assistant) {
      return 'assistant';
    }
    return 'user';
  }

  /**
   * Translate a vscode LanguageModel*Part into the plain data shape used by
   * messageConverter. Falls back to duck typing for older VS Code versions
   * where the constructors may not match.
   */
  private classifyPart(part: unknown): NormalizedPart {
    if (part instanceof vscode.LanguageModelTextPart) {
      return { kind: 'text', value: part.value };
    }
    if (part instanceof vscode.LanguageModelToolResultPart) {
      return {
        kind: 'toolResult',
        callId: part.callId,
        content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
      };
    }
    if (part instanceof vscode.LanguageModelToolCallPart) {
      return {
        kind: 'toolCall',
        callId: part.callId,
        name: part.name,
        input: part.input,
      };
    }
    if (part instanceof vscode.LanguageModelDataPart) {
      return { kind: 'image', mimeType: part.mimeType, data: part.data };
    }
    return this.classifyPartDuckTyped(part);
  }

  private classifyPartDuckTyped(part: unknown): NormalizedPart {
    if (typeof part !== 'object' || part === null) {
      return { kind: 'unknown' };
    }
    const anyPart = part as Record<string, unknown>;

    if ('callId' in anyPart && 'content' in anyPart && !('name' in anyPart)) {
      this.outputChannel.appendLine(`  Found tool result (duck-typed): callId=${anyPart.callId}`);
      return {
        kind: 'toolResult',
        callId: String(anyPart.callId),
        content:
          typeof anyPart.content === 'string' ? anyPart.content : JSON.stringify(anyPart.content),
      };
    }
    if ('callId' in anyPart && 'name' in anyPart && 'input' in anyPart) {
      this.outputChannel.appendLine(
        `  Found tool call (duck-typed): callId=${anyPart.callId}, name=${anyPart.name}`
      );
      return {
        kind: 'toolCall',
        callId: String(anyPart.callId),
        name: String(anyPart.name),
        input: anyPart.input,
      };
    }
    return { kind: 'unknown' };
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

  private buildToolsConfig(
    options: vscode.ProvideLanguageModelChatResponseOptions
  ): {
    tools: OpenAIToolDefinition[] | undefined;
    schemas: Map<string, Record<string, unknown> | undefined>;
  } {
    const schemas = new Map<string, Record<string, unknown> | undefined>();
    if (!this.config.enableToolCalling || !options.tools || options.tools.length === 0) {
      return { tools: undefined, schemas };
    }

    const tools: OpenAIToolDefinition[] = options.tools.map((tool) => {
      this.outputChannel.appendLine(`Tool: ${tool.name}`);
      this.outputChannel.appendLine(
        `  Description: ${formatToolDescription(tool.description)}`
      );

      const schema = tool.inputSchema as Record<string, unknown> | undefined;
      schemas.set(tool.name, schema);

      if (schema?.required && Array.isArray(schema.required)) {
        this.outputChannel.appendLine(
          `  Required properties: ${(schema.required as string[]).join(', ')}`
        );
      }

      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      };
    });

    return { tools, schemas };
  }

  /**
   * Parse and patch tool call arguments before reporting them upstream.
   * The schemas map is per-request so concurrent `provideLanguageModelChatResponse`
   * calls can't clobber each other's tool definitions.
   */
  private resolveToolCallArgs(
    toolCall: { id: string; name: string; arguments: string },
    toolSchemas: Map<string, Record<string, unknown> | undefined>
  ): Record<string, unknown> {
    this.outputChannel.appendLine(`\n=== TOOL CALL RECEIVED ===`);
    this.outputChannel.appendLine(`  ID: ${toolCall.id}`);
    this.outputChannel.appendLine(`  Name: ${toolCall.name}`);
    this.outputChannel.appendLine(
      `  Raw arguments: ${toolCall.arguments.substring(0, MAX_TOOL_ARGS_LOG_LENGTH)}${
        toolCall.arguments.length > MAX_TOOL_ARGS_LOG_LENGTH ? '...' : ''
      }`
    );

    const log = (msg: string): void => this.outputChannel.appendLine(msg);
    let args = tryRepairJson(toolCall.arguments, log) as Record<string, unknown> | null;

    if (args === null) {
      this.outputChannel.appendLine(`  ERROR: Failed to parse tool call arguments`);
      this.outputChannel.appendLine(`  Full arguments: ${toolCall.arguments}`);
      args = {};
    } else {
      const argKeys = Object.keys(args);
      this.outputChannel.appendLine(
        `  Parsed argument keys: ${argKeys.length > 0 ? argKeys.join(', ') : '(none)'}`
      );
    }

    const toolSchema = toolSchemas.get(toolCall.name);
    if (toolSchema) {
      args = fillMissingRequiredProperties(args, toolSchema, log);
    }

    this.outputChannel.appendLine(`=== END TOOL CALL ===\n`);
    return args;
  }

  private createStreamReporter(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): StreamReporter {
    return {
      reportText: (text) => progress.report(new vscode.LanguageModelTextPart(text)),
      reportThinking: (text) => progress.report(new vscode.LanguageModelThinkingPart(text)),
      reportThinkingDone: () =>
        progress.report(new vscode.LanguageModelThinkingPart('', '', { vscode_reasoning_done: true })),
      reportToolCall: (id, name, args) =>
        progress.report(new vscode.LanguageModelToolCallPart(id, name, args)),
    };
  }

  // ---------- logging helpers ----------

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
      this.outputChannel.appendLine(
        `  Message ${i + 1}: role=${msg.role}, hasContent=${hasContent}, hasToolCalls=${hasToolCalls}, toolCallId=${toolCallId}`
      );
    }
  }

  private logRequest(request: OpenAIChatCompletionRequest): void {
    if (!this.config.verboseLogging) {
      // By default log only the non-content envelope so user conversation
      // data (file contents, tool args, credentials pasted into chat) is
      // not captured in logs they may share for support.
      const toolCount = Array.isArray(request.tools) ? request.tools.length : 0;
      this.outputChannel.appendLine(
        `Request: model=${request.model}, messages=${request.messages.length}, tools=${toolCount}, max_tokens=${request.max_tokens}, temperature=${request.temperature}`
      );
      return;
    }
    const debugRequest = JSON.stringify(request, null, 2);
    this.outputChannel.appendLine(
      debugRequest.length > DEBUG_REQUEST_MAX_LOG_LENGTH
        ? `Request (truncated): ${debugRequest.substring(0, DEBUG_REQUEST_MAX_LOG_LENGTH)}...`
        : `Request: ${debugRequest}`
    );
  }

  // ---------- error / UI helpers ----------

  private async handleEmptyResponse(
    model: vscode.LanguageModelChatInformation,
    inputText: string,
    messageCount: number,
    toolCount: number,
    token: vscode.CancellationToken,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>
  ): Promise<void> {
    const inputTokenCount = await this.provideTokenCount(model, inputText, token);
    const modelMaxContext = this.resolveModelMaxContext(model);

    this.outputChannel.appendLine(`WARNING: Model returned empty response with no tool calls.`);
    this.outputChannel.appendLine(`  Input tokens estimated: ${inputTokenCount}`);
    this.outputChannel.appendLine(`  Messages in conversation: ${messageCount}`);
    this.outputChannel.appendLine(`  Tools provided: ${toolCount}`);

    const errorHint =
      toolCount > 0
        ? `The model returned an empty response. This typically indicates the model failed to generate valid output with tool calling enabled. Check the inference server logs for errors.`
        : `The model returned an empty response. Check the inference server logs for details.`;

    this.outputChannel.appendLine(`  Issue: ${errorHint}`);

    const errorMessage =
      `I was unable to generate a response. ${errorHint}\n\n` +
      `Diagnostic info:\n- Model: ${model.id}\n- Tools provided: ${toolCount}\n` +
      `- Estimated input tokens: ${inputTokenCount}\n- Context limit: ${modelMaxContext}\n\n` +
      `Check the "GitHub Copilot LLM Gateway" output panel for detailed logs.`;

    progress.report(new vscode.LanguageModelTextPart(errorMessage));
  }

  private handleChatError(error: unknown): never {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : '';

    this.outputChannel.appendLine(`ERROR: Chat request failed: ${errorMessage}`);
    if (errorStack) {
      this.outputChannel.appendLine(`Stack trace: ${errorStack}`);
    }

    // Be conservative — only treat the error as a tool-calling format error
    // when the message contains a known tool-parser signal. The previous
    // heuristic also matched on `unexpected tokens`, which appears in many
    // unrelated errors and was triggering the "may not support tool calling"
    // prompt incorrectly.
    const isToolError =
      errorMessage.includes('HarmonyError') ||
      /tool[_ -]?call.*parse/i.test(errorMessage);

    if (isToolError) {
      this.outputChannel.appendLine('HINT: This appears to be a tool calling format error.');
      this.outputChannel.appendLine('The model may not support function calling properly.');
      this.outputChannel.appendLine(
        'Try: 1) Using a different model, 2) Disabling tool calling in settings, or 3) Checking inference server logs'
      );
      this.promptToolCallingError();
    } else {
      vscode.window.showErrorMessage(
        `GitHub Copilot LLM Gateway: Chat request failed. ${errorMessage}`
      );
    }

    throw error;
  }

  private promptOpenSettings(message: string): void {
    vscode.window.showErrorMessage(message, 'Open Settings').then(
      (selection: string | undefined) => {
        if (selection === 'Open Settings') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'github.copilot.llm-gateway'
          );
        }
      },
      (err: unknown) => {
        this.outputChannel.appendLine(
          `Failed to show settings prompt: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    );
  }

  private promptToolCallingError(): void {
    vscode.window
      .showErrorMessage(
        `GitHub Copilot LLM Gateway: Model failed to generate valid tool calls. This model may not support function calling. Check Output panel for details.`,
        'Open Output',
        'Disable Tool Calling'
      )
      .then(
        (selection: string | undefined) => {
          if (selection === 'Open Output') {
            this.outputChannel.show();
          } else if (selection === 'Disable Tool Calling') {
            vscode.workspace
              .getConfiguration('github.copilot.llm-gateway')
              .update('enableToolCalling', false, vscode.ConfigurationTarget.Global);
          }
        },
        (err: unknown) => {
          this.outputChannel.appendLine(
            `Failed to show tool calling error prompt: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      );
  }

  private showWelcomeNotification(modelId: string): void {
    if (this.hasShownWelcomeNotification) {
      return;
    }
    this.hasShownWelcomeNotification = true;
    const message = `GitHub Copilot LLM Gateway is handling requests via "${modelId}".`;
    vscode.window.showInformationMessage(message, 'Open Settings').then(
      (selection: string | undefined) => {
        if (selection === 'Open Settings') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'github.copilot.llm-gateway'
          );
        }
      },
      (err: unknown) => {
        this.outputChannel.appendLine(
          `Failed to show welcome notification: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    );
  }

  // ---------- config ----------

  private loadConfig(): GatewayConfig {
    const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');

    const cfg: GatewayConfig = {
      serverUrl: config.get<string>('serverUrl', 'http://localhost:8000'),
      apiKey: config.get<string>('apiKey', ''),
      requestTimeout: config.get<number>('requestTimeout', DEFAULT_REQUEST_TIMEOUT_MS),
      defaultMaxTokens: config.get<number>('defaultMaxTokens', TOKEN_CONSTANTS.DEFAULT_CONTEXT_TOKENS),
      defaultMaxOutputTokens: config.get<number>(
        'defaultMaxOutputTokens',
        TOKEN_CONSTANTS.FALLBACK_OUTPUT_TOKENS
      ),
      enableImageInput: config.get<boolean>('enableImageInput', false),
      enableToolCalling: config.get<boolean>('enableToolCalling', true),
      parallelToolCalling: config.get<boolean>('parallelToolCalling', true),
      agentTemperature: config.get<number>('agentTemperature', 0),
      verboseLogging: config.get<boolean>('verboseLogging', false),
      customHeaders: config.get<Record<string, string>>('customHeaders', {}) ?? {},
      extraModelOptions: config.get<Record<string, unknown>>('extraModelOptions', {}) ?? {},
    };

    if (cfg.requestTimeout <= 0) {
      this.outputChannel.appendLine(
        `ERROR: requestTimeout must be > 0; using default ${DEFAULT_REQUEST_TIMEOUT_MS}`
      );
      cfg.requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS;
    }

    try {
      new URL(cfg.serverUrl);
      // URL became valid — reset the dedupe key so future invalid values are
      // re-surfaced.
      this.lastInvalidUrlNotified = undefined;
    } catch {
      const fallback = 'http://localhost:8000';
      this.outputChannel.appendLine(
        `ERROR: Invalid server URL ${JSON.stringify(cfg.serverUrl)}. Falling back to ${fallback}; fix this in settings.`
      );
      // Only surface the UI prompt if we haven't already warned about this
      // exact value — otherwise the user gets a new modal for every keystroke
      // while they're typing a URL in settings.
      if (this.lastInvalidUrlNotified !== cfg.serverUrl) {
        this.lastInvalidUrlNotified = cfg.serverUrl;
        setImmediate(() => {
          this.promptOpenSettings(
            `GitHub Copilot LLM Gateway: Invalid Server URL ${JSON.stringify(cfg.serverUrl)}. Open Settings to fix.`
          );
        });
      }
      cfg.serverUrl = fallback;
    }

    if (cfg.defaultMaxOutputTokens >= cfg.defaultMaxTokens) {
      const adjusted = Math.max(
        TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS,
        cfg.defaultMaxTokens - TOKEN_CONSTANTS.ADJUST_TOKEN_BUFFER
      );
      this.outputChannel.appendLine(
        `WARNING: github.copilot.llm-gateway.defaultMaxOutputTokens (${cfg.defaultMaxOutputTokens}) >= defaultMaxTokens (${cfg.defaultMaxTokens}). Adjusting to ${adjusted}.`
      );
      // Only pop a toast when the values the user is typing actually change,
      // otherwise every keystroke during settings editing produces a warning.
      const last = this.lastOutputTokenAdjustmentNotified;
      if (last?.output !== cfg.defaultMaxOutputTokens || last?.total !== cfg.defaultMaxTokens) {
        this.lastOutputTokenAdjustmentNotified = {
          output: cfg.defaultMaxOutputTokens,
          total: cfg.defaultMaxTokens,
        };
        vscode.window.showWarningMessage(
          `GitHub Copilot LLM Gateway: 'defaultMaxOutputTokens' was >= 'defaultMaxTokens'. Adjusted to ${adjusted} to avoid request errors.`
        );
      }
      cfg.defaultMaxOutputTokens = adjusted;
    } else {
      // Valid configuration — reset the dedupe key.
      this.lastOutputTokenAdjustmentNotified = undefined;
    }

    return cfg;
  }

  private reloadConfig(): void {
    this.config = this.loadConfig();
    this.client.updateConfig(this.config);
    this.outputChannel.appendLine('Configuration reloaded');
  }
}
