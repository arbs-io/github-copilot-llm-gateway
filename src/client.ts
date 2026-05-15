import * as vscode from 'vscode';
import {
  OpenAIChatCompletionRequest,
  OpenAIModelsResponse,
  OpenAIUsage,
  GatewayConfig,
} from './types';
import {
  AccumulatedToolCall,
  LegacyFunctionCall,
  ToolCallAccumulator,
  ToolCallDelta,
} from './toolCallAccumulator';

/**
 * Trim trailing slashes and a trailing `/v1` (or `/openai/v1`) segment so the
 * client can safely append `/v1/models` / `/v1/chat/completions` regardless of
 * how the user typed their Server URL in settings.
 */
export function normalizeBaseUrl(rawUrl: string): string {
  let url = rawUrl.trim();
  while (url.endsWith('/')) { url = url.slice(0, -1); }
  url = url.replace(/\/(openai\/)?v1$/i, '');
  return url;
}

/**
 * Strip a leading `Bearer ` (case-insensitive) from the configured API key
 * and trim whitespace. The client always prepends `Bearer`, so users who
 * paste their full `Authorization: Bearer …` header would otherwise send
 * `Bearer Bearer …` and get 401s.
 */
export function normalizeApiKey(rawKey: string | undefined): string {
  if (!rawKey) { return ''; }
  return rawKey.trim().replace(/^Bearer\s+/i, '');
}

/**
 * Build the request header set for the inference server. Authorization is
 * applied first so user-configured `customHeaders` can override it for
 * backends that need a non-Bearer auth scheme (e.g. Azure's `api-key`).
 * Empty/non-string values and empty header names are dropped.
 */
export function buildHeaders(
  apiKey: string | undefined,
  customHeaders: Record<string, string> | undefined
): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = normalizeApiKey(apiKey);
  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
  }
  if (customHeaders) {
    for (const [name, value] of Object.entries(customHeaders)) {
      if (typeof value === 'string' && name.length > 0) {
        headers[name] = value;
      }
    }
  }
  return headers;
}

/**
 * Wire-format chat-completion chunk that downstream consumers see.
 *
 * `usage` is set only on the final chunk of a stream (OpenAI's convention
 * when the request was sent with `stream_options.include_usage: true`).
 * Older or stripped servers may omit it entirely — we surface it when
 * present so VS Code's chat context-window widget can render running
 * token counts (issue #24).
 */
export interface GatewayStreamChunk {
  content: string;
  reasoning_content: string;
  tool_calls: AccumulatedToolCall[];
  finished_tool_calls: AccumulatedToolCall[];
  usage?: OpenAIUsage;
}

/**
 * Re-export so existing imports of `StreamingToolCall` from this module keep
 * working without churn.
 */
export type StreamingToolCall = AccumulatedToolCall;

/**
 * Shape of an OpenAI streaming/non-streaming choice payload that we know
 * how to read. Kept loose; servers vary.
 */
interface ParsedChunk {
  delta?: {
    content?: string;
    reasoning_content?: string;
    tool_calls?: ToolCallDelta[];
    function_call?: LegacyFunctionCall;
  };
  message?: {
    content?: string;
    reasoning_content?: string;
    text?: string;
    tool_calls?: ToolCallDelta[];
    function_call?: LegacyFunctionCall;
  };
  finishReason?: string;
  id?: string;
}

interface ServerErrorPayload {
  error: { message?: string } | string;
}

export type GatewayLogger = (message: string) => void;

const SSE_DATA_PREFIX = 'data: ';
const SSE_DONE_LINE = 'data: [DONE]';
const ERROR_PREFIX = 'Inference server reported an error mid-stream: ';

export class GatewayClient {
  private config: GatewayConfig;
  private readonly log: GatewayLogger;

  constructor(config: GatewayConfig, logger?: GatewayLogger) {
    this.config = config;
    this.log = logger ?? (() => { /* no-op */ });
  }

  public updateConfig(config: GatewayConfig): void {
    this.config = config;
  }

