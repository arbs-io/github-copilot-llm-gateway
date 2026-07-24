import * as vscode from 'vscode';
import { GatewayConfig } from '../config/gatewayConfig';
import { TOKEN_CONSTANTS } from '../chat/tokenBudget';
import {
  ConfigIssue,
  DEFAULT_MAX_AGENT_INPUT_TOKENS,
  DEFAULT_MAX_CONSECUTIVE_TOOL_CALLS,
  DEFAULT_MAX_REPEATED_TOOL_CALL_COUNT,
  DEFAULT_MAX_TOOL_RESULT_CHARACTERS,
  DEFAULT_MAX_TOOL_SCHEMA_TOKENS,
  DEFAULT_MAX_TOOLS_PER_REQUEST,
  DEFAULT_OPERATING_PROFILE,
  DEFAULT_PINNED_TOOLS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  FALLBACK_SERVER_URL,
  MAX_REQUEST_TIMEOUT_MS,
  validateGatewayConfig,
} from './configValidation';

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
  private invalidUrlNotified = false;
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
      streamIdleTimeout: config.get<number>(
        'streamIdleTimeout',
        DEFAULT_STREAM_IDLE_TIMEOUT_MS
      ),
      defaultMaxTokens: config.get<number>('defaultMaxTokens', TOKEN_CONSTANTS.DEFAULT_CONTEXT_TOKENS),
      defaultMaxOutputTokens: config.get<number>(
        'defaultMaxOutputTokens',
        TOKEN_CONSTANTS.FALLBACK_OUTPUT_TOKENS
      ),
      maxAgentInputTokens: config.get<number>(
        'maxAgentInputTokens',
        DEFAULT_MAX_AGENT_INPUT_TOKENS
      ),
      enableImageInput: config.get<boolean>('enableImageInput', true),
      enableToolCalling: config.get<boolean>('enableToolCalling', true),
      parallelToolCalling: config.get<boolean>('parallelToolCalling', true),
      agentTemperature: config.get<number>('agentTemperature', 0),
      operatingProfile: config.get<GatewayConfig['operatingProfile']>(
        'operatingProfile',
        DEFAULT_OPERATING_PROFILE
      ),
      pinnedTools: config.get<string[]>('pinnedTools', [...DEFAULT_PINNED_TOOLS]),
      verboseDiagnostics: config.get<boolean>('verboseDiagnostics', false),
      maxToolsPerRequest: config.get<number>(
        'maxToolsPerRequest',
        DEFAULT_MAX_TOOLS_PER_REQUEST
      ),
      maxToolSchemaTokens: config.get<number>(
        'maxToolSchemaTokens',
        DEFAULT_MAX_TOOL_SCHEMA_TOKENS
      ),
      maxToolResultCharacters: config.get<number>(
        'maxToolResultCharacters',
        DEFAULT_MAX_TOOL_RESULT_CHARACTERS
      ),
      maxConsecutiveToolCalls: config.get<number>(
        'maxConsecutiveToolCalls',
        DEFAULT_MAX_CONSECUTIVE_TOOL_CALLS
      ),
      maxRepeatedToolCallCount: config.get<number>(
        'maxRepeatedToolCallCount',
        DEFAULT_MAX_REPEATED_TOOL_CALL_COUNT
      ),
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
      this.invalidUrlNotified = false;
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
            `WARNING: requestTimeout (${issue.value}) exceeds the maximum value of ${MAX_REQUEST_TIMEOUT_MS} ms (signed 32-bit integer). Setting to ${MAX_REQUEST_TIMEOUT_MS}.`
          );
          break;
        case 'invalidServerUrl':
          this.reportInvalidUrl();
          break;
        case 'invalidIntegerSetting':
          this.deps.log(
            `WARNING: ${issue.setting} must be an integer >= ${issue.minimum}; using ${issue.fallback}.`
          );
          break;
        case 'invalidOperatingProfile':
          this.deps.log(
            `WARNING: operatingProfile ${JSON.stringify(issue.value)} is invalid; using ${DEFAULT_OPERATING_PROFILE}.`
          );
          break;
        case 'invalidPinnedTools':
          this.deps.log(
            'WARNING: pinnedTools contained no usable tool names; using the default tool set.'
          );
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

  private reportInvalidUrl(): void {
    this.deps.log(
      `ERROR: Invalid server URL. Falling back to ${FALLBACK_SERVER_URL}; fix this in settings.`
    );
    if (!this.invalidUrlNotified) {
      this.invalidUrlNotified = true;
      setImmediate(() => {
        this.deps.promptOpenSettings(
          'GitHub Copilot LLM Gateway: Invalid Server URL. Open Settings to fix.'
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
