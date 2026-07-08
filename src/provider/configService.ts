import * as vscode from 'vscode';
import { GatewayConfig } from '../config/gatewayConfig';
import { TOKEN_CONSTANTS } from '../chat/tokenBudget';

export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
/** Maximum value for setTimeout (signed 32-bit integer). */
const MAX_INT32 = 2147483647;
const FALLBACK_SERVER_URL = 'http://localhost:8000';

/**
 * Problems found (and auto-corrected) while validating a raw config. The
 * service maps these onto log lines and de-duplicated toasts; keeping them
 * as data makes the validation rules unit-testable without `vscode`.
 */
export type ConfigIssue =
  | { kind: 'invalidRequestTimeout'; value: number }
  | { kind: 'requestTimeoutClamped'; value: number }
  | { kind: 'invalidServerUrl'; url: string }
  | { kind: 'outputTokensAdjusted'; output: number; total: number; adjusted: number };

/**
 * Validate a raw config and auto-correct invalid values. Pure — returns the
 * corrected config plus the list of issues found so the caller can decide
 * how to surface them.
 */
export function validateGatewayConfig(raw: GatewayConfig): {
  config: GatewayConfig;
  issues: ConfigIssue[];
} {
  const cfg: GatewayConfig = { ...raw };
  const issues: ConfigIssue[] = [];

  if (cfg.requestTimeout <= 0) {
    issues.push({ kind: 'invalidRequestTimeout', value: cfg.requestTimeout });
    cfg.requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS;
  } else if (cfg.requestTimeout > MAX_INT32) {
    issues.push({ kind: 'requestTimeoutClamped', value: cfg.requestTimeout });
    cfg.requestTimeout = MAX_INT32;
  }

  try {
    new URL(cfg.serverUrl);
  } catch {
    issues.push({ kind: 'invalidServerUrl', url: cfg.serverUrl });
    cfg.serverUrl = FALLBACK_SERVER_URL;
  }

  if (cfg.defaultMaxOutputTokens >= cfg.defaultMaxTokens) {
    const adjusted = Math.max(
      TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS,
      cfg.defaultMaxTokens - TOKEN_CONSTANTS.ADJUST_TOKEN_BUFFER
    );
    issues.push({
      kind: 'outputTokensAdjusted',
      output: cfg.defaultMaxOutputTokens,
      total: cfg.defaultMaxTokens,
      adjusted,
    });
    cfg.defaultMaxOutputTokens = adjusted;
  }

  return { config: cfg, issues };
}

interface ConfigServiceDeps {
  /** Resolved API key — framework override wins over the SecretStorage cache. */
  getApiKey: () => string;
  /** Custom headers snapshot from the SecretStorage cache. */
  getCustomHeaders: () => Record<string, string>;
  log: (message: string) => void;
  promptOpenSettings: (message: string) => void;
}

/**
 * Reads the extension's workspace settings into a validated `GatewayConfig`.
 *
 * `apiKey` and `customHeaders` come from the in-memory secret cache
 * populated by the secrets manager. The legacy plain-text settings of the
 * same name are still read by the migration path, but are cleared once
 * their values are safely in SecretStorage (issue #28). Until the secrets
 * load, the cache holds empty values — an early model fetch would just send
 * unauthenticated requests.
 *
 * Owns the notification-dedupe state so the user isn't toasted on every
 * keystroke while editing a value in the settings UI.
 */
export class ConfigService {
  /** Tracks the last values we warned about, to avoid notification spam on each keystroke in the settings UI. */
  private lastInvalidUrlNotified?: string;
  private lastOutputTokenAdjustmentNotified?: { output: number; total: number };

  constructor(private readonly deps: ConfigServiceDeps) {}

  public load(): GatewayConfig {
    const { config, issues } = validateGatewayConfig(this.readRawConfig());
    this.reportIssues(issues);
    return config;
  }

