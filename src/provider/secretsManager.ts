import * as vscode from 'vscode';
import {
  ConfigurationTarget as SecretConfigurationTarget,
  LegacyConfigAccessor,
  SECRET_KEYS,
  formatMigrationToast,
  migrateLegacySecrets,
  parseCustomHeadersJson,
} from '../config/secretMigration';
import { DEFAULT_BACKEND_NAME } from '../config/backendConfig';

export interface SecretCache {
  apiKey: string;
  customHeaders: Record<string, string>;
}

/**
 * Per-backend secret cache. Each backend name maps to its own API key and
 * custom headers. The un-prefixed "default" backend uses the legacy global
 * secrets for backward compatibility.
 */
export interface BackendSecretCache {
  apiKey: string;
  customHeaders: Record<string, string>;
}

interface SecretsManagerDeps {
  log: (message: string) => void;
  /** Fired after the cache changes so the owner can reload its config. */
  onDidUpdate: () => void;
}

/**
 * Owns the in-memory snapshot of secret values read from
 * `vscode.ExtensionContext.secrets`. Config loading is synchronous (called
 * from the provider constructor and every config-change event), so the
 * secret values are cached here and refreshed via `loadSecrets` /
 * `setApiKey` / `setCustomHeaders` instead of hitting SecretStorage on
 * every read. Also owns the one-time migration of legacy plain-text
 * settings into SecretStorage (issue #28).
 */
