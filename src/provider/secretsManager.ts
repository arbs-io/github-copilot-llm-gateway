import * as vscode from 'vscode';
import {
  ConfigurationTarget as SecretConfigurationTarget,
  LegacyConfigAccessor,
  SECRET_KEYS,
  formatMigrationToast,
  migrateLegacySecrets,
  parseCustomHeadersJson,
} from '../config/secretMigration';

export interface SecretCache {
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
    return key === SECRET_KEYS.apiKey || key === SECRET_KEYS.customHeaders;
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