  private readRawConfig(): GatewayConfig {
    const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
    return {
      serverUrl: config.get<string>('serverUrl', FALLBACK_SERVER_URL),
      apiKey: this.deps.getApiKey(),
      requestTimeout: config.get<number>('requestTimeout', DEFAULT_REQUEST_TIMEOUT_MS),
      defaultMaxTokens: config.get<number>('defaultMaxTokens', TOKEN_CONSTANTS.DEFAULT_CONTEXT_TOKENS),
      defaultMaxOutputTokens: config.get<number>(
        'defaultMaxOutputTokens',
        TOKEN_CONSTANTS.FALLBACK_OUTPUT_TOKENS
      ),
      enableImageInput: config.get<boolean>('enableImageInput', true),
      enableToolCalling: config.get<boolean>('enableToolCalling', true),
      parallelToolCalling: config.get<boolean>('parallelToolCalling', true),
      agentTemperature: config.get<number>('agentTemperature', 0),
      verboseLogging: config.get<boolean>('verboseLogging', false),
      customHeaders: { ...this.deps.getCustomHeaders() },
      extraModelOptions: config.get<Record<string, unknown>>('extraModelOptions', {}) ?? {},
      perModelOptions: config.get<Record<string, unknown>>('perModelOptions', {}) ?? {},
      modelContextWindows: config.get<Record<string, number>>('modelContextWindows', {}) ?? {},
      enableInlineCompletion: config.get<boolean>('enableInlineCompletion', false),
      inlineCompletionModel: config.get<string>('inlineCompletionModel', ''),
      inlineCompletionMaxTokens: config.get<number>('inlineCompletionMaxTokens', 256),
      inlineCompletionDebounce: config.get<number>('inlineCompletionDebounce', 300),
      inlineCompletionTimeout: config.get<number>('inlineCompletionTimeout', 3000),
      inlineCompletionMaxPrefixChars: config.get<number>('inlineCompletionMaxPrefixChars', 4000),
      inlineCompletionMaxSuffixChars: config.get<number>('inlineCompletionMaxSuffixChars', 1000),
    };
  }

  /**
   * Map validation issues onto output-channel lines and (de-duplicated)
   * toasts, and reset the dedupe keys for anything that is now valid so
   * future regressions are re-surfaced.
   */
  private reportIssues(issues: ConfigIssue[]): void {
    const urlIssue = issues.find((i) => i.kind === 'invalidServerUrl');
    if (!urlIssue) {
      // URL became valid — reset the dedupe key so future invalid values are
      // re-surfaced.
      this.lastInvalidUrlNotified = undefined;
    }
    const outputIssue = issues.find((i) => i.kind === 'outputTokensAdjusted');
    if (!outputIssue) {
      // Valid configuration — reset the dedupe key.
      this.lastOutputTokenAdjustmentNotified = undefined;
    }

    for (const issue of issues) {
      switch (issue.kind) {
        case 'invalidRequestTimeout':
          this.deps.log(
            `ERROR: requestTimeout must be > 0; using default ${DEFAULT_REQUEST_TIMEOUT_MS}`
          );
          break;
        case 'requestTimeoutClamped':
          this.deps.log(
            `WARNING: requestTimeout (${issue.value}) exceeds the maximum value of ${MAX_INT32} ms (signed 32-bit integer). Setting to ${MAX_INT32}.`
          );
          break;
        case 'invalidServerUrl':
          this.reportInvalidUrl(issue.url);
          break;
        case 'outputTokensAdjusted':
          this.reportOutputTokensAdjusted(issue);
          break;
        default: {
          const _never: never = issue;
          throw new Error(`Unexpected config issue: ${String(_never)}`);
        }
      }
    }
  }

  private reportInvalidUrl(url: string): void {
    this.deps.log(
      `ERROR: Invalid server URL ${JSON.stringify(url)}. Falling back to ${FALLBACK_SERVER_URL}; fix this in settings.`
    );
    // Only surface the UI prompt if we haven't already warned about this
    // exact value — otherwise the user gets a new modal for every keystroke
    // while they're typing a URL in settings.
    if (this.lastInvalidUrlNotified !== url) {
      this.lastInvalidUrlNotified = url;
      setImmediate(() => {
        this.deps.promptOpenSettings(
          `GitHub Copilot LLM Gateway: Invalid Server URL ${JSON.stringify(url)}. Open Settings to fix.`
        );
      });
    }
  }

  private reportOutputTokensAdjusted(
    issue: Extract<ConfigIssue, { kind: 'outputTokensAdjusted' }>
  ): void {
    this.deps.log(
      `WARNING: github.copilot.llm-gateway.defaultMaxOutputTokens (${issue.output}) >= defaultMaxTokens (${issue.total}). Adjusting to ${issue.adjusted}.`
    );
    // Only pop a toast when the values the user is typing actually change,
    // otherwise every keystroke during settings editing produces a warning.
    const last = this.lastOutputTokenAdjustmentNotified;
    if (last?.output !== issue.output || last?.total !== issue.total) {
      this.lastOutputTokenAdjustmentNotified = { output: issue.output, total: issue.total };
      vscode.window.showWarningMessage(
        `GitHub Copilot LLM Gateway: 'defaultMaxOutputTokens' was >= 'defaultMaxTokens'. Adjusted to ${issue.adjusted} to avoid request errors.`
      );
    }
  }
}
