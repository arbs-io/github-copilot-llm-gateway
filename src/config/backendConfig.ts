/**
 * Per-backend profile configuration and resolution logic for multi-backend
 * support. When the user configures `github.copilot.llm-gateway.backends`,
 * each entry becomes a `BackendProfile` that downstream components use to
 * build a `GatewayClient` / `ModelCatalog` pair.
 *
 * When `backends` is empty or unset, a single implicit "default" profile is
 * synthesized from the top-level `serverUrl` / `requestTimeout` / etc.
 * settings so the extension remains backward-compatible with zero migration.
 */

/**
 * Per-backend settings. Each named profile in the `backends` configuration
 * object resolves to one of these.
 */
export interface BackendProfile {
  /** Unique backend name (the object key from settings). */
  readonly name: string;
  /** Inference server URL (OpenAI-compatible endpoint). */
  readonly serverUrl: string;
  /** Request timeout in milliseconds — falls back to global. */
  readonly requestTimeout: number;
  /** Fallback context window size (input tokens) when the server doesn't report it. */
  readonly defaultMaxTokens: number;
  /** Fallback maximum output tokens. */
  readonly defaultMaxOutputTokens: number;
  /** Extra parameters merged into the chat-completions request body. */
  readonly extraModelOptions: Record<string, unknown>;
  /** Per-model chat-completion parameters, keyed by model id / wildcard. */
  readonly perModelOptions: Record<string, unknown>;
  /** Per-model context-window overrides (total tokens). */
  readonly modelContextWindows: Record<string, number>;
}

/** Delimiter used to prefix model IDs: `backendName::modelId`. */
export const BACKEND_DELIMITER = '::';

/**
 * The name assigned to the implicit single-server backend when the `backends`
 * setting is not configured.
 */
export const DEFAULT_BACKEND_NAME = 'default';

/**
 * Raw backend entry as typed by the user in `settings.json`. All fields
 * except `serverUrl` are optional and fall back to the global config.
 */
export interface RawBackendEntry {
  serverUrl?: string;
  requestTimeout?: number;
  defaultMaxTokens?: number;
  defaultMaxOutputTokens?: number;
  extraModelOptions?: Record<string, unknown>;
  perModelOptions?: Record<string, unknown>;
  modelContextWindows?: Record<string, number>;
}

export interface ResolveBackendProfilesInput {
  /** Raw `backends` setting value (may be undefined/empty). */
  backends: Record<string, RawBackendEntry> | undefined;
  /** Global fallbacks from top-level settings. */
  globalServerUrl: string;
  globalRequestTimeout: number;
  globalDefaultMaxTokens: number;
  globalDefaultMaxOutputTokens: number;
  globalExtraModelOptions: Record<string, unknown>;
  globalPerModelOptions: Record<string, unknown>;
  globalModelContextWindows: Record<string, number>;
}

/**
 * Resolve the configured backend profiles. When `backends` is empty/unset,
 * returns a single implicit "default" profile built from the global settings.
 * When `backends` is set, each entry is resolved using global values as
 * fallbacks.
 */
export function resolveBackendProfiles(input: ResolveBackendProfilesInput): BackendProfile[] {
  const {
    backends,
    globalServerUrl,
    globalRequestTimeout,
    globalDefaultMaxTokens,
    globalDefaultMaxOutputTokens,
    globalExtraModelOptions,
    globalPerModelOptions,
    globalModelContextWindows,
  } = input;

  if (!backends || Object.keys(backends).length === 0) {
    // No multi-backend config — synthesize a single implicit profile.
    return [
      {
        name: DEFAULT_BACKEND_NAME,
        serverUrl: globalServerUrl,
        requestTimeout: globalRequestTimeout,
        defaultMaxTokens: globalDefaultMaxTokens,
        defaultMaxOutputTokens: globalDefaultMaxOutputTokens,
        extraModelOptions: globalExtraModelOptions,
        perModelOptions: globalPerModelOptions,
        modelContextWindows: globalModelContextWindows,
      },
    ];
  }

  const profiles: BackendProfile[] = [];
  for (const [name, entry] of Object.entries(backends)) {
    if (!name || typeof entry !== 'object' || entry === null) {
      continue;
    }
    profiles.push({
      name,
      serverUrl: typeof entry.serverUrl === 'string' && entry.serverUrl.length > 0
        ? entry.serverUrl
        : globalServerUrl,
      requestTimeout: typeof entry.requestTimeout === 'number'
        ? entry.requestTimeout
        : globalRequestTimeout,
      defaultMaxTokens: typeof entry.defaultMaxTokens === 'number'
        ? entry.defaultMaxTokens
        : globalDefaultMaxTokens,
      defaultMaxOutputTokens: typeof entry.defaultMaxOutputTokens === 'number'
        ? entry.defaultMaxOutputTokens
        : globalDefaultMaxOutputTokens,
      extraModelOptions: entry.extraModelOptions ?? globalExtraModelOptions,
      perModelOptions: entry.perModelOptions ?? globalPerModelOptions,
      modelContextWindows: entry.modelContextWindows ?? globalModelContextWindows,
    });
  }

  return profiles;
}

/**
 * Prefix a raw model ID with the backend name when multiple backends are
 * active. Returns the raw model ID unprefixed when only a single backend
 * exists (backward compatibility).
 */
export function prefixModelId(backendName: string, modelId: string, multiBackend: boolean): string {
  if (!multiBackend) {
    return modelId;
  }
  return `${backendName}${BACKEND_DELIMITER}${modelId}`;
}

/**
 * Split a prefixed model ID into backend name and raw model ID.
 * When the ID contains no delimiter (single-backend mode or legacy), returns
 * `undefined` for the backend name — callers should fall back to the default.
 */
export function splitModelId(
  prefixedId: string,
  knownBackends: ReadonlySet<string>
): { backendName: string | undefined; rawModelId: string } {
  const idx = prefixedId.indexOf(BACKEND_DELIMITER);
  if (idx < 0) {
    return { backendName: undefined, rawModelId: prefixedId };
  }
  const candidate = prefixedId.substring(0, idx);
  if (knownBackends.has(candidate)) {
    return { backendName: candidate, rawModelId: prefixedId.substring(idx + BACKEND_DELIMITER.length) };
  }
  // The `::` wasn't a backend prefix — it's part of the model name.
  return { backendName: undefined, rawModelId: prefixedId };
}
