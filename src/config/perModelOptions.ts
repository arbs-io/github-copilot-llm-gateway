/**
 * Resolve per-model chat-completion overrides.
 *
 * `extraModelOptions` applies one flat set of parameters (temperature, top_p,
 * top_k, …) to every model. That breaks down the moment a user switches
 * between model families that want different sampling settings, because most
 * hosted endpoints expect those values from the caller rather than exposing
 * them server-side (issue #43).
 *
 * `perModelOptions` is a map keyed by model id, letting a user pin parameters
 * to specific models. Keys are matched against the model id two ways:
 *
 *  - an exact id (`"Qwen3-32B"`) — highest priority
 *  - a `*` wildcard pattern (`"qwen*"`, `"*-instruct"`) — case-insensitive,
 *    so a single entry can cover a whole family
 *
 * When several entries match a model, wildcard matches are merged first and
 * exact matches last, so an exact-id entry always wins a key collision.
 */

/** A value is only usable as an options bag if it's a plain (non-array) object. */
function isOptionsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build a case-insensitive `RegExp` that matches `modelId` against a pattern
 * containing `*` wildcards. All other characters are matched literally.
 */
function matchesWildcard(pattern: string, modelId: string): boolean {
  const escaped = pattern
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i').test(modelId);
}

/**
 * Collect the chat-completion overrides that apply to `modelId` from the
 * configured `perModelOptions` map. Returns a fresh object (never the stored
 * one) so callers can safely spread it into a request body.
 */
export function resolvePerModelOptions(
  modelId: string,
  perModelOptions: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!perModelOptions) {
    return {};
  }

  const wildcardMatches: Record<string, unknown>[] = [];
  const exactMatches: Record<string, unknown>[] = [];

  for (const [pattern, value] of Object.entries(perModelOptions)) {
    if (!isOptionsObject(value)) {
      continue;
    }
    if (pattern === modelId) {
      exactMatches.push(value);
    } else if (pattern.includes('*') && matchesWildcard(pattern, modelId)) {
      wildcardMatches.push(value);
    }
  }

  // Exact-id entries spread last so they override wildcard family defaults.
  return Object.assign({}, ...wildcardMatches, ...exactMatches);
}
