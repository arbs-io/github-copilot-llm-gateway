import type { CancellationToken } from 'vscode';

/**
 * Discovered sampler params that are safe to forward on each chat request
 * when the caller/settings didn't specify them. Excludes `temperature`
 * (resolved explicitly in the chat handler) and non-request config like
 * `num_ctx`/`num_predict`/`seed`. Discovery implementations parse at least
 * these keys, so the parse side and the forward side can't drift apart.
 */
export const REQUEST_SAMPLER_KEYS = [
  'top_p', 'top_k', 'min_p', 'typical_p',
  'presence_penalty', 'frequency_penalty', 'repeat_penalty',
] as const;

/**
 * Backend-neutral shape for model metadata discovered from a server's native
 * (non-OpenAI) API. Only the discovery implementation knows which backend it
 * is talking to; the model catalog and chat path consume this shape without
 * ever branching on backend identity.
 */
export interface DiscoveredModelInfo {
  /** Usable context window in tokens, when the backend reports one. */
  readonly contextLength?: number;
  /** Human-readable origin of `contextLength` for the output-channel log. */
  readonly contextSource?: string;
  /** Numeric sampler params baked into the model's server-side config. */
  readonly samplerParams: Readonly<Record<string, number>>;
  /** Whether the model accepts image input; `undefined` = server didn't say. */
  readonly visionSupported?: boolean;
  /** Whether the model supports tool calling; `undefined` = server didn't say. */
  readonly toolsSupported?: boolean;
}

/**
 * A probe for one backend's native discovery API. Implementations must be
 * cheap for foreign servers: detect the backend once (cached until `reset`)
 * and return `undefined` without further requests when it isn't theirs.
 */
export interface ModelDiscovery {
  /**
   * Forget the cached backend detection. Called when the server may have
   * changed (config reload, Refresh Models command).
   */
  reset(): void;
  /**
   * Fetch native metadata for one model, or `undefined` when the backend
   * wasn't detected or the model has none.
   */
  enrichModel(
    modelId: string,
    token?: CancellationToken
  ): Promise<DiscoveredModelInfo | undefined>;
}
