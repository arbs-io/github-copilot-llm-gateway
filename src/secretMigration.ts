/**
 * Helpers for moving the legacy `apiKey` / `customHeaders` settings out of
 * VS Code's plain-text user/workspace configuration and into the per-extension
 * SecretStorage. See issue #28 — users were storing bearer tokens via the
 * `customHeaders` setting (e.g. `Authorization: Bearer ...`), where they sat
 * in `settings.json` indefinitely.
 *
 * The functions in here are kept free of any `vscode` imports so the
 * migration logic can be unit-tested with plain object stand-ins.
 */

/** Keys used in SecretStorage. Mirrors the legacy setting names so logs read clearly. */
export const SECRET_KEYS = {
  apiKey: 'github.copilot.llm-gateway.apiKey',
  customHeaders: 'github.copilot.llm-gateway.customHeaders',
} as const;

/** Subset of `vscode.WorkspaceConfiguration` we use during migration. */
export interface LegacyConfigAccessor {
  get<T>(section: string, defaultValue: T): T;
  inspect<T>(section: string): { workspaceValue?: T; globalValue?: T } | undefined;
  /** Pass `undefined` to remove the value at the given target. */
  update(section: string, value: unknown, target: ConfigurationTarget): Thenable<void> | Promise<void>;
}

/**
 * Mirrors the numeric values of `vscode.ConfigurationTarget` so callers
 * don't need to import `vscode` here (which lets the migration logic be unit
 * tested with no editor stand-ins). The provider's adapter translates these
 * back into real `vscode.ConfigurationTarget` values. PascalCase keys/value
 * to match the editor API exactly.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;
export type ConfigurationTarget = (typeof ConfigurationTarget)[keyof typeof ConfigurationTarget];

/** Subset of `vscode.SecretStorage` we use. */
export interface SecretAccessor {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

export interface MigrationResult {
  /** True when the legacy plain-text apiKey was copied into secrets during this run. */
  apiKeyMigrated: boolean;
  /** True when the legacy plain-text customHeaders were copied into secrets during this run. */
  customHeadersMigrated: boolean;
}

/**
 * Parse the JSON string we stash in SecretStorage back into an object. Bad
 * JSON (or anything that doesn't parse as an object) returns `{}` rather than
 * throwing — a corrupted secret shouldn't crash the extension.
 */
export function parseCustomHeadersJson(
  raw: string | undefined,
  log: (msg: string) => void = () => { /* no-op */ }
): Record<string, string> {
  if (!raw) { return {}; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log(`Failed to parse customHeaders secret JSON: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log('customHeaders secret was not a JSON object; ignoring.');
    return {};
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && name.length > 0) {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Copy any plain-text `apiKey` / `customHeaders` from VS Code settings into
 * SecretStorage and clear the legacy settings. Idempotent — re-runs after the
 * legacy values are already gone are no-ops.
 *
 * Won't overwrite a secret that already has a value: if a user re-adds the
 * legacy setting after migration, we don't want to silently replace a secret
 * they may have already updated via the Configure Server flow.
 */
export async function migrateLegacySecrets(
  config: LegacyConfigAccessor,
  secrets: SecretAccessor,
  log: (msg: string) => void = () => { /* no-op */ }
): Promise<MigrationResult> {
  const result: MigrationResult = { apiKeyMigrated: false, customHeadersMigrated: false };

  const legacyApiKey = (config.get<string>('apiKey', '') ?? '').trim();
  const legacyHeaders = config.get<Record<string, string>>('customHeaders', {}) ?? {};
  const hasLegacyKey = legacyApiKey.length > 0;
  const hasLegacyHeaders = Object.keys(legacyHeaders).length > 0;

  if (!hasLegacyKey && !hasLegacyHeaders) {
    return result;
  }

  if (hasLegacyKey) {
    const existing = await secrets.get(SECRET_KEYS.apiKey);
    if (existing) {
      log('Found legacy apiKey setting but a secret already exists; not overwriting.');
    } else {
      await secrets.store(SECRET_KEYS.apiKey, legacyApiKey);
      result.apiKeyMigrated = true;
      log('Migrated legacy apiKey setting into SecretStorage.');
    }
  }

  if (hasLegacyHeaders) {
    const existing = await secrets.get(SECRET_KEYS.customHeaders);
    if (existing) {
      log('Found legacy customHeaders setting but a secret already exists; not overwriting.');
    } else {
      await secrets.store(SECRET_KEYS.customHeaders, JSON.stringify(legacyHeaders));
      result.customHeadersMigrated = true;
      log(`Migrated ${Object.keys(legacyHeaders).length} legacy customHeaders into SecretStorage.`);
    }
  }

  // Always clear the legacy settings once we know the value is safely captured —
  // either by this migration run or by a previous one. Leaving the plain-text
  // value behind would defeat the whole point of the move.
  if (hasLegacyKey) {
    await clearLegacySetting(config, 'apiKey');
  }
  if (hasLegacyHeaders) {
    await clearLegacySetting(config, 'customHeaders');
  }

  return result;
}

/**
 * Remove `section` from whichever configuration scopes currently hold a
 * concrete value. We touch both Workspace and Global so users don't have a
 * forgotten copy lingering in one scope after migration.
 */
async function clearLegacySetting(
  config: LegacyConfigAccessor,
  section: string
): Promise<void> {
  const inspection = config.inspect(section);
  if (inspection?.workspaceValue !== undefined) {
    await config.update(section, undefined, ConfigurationTarget.Workspace);
  }
  if (inspection?.globalValue !== undefined) {
    await config.update(section, undefined, ConfigurationTarget.Global);
  }
}

/**
 * Compose the user-facing toast for a successful migration. Returns
 * `undefined` when nothing was migrated, so callers can suppress the
 * notification entirely in that case.
 */
export function formatMigrationToast(result: MigrationResult): string | undefined {
  const moved: string[] = [];
  if (result.apiKeyMigrated) { moved.push('API key'); }
  if (result.customHeadersMigrated) { moved.push('custom headers'); }
  if (moved.length === 0) { return undefined; }
  return `LLM Gateway: ${moved.join(' and ')} moved into VS Code's secret storage. Use "Configure Server" to update them.`;
}
