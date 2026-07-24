/**
 * Helpers for the framework-managed `configuration` object VS Code passes into
 * `provideLanguageModelChatInformation`. The configuration is populated from
 * the JSON schema declared under
 * `contributes.languageModelChatProviders[].configuration` in package.json,
 * including any properties marked `"secret": true` (which VS Code stores
 * itself instead of asking the provider to manage SecretStorage).
 *
 * Kept here as a pure module so the precedence logic can be unit-tested.
 */

export interface FrameworkConfigOverride {
  /**
   * API key supplied via the framework UI. Empty string is meaningful — it
   * represents an explicit "no key" choice from the user that should override
   * any value still stashed in SecretStorage from a previous Configure Server
   * run.
   */
  apiKey?: string;
}

/**
 * Read the `apiKey` (if any) out of the framework-supplied configuration.
 *
 * Non-string values, unrelated keys, and a missing configuration all yield
 * `{}` — there is no override and the existing SecretStorage path applies.
 *
 * `serverUrl` is intentionally not extracted: keeping it in the workspace
 * settings preserves the per-window scope picker (issue #23) that lets
 * different VS Code windows point at different inference servers.
 */
export function readFrameworkConfiguration(
  configuration: { readonly [key: string]: unknown } | undefined | null
): FrameworkConfigOverride {
  if (!configuration || typeof configuration !== 'object') {
    return {};
  }
  const result: FrameworkConfigOverride = {};
  const apiKey = (configuration as { apiKey?: unknown }).apiKey;
  if (typeof apiKey === 'string') {
    result.apiKey = apiKey;
  }
  return result;
}

/**
 * Choose which API key to send with requests. The framework override wins when
 * set, except that a non-empty global framework key is withheld when a
 * workspace/folder controls the server URL. An explicit empty string still
 * wins so clearing the native UI cannot silently restore a stale credential.
 * Otherwise the already origin-filtered SecretStorage cache is used.
 */
export function resolveApiKey(
  override: FrameworkConfigOverride,
  secretCacheApiKey: string,
  hasWorkspaceServerOverride = false
): string {
  if (override.apiKey !== undefined) {
    // VS Code owns storage for this value but exposes no server-origin
    // metadata. A workspace can control serverUrl, so never forward a
    // framework-global credential to a workspace/folder override.
    if (hasWorkspaceServerOverride && override.apiKey.length > 0) {
      return '';
    }
    return override.apiKey;
  }
  return secretCacheApiKey;
}
