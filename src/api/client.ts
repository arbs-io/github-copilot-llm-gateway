import * as vscode from 'vscode';
import {
  OpenAIChatCompletionRequest,
  OpenAICompletionRequest,
  OpenAICompletionResponse,
  OpenAIModelsResponse,
  OpenAIUsage,
} from './types';
import { GatewayConfig } from '../config/gatewayConfig';
import {
  AccumulatedToolCall,
  LegacyFunctionCall,
  ToolCallAccumulator,
  ToolCallDelta,
} from './toolCallAccumulator';
import { IncrementalStreamParser, StreamRecord } from './streamParser';
import { filterCustomHeaders } from '../config/customHeaders';

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
    for (const [name, value] of Object.entries(filterCustomHeaders(customHeaders))) {
      headers[name] = value;
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
    // Ollama's OpenAI-compatible endpoint streams thinking as `reasoning`
    // rather than `reasoning_content` (issue #59).
    reasoning?: string;
    tool_calls?: ToolCallDelta[];
    function_call?: LegacyFunctionCall;
  };
  message?: {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
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

interface StreamState {
  terminal: boolean;
}

/**
 * Timeout for the one-shot Ollama `GET /api/version` detection probe. Kept
 * well below `requestTimeout` so a non-Ollama server that hangs on unknown
 * paths delays model discovery by at most a few seconds, once.
 */
const DISCOVERY_PROBE_TIMEOUT_MS = 3000;

/**
 * Timeout for a `POST /api/show` metadata fetch. Only issued after the server
 * is confirmed to be Ollama, where `/api/show` is a fast metadata read — but
 * these calls gate the model list, so they must not inherit the 60s default.
 */
const DISCOVERY_SHOW_TIMEOUT_MS = 5000;

const ERROR_PREFIX = 'Inference server reported an error mid-stream: ';
const MAX_ERROR_BODY_BYTES = 65_536;
const MAX_ERROR_DETAIL_CHARACTERS = 1_000;
const MAX_JSON_RESPONSE_BYTES = 16_777_216;

export class ResponseBodyLimitError extends Error {
  public readonly code = 'RESPONSE_BODY_LIMIT_EXCEEDED';

  constructor(public readonly limit: number) {
    super(`The inference server response exceeded the body limit of ${limit} bytes.`);
    this.name = 'ResponseBodyLimitError';
  }
}

export class GatewayPartialStreamError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'GatewayPartialStreamError';
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Lifecycle handles for the AbortController + the two timers used by a
 * streaming chat-completion request. Returned by `createStreamTimers` so the
 * main streaming function doesn't have to track them inline.
 */
interface StreamTimers {
  readonly controller: AbortController;
  readonly resetInactivity: () => void;
  /** Called once response headers arrive — switches to the inactivity timer. */
  readonly onHeadersReceived: () => void;
  /** Clears every outstanding timer + cancellation subscription. */
  readonly dispose: () => void;
}

/**
 * Throw a descriptive error for a failed chat-completion response, including
 * the response body when the server provided one. Pulled out of
 * `streamChatCompletion` so the main function stays under the
 * cognitive-complexity budget.
 */
async function assertChatStreamResponseOk(response: Response): Promise<void> {
  if (response.ok && response.body) { return; }
  if (!response.ok) {
    const errorText = await readSafeErrorBody(response);
    throw new Error(`Chat completion failed: ${response.status} ${response.statusText} - ${errorText}`);
  }
  throw new Error('Response body is null');
}

/**
 * Node's `fetch` (undici) throws an opaque `TypeError: fetch failed` and stashes
 * the real reason — DNS failure (`ENOTFOUND`), connection refused
 * (`ECONNREFUSED`), timeout (`ETIMEDOUT`), TLS error, etc. — on `error.cause`.
 * Surface that cause so users see *why* the connection failed instead of a bare
 * "fetch failed".
 */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return sanitizeErrorDetail(String(error));
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && !error.message.includes(cause.message)) {
    return sanitizeErrorDetail(`${error.message}: ${cause.message}`);
  }
  return sanitizeErrorDetail(error.message);
}

/**
 * HTTP-level failure from `/v1/completions`. Carries the raw status and
 * response body so callers can react to specific server limitations — e.g.
 * vLLM's `400 "suffix is not currently supported"` — instead of string-matching
 * the human-facing message.
 */