  /**
   * Fetch available models from the server's models endpoint.
   *
   * Tries `/v1/models` first and falls back to `/models` so the client works
   * against servers that mount the OpenAI API at the root.
   */
  public async fetchModels(cancellationToken?: vscode.CancellationToken): Promise<OpenAIModelsResponse> {
    const base = normalizeBaseUrl(this.config.serverUrl);
    const candidates = [`${base}/v1/models`, `${base}/models`];
    let lastError: Error | undefined;

    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i];
      const isLast = i === candidates.length - 1;
      try {
        const result = await this.tryFetchModels(url, isLast, cancellationToken);
        if (result) { return result; }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (isLast) { break; }
      }
    }

    const message = lastError?.message ?? 'unknown error';
    throw new Error(`Failed to connect to inference server at ${base}: ${message}`);
  }

  /**
   * Attempt a single model-fetch against `url`. Returns the parsed response
   * on success, `undefined` if the endpoint returned 404 and `allowFallback`
   * is true, or throws on any other failure.
   */
  private async tryFetchModels(
    url: string,
    isLast: boolean,
    cancellationToken?: vscode.CancellationToken
  ): Promise<OpenAIModelsResponse | undefined> {
    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: this.getHeaders(),
    }, cancellationToken);

    if (response.ok) {
      return await response.json();
    }

    if (response.status === 404 && !isLast) {
      this.log(`Models endpoint not found at ${url}, trying fallback...`);
      return undefined;
    }

    const bodyText = await response.text().catch(() => '');
    const truncated = bodyText.length > 200 ? bodyText.slice(0, 200) + '...' : bodyText;
    const suffix = truncated ? ' — ' + truncated : '';
    throw new Error(
      `Failed to fetch models from ${url}: ${response.status} ${response.statusText}${suffix}`
    );
  }

  /**
   * Stream chat completions from `/v1/chat/completions`. Tool calls are
   * accumulated by index across chunks (their `id` may arrive later than
   * their name/arguments). Manages two timers explicitly:
   *   - the configured `requestTimeout` applies until headers arrive,
   *   - then a per-read inactivity timer of the same duration is reset on
   *     each chunk so long generations aren't aborted mid-stream.
   */
  public async *streamChatCompletion(
    request: OpenAIChatCompletionRequest,
    cancellationToken: vscode.CancellationToken
  ): AsyncGenerator<GatewayStreamChunk, void, unknown> {
    const url = `${normalizeBaseUrl(this.config.serverUrl)}/v1/chat/completions`;
    const accumulator = new ToolCallAccumulator();

    const controller = new AbortController();
    const cancelSub = cancellationToken.onCancellationRequested(() => controller.abort());
    const headerTimeoutId = setTimeout(() => controller.abort(), this.config.requestTimeout);
    let inactivityTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const resetInactivityTimer = (): void => {
      if (inactivityTimeoutId) { clearTimeout(inactivityTimeoutId); }
      inactivityTimeoutId = setTimeout(() => controller.abort(), this.config.requestTimeout);
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
        // `stream_options.include_usage` tells OpenAI-compatible servers to
        // emit a final SSE chunk containing `usage` totals once the model
        // finishes. We forward that to VS Code's chat context-window widget
        // (issue #24). Servers that don't recognise the option simply
        // ignore it; servers behind aggressive proxies may strip it.
        body: JSON.stringify({
          ...request,
          stream: true,
          stream_options: { ...((request.stream_options as object | undefined) ?? {}), include_usage: true },
        }),
        signal: controller.signal,
      });

      // Headers received — switch to the inactivity timer.
      clearTimeout(headerTimeoutId);
      resetInactivityTimer();

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Chat completion failed: ${response.status} ${response.statusText} - ${errorText}`);
      }
      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (cancellationToken.isCancellationRequested) {
          reader.cancel();
          break;
        }

        const { done, value } = await reader.read();
        if (done) { break; }

        resetInactivityTimer();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const result = this.processSSELine(line, accumulator);
          if (result) { yield result; }
        }
      }

      const remaining = accumulator.drain(true);
      if (remaining.length > 0) {
        yield { content: '', reasoning_content: '', tool_calls: [], finished_tool_calls: remaining };
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Chat completion request failed: ${error.message}`);
      }
      throw error;
    } finally {
      clearTimeout(headerTimeoutId);
      if (inactivityTimeoutId) { clearTimeout(inactivityTimeoutId); }
      cancelSub.dispose();
    }
  }

  /**
   * Process one SSE line. Returns a chunk to yield, or null if there's
   * nothing to emit. Throws if the server sent an inline error payload —
   * the caller can then surface a real error instead of an empty stream.
   */
  private processSSELine(line: string, accumulator: ToolCallAccumulator): GatewayStreamChunk | null {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed === SSE_DONE_LINE) { return null; }
    if (trimmed.startsWith('event:')) { return null; }
    if (!trimmed.startsWith(SSE_DATA_PREFIX)) { return null; }

    const data = trimmed.slice(SSE_DATA_PREFIX.length);

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.log(`Failed to parse SSE chunk: ${data}`);
      return null;
    }
    if (!parsed || typeof parsed !== 'object') { return null; }

    const obj = parsed as Record<string, unknown>;

    // Inline error payload: `{ "error": { "message": "..." } }`. Distinguished
    // from a normal chunk (which has `choices`).
    if ('error' in obj && !('choices' in obj)) {
      const message = extractServerErrorMessage(obj as unknown as ServerErrorPayload);
      throw new Error(`${ERROR_PREFIX}${message}`);
    }

    return this.dispatchParsedChunk(obj, accumulator);
  }

  private dispatchParsedChunk(
    obj: Record<string, unknown>,
    accumulator: ToolCallAccumulator
  ): GatewayStreamChunk | null {
    const usage = extractUsage(obj.usage);
    const choices = Array.isArray(obj.choices) ? obj.choices : undefined;
    const choice = choices?.[0] as Record<string, unknown> | undefined;

    // OpenAI's stream-with-include_usage convention puts the totals on a
    // trailing chunk with an empty `choices` array — surface it as a
    // usage-only stream chunk so the provider can forward it to the chat
    // context-window widget (issue #24).
    if (!choice) {
      if (!usage) { return null; }
      return {
        content: '',
        reasoning_content: '',
        tool_calls: [],
        finished_tool_calls: [],
        usage,
      };
    }

    const chunk: ParsedChunk = {
      delta: choice.delta as ParsedChunk['delta'],
      message: choice.message as ParsedChunk['message'],
      finishReason: choice.finish_reason as string | undefined,
      id: typeof obj.id === 'string' ? obj.id : undefined,
    };

    if (chunk.delta) {
      const { content, reasoningContent, finishedToolCalls } = this.applyDeltaChoice(chunk, accumulator);
      return {
        content,
        reasoning_content: reasoningContent,
        tool_calls: [],
        finished_tool_calls: finishedToolCalls,
        ...(usage ? { usage } : {}),
      };
    }
    if (chunk.message) {
      const { content, reasoningContent, finishedToolCalls } = this.applyMessageChoice(chunk, accumulator);
      return {
        content,
        reasoning_content: reasoningContent,
        tool_calls: [],
        finished_tool_calls: finishedToolCalls,
        ...(usage ? { usage } : {}),
      };
    }
    return null;
  }

  private applyDeltaChoice(
    parsed: ParsedChunk,
    accumulator: ToolCallAccumulator
  ): { content: string; reasoningContent: string; finishedToolCalls: AccumulatedToolCall[] } {
    const delta = parsed.delta!;
    const finishedToolCalls: AccumulatedToolCall[] = [];

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        accumulator.applyDelta(tc);
      }
    }

    if (delta.function_call) {
      accumulator.applyLegacy(delta.function_call, parsed.id ?? '');
    }

    if (parsed.finishReason === 'tool_calls' || parsed.finishReason === 'function_call') {
      finishedToolCalls.push(...accumulator.drain());
    }

    return {
      content: delta.content ?? '',
      reasoningContent: delta.reasoning_content ?? '',
      finishedToolCalls,
    };
  }

  private applyMessageChoice(
    parsed: ParsedChunk,
    accumulator: ToolCallAccumulator
  ): { content: string; reasoningContent: string; finishedToolCalls: AccumulatedToolCall[] } {
    const message = parsed.message!;
    const finishedToolCalls: AccumulatedToolCall[] = [];

    if (Array.isArray(message.tool_calls)) {
      finishedToolCalls.push(...accumulator.applyComplete(message.tool_calls));
    }

    if (message.function_call) {
      const completed = accumulator.applyComplete([
        { index: 0, id: parsed.id, function: message.function_call },
      ]);
      finishedToolCalls.push(...completed);
    }

    return {
      content: message.content ?? message.text ?? '',
      reasoningContent: message.reasoning_content ?? '',
      finishedToolCalls,
    };
  }

  private getHeaders(): Record<string, string> {
    return buildHeaders(this.config.apiKey, this.config.customHeaders);
  }

  /**
   * Fetch wrapper with a fixed total-request timeout and optional
   * cancellation-token wiring. Used for non-streaming requests like the
   * model list. Streaming requests manage their own timers in
   * `streamChatCompletion`.
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    cancellationToken?: vscode.CancellationToken
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeout);
    const cancelSub = cancellationToken?.onCancellationRequested(() => controller.abort());

    try {
      return await fetch(url, {
        ...options,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
      cancelSub?.dispose();
    }
  }
}

/**
 * Validate and shape a raw `usage` payload from the inference server. Coerces
 * NaN/missing fields to 0 and clamps negative sentinel values (some servers
 * emit -1 when totals aren't yet available) so VS Code's chat context-window
 * widget doesn't render nonsensical numbers (issue #24).
 */