export class SecretsManager {
  private cache: SecretCache = { apiKey: '', customHeaders: {} };

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly deps: SecretsManagerDeps
  ) {}

  public getCache(): SecretCache {
    return this.cache;
  }

  /** Snapshot of the cached custom headers — used by the Edit flow. */
  public getCustomHeadersSnapshot(): Record<string, string> {
    return { ...this.cache.customHeaders };
  }

  /**
   * Called from `extension.activate` so the first chat request uses the
   * right credentials. Performs one-time migration of legacy plain-text
   * settings into SecretStorage and surfaces a single toast if anything was
   * actually moved.
   */
  public async loadSecrets(): Promise<void> {
    try {
      const result = await migrateLegacySecrets(
        this.legacyConfigAccessor(),
        this.secrets,
        this.deps.log
      );
      const toast = formatMigrationToast(result);
      if (toast) {
        vscode.window.showInformationMessage(toast);
      }
    } catch (error) {
      this.deps.log(
        `Failed to migrate legacy secrets: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    await this.refreshCache();
  }

  /**
   * Persist a new API key in SecretStorage and refresh the cache. Pass `''`
   * to clear the stored key. Called from the Configure Server command.
   */
  public async setApiKey(apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (trimmed.length === 0) {
      await this.secrets.delete(SECRET_KEYS.apiKey);
    } else {
      await this.secrets.store(SECRET_KEYS.apiKey, trimmed);
    }
    // `onDidChange` will repopulate the cache, but we also refresh
    // synchronously so callers can immediately use the new value.
    await this.refreshCache();
  }

  /**
   * Persist a new customHeaders map in SecretStorage and refresh the cache.
   * Pass `{}` to clear the stored headers. Called from the Edit Custom
   * Headers command.
   */
  public async setCustomHeaders(headers: Record<string, string>): Promise<void> {
    if (Object.keys(headers).length === 0) {
      await this.secrets.delete(SECRET_KEYS.customHeaders);
    } else {
      await this.secrets.store(SECRET_KEYS.customHeaders, JSON.stringify(headers));
    }
    await this.refreshCache();
  }

  /**
   * Re-read both secrets into the cache and notify the owner. Also invoked
   * when another VS Code window updates a secret (via the owner's
   * `onDidChange` subscription).
   */
  public async refreshCache(): Promise<void> {
    const apiKey = await this.secrets.get(SECRET_KEYS.apiKey);
    const headersJson = await this.secrets.get(SECRET_KEYS.customHeaders);
    this.cache = {
      apiKey: apiKey ?? '',
      customHeaders: parseCustomHeadersJson(headersJson, this.deps.log),
    };
    this.deps.onDidUpdate();
  }

  /** True when the changed secret key belongs to this extension. */
  public ownsSecretKey(key: string): boolean {
    return key === SECRET_KEYS.apiKey || key === SECRET_KEYS.customHeaders
      || key.startsWith(SECRET_KEYS.apiKey + ':')
      || key.startsWith(SECRET_KEYS.customHeaders + ':');
  }

  // ---------- per-backend secrets ----------

  /**
   * SecretStorage key for a named backend's API key. The "default" backend
   * uses the un-suffixed global key for backward compatibility.
   */
  private backendApiKeyKey(backendName: string): string {
    if (backendName === DEFAULT_BACKEND_NAME) {
      return SECRET_KEYS.apiKey;
    }
    return `${SECRET_KEYS.apiKey}:${backendName}`;
  }

  /**
   * SecretStorage key for a named backend's custom headers.
   */
  private backendCustomHeadersKey(backendName: string): string {
    if (backendName === DEFAULT_BACKEND_NAME) {
      return SECRET_KEYS.customHeaders;
    }
    return `${SECRET_KEYS.customHeaders}:${backendName}`;
  }

  /**
   * Get the API key for a specific backend. Falls back to the global key
   * for the "default" backend.
   */
  public async getBackendApiKey(backendName: string): Promise<string> {
    const key = await this.secrets.get(this.backendApiKeyKey(backendName));
    return key ?? '';
  }

  /**
   * Get the custom headers for a specific backend.
   */
  public async getBackendCustomHeaders(backendName: string): Promise<Record<string, string>> {
    const json = await this.secrets.get(this.backendCustomHeadersKey(backendName));
    return parseCustomHeadersJson(json, this.deps.log);
  }

  /**
   * Store an API key for a specific named backend.
   */
  public async setBackendApiKey(backendName: string, apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    const key = this.backendApiKeyKey(backendName);
    if (trimmed.length === 0) {
      await this.secrets.delete(key);
    } else {
      await this.secrets.store(key, trimmed);
    }
    await this.refreshCache();
  }

  /**
   * Store custom headers for a specific named backend.
   */
  public async setBackendCustomHeaders(backendName: string, headers: Record<string, string>): Promise<void> {
    const key = this.backendCustomHeadersKey(backendName);
    if (Object.keys(headers).length === 0) {
      await this.secrets.delete(key);
    } else {
      await this.secrets.store(key, JSON.stringify(headers));
    }
    await this.refreshCache();
  }

  /**
   * Delete all secrets for a named backend (API key + custom headers).
   * Called when a backend is removed from the configuration.
   */
  public async deleteBackendSecrets(backendName: string): Promise<void> {
    await this.secrets.delete(this.backendApiKeyKey(backendName));
    await this.secrets.delete(this.backendCustomHeadersKey(backendName));
    await this.refreshCache();
  }

  /**
   * Re-run the legacy-settings migration. Called when a deprecated
   * plain-text secret setting gains a value (manually typed into
   * settings.json or pasted via the settings UI) so it's pulled back into
   * SecretStorage and the plain-text copy cleared. No toast on this path —
   * the user is actively editing settings and a popup mid-keystroke is
   * jarring; the output channel line is enough for diagnostics.
   */
  public async reMigrateLegacySecrets(): Promise<void> {
    try {
      const result = await migrateLegacySecrets(
        this.legacyConfigAccessor(),
        this.secrets,
        this.deps.log
      );
      if (result.apiKeyMigrated || result.customHeadersMigrated) {
        await this.refreshCache();
      }
    } catch (error) {
      this.deps.log(
        `Failed to re-migrate legacy secret setting: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Adapter from `vscode.WorkspaceConfiguration` to the
   * `LegacyConfigAccessor` interface the migration helpers expect. Done as a
   * small wrapper so the migration logic can be unit-tested without `vscode`.
   */
  private legacyConfigAccessor(): LegacyConfigAccessor {
    const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
    return {
      get: <T>(section: string, defaultValue: T): T => config.get<T>(section, defaultValue),
      inspect: <T>(section: string) => {
        const inspection = config.inspect<T>(section);
        if (!inspection) { return undefined; }
        return {
          workspaceValue: inspection.workspaceValue,
          globalValue: inspection.globalValue,
        };
      },
      update: async (section: string, value: unknown, target: SecretConfigurationTarget) => {
        const vsTarget =
          target === SecretConfigurationTarget.Workspace
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
        await config.update(section, value, vsTarget);
      },
    };
  }
}
