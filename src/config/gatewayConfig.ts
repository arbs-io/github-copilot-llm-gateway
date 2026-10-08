/**
 * Resolved extension configuration. Assembled by the provider's config
 * service from workspace settings, the SecretStorage cache, and any
 * framework-supplied overrides — everything downstream reads this shape
 * instead of touching `vscode.workspace.getConfiguration` directly.
 */
import type { ThinkingEffortPickerMode } from './thinkingEffort';

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
   * Request-body key the "Set Thinking Effort" command writes into
   * `perModelOptions` (issue #82). Defaults to OpenAI's `reasoning_effort`;
   * change it for backends that name the parameter differently.
   */
  thinkingEffortParameter: string;
  /**
   * Which gateway models get VS Code's native Thinking Effort control in the
   * chat model picker. See `ThinkingEffortPickerMode`.
   */
  thinkingEffortPicker: ThinkingEffortPickerMode;
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
  /**
   * Append a `Tokens: input … | output … | total …` line to the end of each
   * reply, summing server-reported usage across that reply's internal
   * tool-call rounds. Requires the installed Copilot Chat build to supply
   * private, unstable per-request identity fields — silently does nothing
   * (no line, no error) when they're absent. See replyTokenUsage.ts.
   */
  showReplyTokenUsage: boolean;
  /**
   * Name of an HTTP header carrying a per-conversation session id, sent on
   * every chat-completions request so gateways can pin the conversation to
   * one backend (LiteLLM `session_affinity` reads `x-litellm-session-id`).
   * Empty disables the header. See replyTokenUsage.ts for the identity
   * source and its fail-closed contract.
   */
  sessionAffinityHeader: string;
  /**
   * Path of the gateway's daily-usage endpoint, joined onto `serverUrl`.
   * Empty disables the status-bar quota display. Servers without the
   * endpoint answer 404 once and the display stays hidden.
   */
  usageEndpoint: string;
  /** Seconds between background usage polls; 0 polls only after requests / on refresh. */
  usageRefreshInterval: number;
  /** Remaining-quota percent at or below which the status bar turns yellow. */
  usageWarningPercent: number;
  /** Remaining-quota percent at or below which the status bar turns red. */
  usageCriticalPercent: number;
  /** Stop a streamed response once it degenerates into an exact repeating cycle. */
  loopGuardRepetition: boolean;
  /** Master switch for the tool-call loop guard (nudge and block). */
  loopGuardToolCalls: boolean;
  /** Warn the model after this many tool rounds repeating the same call or short cycle (same arguments, same results); 0 = off. */
  loopGuardToolNudgeAfter: number;
  /** Withhold a repeat of the looping call(s) after this many such rounds; 0 = off. */
  loopGuardToolBlockAfter: number;
  /**
   * Send earlier reasoning back as `reasoning_content` on assistant history
   * messages (current turn's tool-call rounds only — that is all Copilot Chat
   * replays). Required by DeepSeek thinking mode with tools; off by default
   * because some servers reject the unknown field.
   */
  replayReasoning: boolean;
}