export class CompletionHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = 'CompletionHttpError';
  }
}

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

    const message = lastError ? describeFetchError(lastError) : 'unknown error';
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
    return this.fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: this.getHeaders(),
      },
      async (response) => {
        if (response.ok) {
          return readJsonResponse<OpenAIModelsResponse>(response);
        }
        if (response.status === 404 && !isLast) {
          await response.body?.cancel().catch(() => undefined);
          this.log(`Models endpoint not found at ${url}, trying fallback...`);
          return undefined;
        }

        const detail = await readSafeErrorBody(response);
        const suffix = detail ? ` — ${detail}` : '';
        throw new Error(
          `Failed to fetch models from ${url}: ${response.status} ${response.statusText}${suffix}`
        );
      },
      cancellationToken
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
    const timers = this.createStreamTimers(cancellationToken);
    const state: StreamState = { terminal: false };
    let emittedVisibleOutput = false;

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
          stream_options: { ...(request.stream_options as object | undefined), include_usage: true },
        }),
        signal: timers.controller.signal,
      });

      // Headers received — switch from the request-deadline timer to the
      // per-chunk inactivity timer so long generations aren't aborted.
      timers.onHeadersReceived();

      await assertChatStreamResponseOk(response);

      for await (const chunk of this.readChatStreamChunks(
        response.body!,
        accumulator,
        state,
        cancellationToken,
        timers.resetInactivity
      )) {
        emittedVisibleOutput ||= hasVisibleOutput(chunk);
        yield chunk;
      }

      if (cancellationToken.isCancellationRequested) {
        return;
      }

      if (!state.terminal) {
        if (emittedVisibleOutput) {
          throw new GatewayPartialStreamError(
            'The inference server closed the stream without a terminal finish signal. Partial output was preserved.'
          );
        }
        throw new Error(
          'The inference server closed the stream without a terminal finish signal. Pending output was discarded.'
        );
      }
    } catch (error) {
      if (cancellationToken.isCancellationRequested) {
        return;
      }
      if (error instanceof GatewayPartialStreamError) {
        throw error;
      }
      if (emittedVisibleOutput) {
        throw new GatewayPartialStreamError(
          'The connection dropped before the model finished streaming. Partial output was preserved.',
          error
        );
      }
      if (error instanceof Error) {
        throw new Error(`Chat completion request failed: ${describeFetchError(error)}`);
      }
      throw error;
    } finally {
      timers.dispose();
    }
  }

  /**
   * Read SSE chunks off the response body until done or cancelled, parsing
   * each line through {@link processSSELine}. Split out of
   * `streamChatCompletion` so the parent function stays under SonarCloud's
   * cognitive-complexity budget.
   */
  private async *readChatStreamChunks(
    body: ReadableStream<Uint8Array>,
    accumulator: ToolCallAccumulator,
    state: StreamState,
    cancellationToken: vscode.CancellationToken,
    resetInactivity: () => void
  ): AsyncGenerator<GatewayStreamChunk, void, unknown> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new IncrementalStreamParser();
    let reachedEnd = false;

    try {
      while (true) {
        if (cancellationToken.isCancellationRequested) {
          await reader.cancel();
          return;
        }

        const { done, value } = await reader.read();
        if (done) {
          reachedEnd = true;
          break;
        }

        resetInactivity();
        const text = decoder.decode(value, { stream: true });
        for (const record of parser.push(text)) {
          const result = this.processStreamRecord(record, accumulator, state);
          if (result) { yield result; }
        }
      }

      const finalText = decoder.decode();
      for (const record of parser.push(finalText)) {
        const result = this.processStreamRecord(record, accumulator, state);
        if (result) { yield result; }
      }
      for (const record of parser.flush()) {
        const result = this.processStreamRecord(record, accumulator, state);
        if (result) { yield result; }
      }
    } finally {
      if (!reachedEnd) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be aborted or errored.
        }
      }
      reader.releaseLock();
    }
  }

  /**
   * Wire up the AbortController, request-deadline timer, and per-chunk
   * inactivity timer used by the streaming request. The two timers run
   * sequentially: the request timer fires until headers arrive, then the
   * inactivity timer takes over and is reset on each chunk.
   */
  private createStreamTimers(cancellationToken: vscode.CancellationToken): StreamTimers {
    const controller = new AbortController();
    const cancelSub = cancellationToken.onCancellationRequested(() => controller.abort());
    const headerTimeoutId = setTimeout(() => controller.abort(), this.config.requestTimeout);
    const configuredStreamTimeout = this.config.streamIdleTimeout;
    const streamIdleTimeout =
      typeof configuredStreamTimeout === 'number' &&
      Number.isFinite(configuredStreamTimeout) &&
      configuredStreamTimeout > 0
        ? configuredStreamTimeout
        : this.config.requestTimeout;
    let inactivityTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const resetInactivity = (): void => {
      if (inactivityTimeoutId) { clearTimeout(inactivityTimeoutId); }
      inactivityTimeoutId = setTimeout(() => controller.abort(), streamIdleTimeout);
    };
    return {
      controller,
      resetInactivity,
      onHeadersReceived: () => {
        clearTimeout(headerTimeoutId);
        resetInactivity();
      },
      dispose: () => {
        clearTimeout(headerTimeoutId);
        if (inactivityTimeoutId) { clearTimeout(inactivityTimeoutId); }
        cancelSub.dispose();
      },
    };
  }

  /**
   * Process one framed SSE/NDJSON record. Pending tool calls are released only
   * after a protocol terminal signal so a clean-but-truncated EOF cannot
   * execute incomplete model output.
   */
  private processStreamRecord(
    record: StreamRecord,
    accumulator: ToolCallAccumulator,
    state: StreamState
  ): GatewayStreamChunk | null {
    if (record.done) {
      state.terminal = true;
      return toolCallOnlyChunk(accumulator.drain(true));
    }
    if (record.data.length === 0) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(record.data);
    } catch {
      throw new Error('The inference server returned a malformed streamed JSON payload.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('The inference server returned an unsupported streamed payload.');
    }

    const obj = parsed as Record<string, unknown>;

    // Inline error payload: `{ "error": { "message": "..." } }`. HTTP status
    // remains 200 on several OpenAI-compatible gateways, so the payload is
    // authoritative even if a proxy also left a `choices` field attached.
    if ('error' in obj) {
      const message = sanitizeErrorDetail(
        extractServerErrorMessage(obj as unknown as ServerErrorPayload)
      );
      throw new Error(`${ERROR_PREFIX}${message}`);
    }

    state.terminal ||= hasTerminalSignal(obj);
    const chunk = this.dispatchParsedChunk(obj, accumulator);
    if (!state.terminal) {
      return chunk;
    }

    const remaining = accumulator.drain(true);
    if (remaining.length === 0) {
      return chunk;
    }
    if (!chunk) {
      return toolCallOnlyChunk(remaining);
    }
    return {
      ...chunk,
      finished_tool_calls: [...chunk.finished_tool_calls, ...remaining],
    };
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
    if (choices && !choice) {
      if (!usage) { return null; }
      return {
        content: '',
        reasoning_content: '',
        tool_calls: [],
        finished_tool_calls: [],
        usage,
      };
    }

    if (choice) {
      const chunk: ParsedChunk = {
        delta: choice.delta as ParsedChunk['delta'],
        message: choice.message as ParsedChunk['message'],
        finishReason: choice.finish_reason as string | undefined,
        id: typeof obj.id === 'string' ? obj.id : undefined,
      };

      if (chunk.delta) {
        const { content, reasoningContent, finishedToolCalls } =
          this.applyDeltaChoice(chunk, accumulator);
        return {
          content,
          reasoning_content: reasoningContent,
          tool_calls: [],
          finished_tool_calls: finishedToolCalls,
          ...(usage ? { usage } : {}),
        };
      }
      if (chunk.message) {
        const { content, reasoningContent, finishedToolCalls } =
          this.applyMessageChoice(chunk, accumulator);
        return {
          content,
          reasoning_content: reasoningContent,
          tool_calls: [],
          finished_tool_calls: finishedToolCalls,
          ...(usage ? { usage } : {}),
        };
      }
    }
    const ollamaMessage = obj.message;
    if (ollamaMessage && typeof ollamaMessage === 'object' && !Array.isArray(ollamaMessage)) {
      const parsedMessage: ParsedChunk = {
        message: ollamaMessage as ParsedChunk['message'],
        finishReason: readTopLevelFinishReason(obj),
        id: typeof obj.id === 'string' ? obj.id : undefined,
      };
      const { content, reasoningContent, finishedToolCalls } =
        this.applyMessageChoice(parsedMessage, accumulator);
      return {
        content,
        reasoning_content: reasoningContent,
        tool_calls: [],
        finished_tool_calls: finishedToolCalls,
        ...(usage ? { usage } : {}),
      };
    }
    if (typeof obj.response === 'string') {
      return {
        content: obj.response,
        reasoning_content:
          typeof obj.reasoning_content === 'string'
            ? obj.reasoning_content
            : typeof obj.reasoning === 'string'
              ? obj.reasoning
              : '',
        tool_calls: [],
        finished_tool_calls: [],
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

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        accumulator.applyDelta(tc);
      }
    }

    if (delta.function_call) {
      accumulator.applyLegacy(delta.function_call, parsed.id ?? '');
    }

    return {
      content: delta.content ?? '',
      reasoningContent: delta.reasoning_content ?? delta.reasoning ?? '',
      finishedToolCalls: [],
    };
  }

  private applyMessageChoice(
    parsed: ParsedChunk,
    accumulator: ToolCallAccumulator
  ): { content: string; reasoningContent: string; finishedToolCalls: AccumulatedToolCall[] } {
    const message = parsed.message!;

    if (Array.isArray(message.tool_calls)) {
      accumulator.accumulateComplete(message.tool_calls);
    }

    if (message.function_call) {
      accumulator.accumulateComplete([
        { index: 0, id: parsed.id, function: message.function_call },
      ]);
    }

    return {
      content: message.content ?? message.text ?? '',
      reasoningContent: message.reasoning_content ?? message.reasoning ?? '',
      finishedToolCalls: [],
    };
  }

  /**
   * Fetch a single non-streaming completion from `/v1/completions`. Used by the
   * experimental inline-completion provider for fill-in-the-middle. Takes its
   * own `timeoutMs` because completions need a much tighter latency budget than
   * the chat `requestTimeout` default.
   */
  public async fetchCompletion(
    request: OpenAICompletionRequest,
    cancellationToken: vscode.CancellationToken,
    timeoutMs: number
  ): Promise<OpenAICompletionResponse> {
    const url = `${normalizeBaseUrl(this.config.serverUrl)}/v1/completions`;
    return this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, stream: false }),
      },
      async (response) => {
        if (!response.ok) {
          const body = await readSafeErrorBody(response);
          const suffix = body ? ` — ${body}` : '';
          throw new CompletionHttpError(
            `Completion failed: ${response.status} ${response.statusText}${suffix}`,
            response.status,
            body
          );
        }
        return readJsonResponse<OpenAICompletionResponse>(response);
      },
      cancellationToken,
      timeoutMs
    );
  }

  /**
   * Probe whether the server is Ollama via its native `GET /api/version`
   * endpoint. Uses a short timeout so a foreign server that hangs on unknown
   * paths can't stall model discovery — this runs once per config generation
   * (cached by `OllamaDiscovery`), not per model.
   */
  public async probeOllama(cancellationToken?: vscode.CancellationToken): Promise<boolean> {
    const base = normalizeBaseUrl(this.config.serverUrl);
    try {
      return await this.fetchWithTimeout(
        `${base}/api/version`,
        { method: 'GET', headers: this.getHeaders() },
        async (response) => {
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return false;
          }
          const body = await readJsonResponse<unknown>(response);
          return (
            typeof body === 'object' && body !== null &&
            typeof (body as { version?: unknown }).version === 'string'
          );
        },
        cancellationToken,
        DISCOVERY_PROBE_TIMEOUT_MS
      );
    } catch {
      return false;
    }
  }

  /**
   * Fetch Ollama-specific model metadata via the native `POST /api/show`
   * endpoint (context window, Modelfile sampler params, capabilities).
   * Returns the raw JSON body — parsing lives in `discovery/ollamaDiscovery`
   * — or `undefined` on any failure.
   */
  public async showModel(
    modelId: string,
    cancellationToken?: vscode.CancellationToken
  ): Promise<unknown> {
    const base = normalizeBaseUrl(this.config.serverUrl);
    try {
      return await this.fetchWithTimeout(
        `${base}/api/show`,
        {
          method: 'POST',
          headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId }),
        },
        async (response) => {
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return undefined;
          }
          return readJsonResponse<unknown>(response);
        },
        cancellationToken,
        DISCOVERY_SHOW_TIMEOUT_MS
      );
    } catch {
      return undefined;
    }
  }

  private getHeaders(): Record<string, string> {
    return buildHeaders(this.config.apiKey, this.config.customHeaders);
  }

  /**
   * Fetch wrapper with a total-request timeout (the configured
   * `requestTimeout`, or `timeoutMs` when the caller needs a tighter budget)
   * and optional cancellation-token wiring. Used for non-streaming requests
   * like the model list and inline completions. Streaming requests manage
   * their own timers in `streamChatCompletion`.
   */
  private async fetchWithTimeout<T>(
    url: string,
    options: RequestInit,
    consume: (response: Response) => Promise<T>,
    cancellationToken?: vscode.CancellationToken,
    timeoutMs?: number
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      timeoutMs ?? this.config.requestTimeout
    );
    const cancelSub = cancellationToken?.onCancellationRequested(() => controller.abort());

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return await consume(response);
    } finally {
      clearTimeout(timeoutId);
      cancelSub?.dispose();
    }
  }
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const { text } = await readBoundedResponseText(response, MAX_JSON_RESPONSE_BYTES, false);
  return JSON.parse(text) as T;
}