export function extractUsage(raw: unknown): OpenAIUsage | undefined {
  if (!raw || typeof raw !== 'object') { return undefined; }
  const obj = raw as Record<string, unknown>;
  const prompt = toNonNegativeNumber(obj.prompt_tokens);
  const completion = toNonNegativeNumber(obj.completion_tokens);
  const total = toNonNegativeNumber(obj.total_tokens, prompt + completion);

  // Some servers omit `prompt_tokens` and `completion_tokens` entirely.
  // Require at least one signal so we don't emit an all-zero usage frame
  // that would briefly reset the context-window widget to 0% mid-stream.
  if (obj.prompt_tokens === undefined && obj.completion_tokens === undefined && obj.total_tokens === undefined) {
    return undefined;
  }

  const detailsRaw = obj.prompt_tokens_details;
  const cached = detailsRaw && typeof detailsRaw === 'object'
    ? toNonNegativeNumber((detailsRaw as Record<string, unknown>).cached_tokens)
    : 0;

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    prompt_tokens_details: { cached_tokens: cached },
  };
}

function toNonNegativeNumber(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) { return fallback; }
  return value < 0 ? 0 : value;
}

function extractServerErrorMessage(payload: ServerErrorPayload): string {
  const err = payload.error;
  if (typeof err === 'string') { return err; }
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  return JSON.stringify(err);
}
