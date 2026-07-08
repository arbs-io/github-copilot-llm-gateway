/**
 * Resolved extension configuration. Assembled by the provider's config
 * service from workspace settings, the SecretStorage cache, and any
 * framework-supplied overrides — everything downstream reads this shape
 * instead of touching `vscode.workspace.getConfiguration` directly.
 */
export interface GatewayConfig {
  serverUrl: string;
  apiKey?: string;
  requestTimeout: number;
  defaultMaxTokens: number;
  defaultMaxOutputTokens: number;
  enableImageInput: boolean;
  enableToolCalling: boolean;
  parallelToolCalling: boolean;
  agentTemperature: number;
  verboseLogging: boolean;
  customHeaders: Record<string, string>;
  extraModelOptions: Record<string, unknown>;
  /** Per-model chat-completion overrides keyed by model id / wildcard (issue #43). */
  perModelOptions: Record<string, unknown>;
  /**
   * Per-model context-window overrides (total tokens) keyed by model id /
   * wildcard. Wins over server-reported values — for servers that report the
   * wrong size or none at all, e.g. llama-server router mode (issue #55).
   */
  modelContextWindows: Record<string, number>;
  /**
   * Experimental inline (fill-in-the-middle) code completion settings. Powers a
   * standalone completion provider that runs alongside — not through — GitHub
   * Copilot, since VS Code does not expose BYOK models to its own inline
   * suggestions (issue #44, microsoft/vscode#318545).
   */
  enableInlineCompletion: boolean;
  inlineCompletionModel: string;
  inlineCompletionMaxTokens: number;
  inlineCompletionDebounce: number;
  inlineCompletionTimeout: number;
  inlineCompletionMaxPrefixChars: number;
  inlineCompletionMaxSuffixChars: number;
}