async function readSafeErrorBody(response: Response): Promise<string> {
  try {
    const { text, truncated } = await readBoundedResponseText(
      response,
      MAX_ERROR_BODY_BYTES,
      true
    );
    const detail = sanitizeErrorDetail(text);
    return truncated ? `${detail}${detail ? ' ' : ''}[truncated]` : detail;
  } catch {
    return '';
  }
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  truncateOnLimit: boolean
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) { return { text: '', truncated: false }; }
  const declaredLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maxBytes &&
    !truncateOnLimit
  ) {
    await response.body.cancel().catch(() => undefined);
    throw new ResponseBodyLimitError(maxBytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pieces: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        pieces.push(decoder.decode());
        return { text: pieces.join(''), truncated: false };
      }

      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          pieces.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
        }
        pieces.push(decoder.decode());
        await reader.cancel().catch(() => undefined);
        if (!truncateOnLimit) {
          throw new ResponseBodyLimitError(maxBytes);
        }
        return { text: pieces.join(''), truncated: true };
      }
      bytesRead += value.byteLength;
      pieces.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

function sanitizeErrorDetail(value: string): string {
  const redacted = value
    .replace(
      /\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
      '$1[redacted]@'
    )
    .replace(
      /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;"'}]+/gi,
      '$1[redacted]'
    )
    .replace(
      /(["']?(?:api[_ -]?key|access[_ -]?token|token|secret|password)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      '$1[redacted]'
    )
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.length > MAX_ERROR_DETAIL_CHARACTERS
    ? `${redacted.slice(0, MAX_ERROR_DETAIL_CHARACTERS)}…`
    : redacted;
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

function hasVisibleOutput(chunk: GatewayStreamChunk): boolean {
  return (
    chunk.content.length > 0 ||
    chunk.reasoning_content.length > 0 ||
    chunk.finished_tool_calls.length > 0
  );
}

function toolCallOnlyChunk(
  toolCalls: AccumulatedToolCall[]
): GatewayStreamChunk | null {
  if (toolCalls.length === 0) {
    return null;
  }
  return {
    content: '',
    reasoning_content: '',
    tool_calls: [],
    finished_tool_calls: toolCalls,
  };
}

function hasTerminalSignal(payload: Record<string, unknown>): boolean {
  if (payload.done === true || typeof payload.done_reason === 'string') {
    return true;
  }

  if (!Array.isArray(payload.choices)) {
    return false;
  }
  return payload.choices.some((choice) => {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
      return false;
    }
    const finishReason = (choice as Record<string, unknown>).finish_reason;
    return typeof finishReason === 'string' && finishReason.length > 0;
  });
}

function readTopLevelFinishReason(
  payload: Record<string, unknown>
): string | undefined {
  if (typeof payload.done_reason === 'string') {
    return payload.done_reason;
  }
  return payload.done === true ? 'stop' : undefined;
}
