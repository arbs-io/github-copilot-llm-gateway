import { GatewayConfig } from '../config/gatewayConfig';
import { TOKEN_CONSTANTS } from '../chat/tokenBudget';

export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
/** Maximum value for setTimeout (signed 32-bit integer). */
export const MAX_REQUEST_TIMEOUT_MS = 2147483647;
export const FALLBACK_SERVER_URL = 'http://localhost:8000';

/**
 * Problems found (and auto-corrected) while validating a raw config. The
 * config service maps these onto log lines and de-duplicated toasts; keeping
 * them as data makes the validation rules unit-testable without `vscode`.
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
  } else if (cfg.requestTimeout > MAX_REQUEST_TIMEOUT_MS) {
    issues.push({ kind: 'requestTimeoutClamped', value: cfg.requestTimeout });
    cfg.requestTimeout = MAX_REQUEST_TIMEOUT_MS;
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

  // Strict opt-in: a stray non-boolean in settings.json (e.g. "true") must
  // not start adding a field that some servers reject.
  cfg.replayReasoning = cfg.replayReasoning === true;
  cfg.replayReasoningModels = keepBooleanEntries(cfg.replayReasoningModels);

  return { config: cfg, issues };
}

/** Drop entries whose value isn't a real boolean (e.g. `"true"`), so they fall back to the global switch. */
function keepBooleanEntries(map: unknown): Record<string, boolean> {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(map).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
  );
}
