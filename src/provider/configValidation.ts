import { GatewayConfig } from '../config/gatewayConfig';
import { TOKEN_CONSTANTS } from '../chat/tokenBudget';
import { validateServerUrl } from '../config/serverUrl';

export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120000;
export const DEFAULT_MAX_AGENT_INPUT_TOKENS = 65536;
export const DEFAULT_OPERATING_PROFILE = 'grounded';
export const DEFAULT_PINNED_TOOLS = ['memory'] as const;
export const DEFAULT_MAX_TOOLS_PER_REQUEST = 32;
export const DEFAULT_MAX_TOOL_SCHEMA_TOKENS = 8192;
export const DEFAULT_MAX_TOOL_RESULT_CHARACTERS = 4000;
export const DEFAULT_MAX_CONSECUTIVE_TOOL_CALLS = 16;
export const DEFAULT_MAX_REPEATED_TOOL_CALL_COUNT = 4;
/** Maximum value for setTimeout (signed 32-bit integer). */
export const MAX_REQUEST_TIMEOUT_MS = 2147483647;
export const FALLBACK_SERVER_URL = 'http://localhost:8000';

type ValidatedIntegerSetting =
  | 'streamIdleTimeout'
  | 'maxAgentInputTokens'
  | 'maxToolsPerRequest'
  | 'maxToolSchemaTokens'
  | 'maxToolResultCharacters'
  | 'maxConsecutiveToolCalls'
  | 'maxRepeatedToolCallCount';

/**
 * Problems found (and auto-corrected) while validating a raw config. The
 * config service maps these onto log lines and de-duplicated toasts; keeping
 * them as data makes the validation rules unit-testable without `vscode`.
 */
export type ConfigIssue =
  | { kind: 'invalidRequestTimeout'; value: number }
  | { kind: 'requestTimeoutClamped'; value: number }
  | { kind: 'invalidServerUrl' }
  | {
      kind: 'invalidIntegerSetting';
      setting: ValidatedIntegerSetting;
      value: number;
      fallback: number;
      minimum: number;
    }
  | { kind: 'invalidOperatingProfile'; value: string }
  | { kind: 'invalidPinnedTools' }
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
  } else if (cfg.requestTimeout > MAX_REQUEST_TIMEOUT_MS) {
    issues.push({ kind: 'requestTimeoutClamped', value: cfg.requestTimeout });
    cfg.requestTimeout = MAX_REQUEST_TIMEOUT_MS;
  }

  const serverUrl = validateServerUrl(cfg.serverUrl);
  if (!serverUrl.ok) {
    issues.push({ kind: 'invalidServerUrl' });
    cfg.serverUrl = FALLBACK_SERVER_URL;
  } else {
    cfg.serverUrl = serverUrl.value;
  }

  cfg.streamIdleTimeout = validateIntegerSetting(
    'streamIdleTimeout',
    cfg.streamIdleTimeout,
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    1000,
    issues,
    MAX_REQUEST_TIMEOUT_MS
  );
  cfg.maxAgentInputTokens = validateIntegerSetting(
    'maxAgentInputTokens',
    cfg.maxAgentInputTokens,
    DEFAULT_MAX_AGENT_INPUT_TOKENS,
    256,
    issues
  );
  cfg.maxToolsPerRequest = validateIntegerSetting(
    'maxToolsPerRequest',
    cfg.maxToolsPerRequest,
    DEFAULT_MAX_TOOLS_PER_REQUEST,
    1,
    issues
  );
  cfg.maxToolSchemaTokens = validateIntegerSetting(
    'maxToolSchemaTokens',
    cfg.maxToolSchemaTokens,
    DEFAULT_MAX_TOOL_SCHEMA_TOKENS,
    64,
    issues
  );
  cfg.maxToolResultCharacters = validateIntegerSetting(
    'maxToolResultCharacters',
    cfg.maxToolResultCharacters,
    DEFAULT_MAX_TOOL_RESULT_CHARACTERS,
    256,
    issues
  );
  cfg.maxConsecutiveToolCalls = validateIntegerSetting(
    'maxConsecutiveToolCalls',
    cfg.maxConsecutiveToolCalls,
    DEFAULT_MAX_CONSECUTIVE_TOOL_CALLS,
    1,
    issues
  );
  cfg.maxRepeatedToolCallCount = validateIntegerSetting(
    'maxRepeatedToolCallCount',
    cfg.maxRepeatedToolCallCount,
    DEFAULT_MAX_REPEATED_TOOL_CALL_COUNT,
    1,
    issues
  );

  if (
    cfg.operatingProfile !== 'grounded' &&
    cfg.operatingProfile !== 'balanced' &&
    cfg.operatingProfile !== 'aggressive'
  ) {
    issues.push({ kind: 'invalidOperatingProfile', value: String(cfg.operatingProfile) });
    cfg.operatingProfile = DEFAULT_OPERATING_PROFILE;
  }

  const rawPinnedTools: unknown = cfg.pinnedTools;
  const pinnedTools = Array.isArray(rawPinnedTools)
    ? [...new Set(rawPinnedTools
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0))]
    : [];
  if (
    pinnedTools.length === 0 ||
    !Array.isArray(rawPinnedTools) ||
    pinnedTools.length !== rawPinnedTools.length
  ) {
    issues.push({ kind: 'invalidPinnedTools' });
  }
  cfg.pinnedTools = pinnedTools.length > 0 ? pinnedTools : [...DEFAULT_PINNED_TOOLS];

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

function validateIntegerSetting(
  setting: ValidatedIntegerSetting,
  value: number,
  fallback: number,
  minimum: number,
  issues: ConfigIssue[],
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (Number.isSafeInteger(value) && value >= minimum && value <= maximum) {
    return value;
  }

  issues.push({
    kind: 'invalidIntegerSetting',
    setting,
    value,
    fallback,
    minimum,
  });
  return fallback;
}
