import type { CancellationToken, LanguageModelChatInformation } from 'vscode';
import { GatewayClient } from '../api/client';
import { GatewayConfig } from '../config/gatewayConfig';
import {
  BackendProfile,
  prefixModelId,
  splitModelId,
} from '../config/backendConfig';
import { ModelCatalog } from './modelCatalog';
import { OllamaDiscovery } from '../discovery/ollamaDiscovery';
import { SecretsManager } from './secretsManager';

/**
 * A fully constructed backend instance: one inference server with its own
 * client, model catalog, and discovery probe.
 */
export interface BackendInstance {
  readonly name: string;
  readonly profile: BackendProfile;
  readonly client: GatewayClient;
  readonly catalog: ModelCatalog;
  readonly discovery: OllamaDiscovery;
  /** Resolved API key (cached from SecretStorage). */
  apiKey: string;
  /** Resolved custom headers (cached from SecretStorage). */
  customHeaders: Record<string, string>;
}

/**
 * Connection state for a single backend (used by the status bar tooltip).
 */
export interface BackendConnectionInfo {
  readonly name: string;
  readonly serverUrl: string;
  readonly state: 'ok' | 'error' | 'unknown' | 'noModels';
  readonly errorMessage?: string;
  readonly modelCount: number;
  readonly lastSuccessfulFetchAt?: number;
}

export interface BackendRegistryDeps {
  getConfig: () => GatewayConfig;
  secretsManager: SecretsManager;
  log: (message: string) => void;
  onStatusChanged: () => void;
}

/**
 * Manages N backend instances, one per configured backend profile. Provides
 * aggregated model lists (with backend prefixes when multi-backend) and
 * routes model-specific operations to the correct client/catalog.
 *
 * The registry rebuilds its instances when `rebuild()` is called (config
 * change, secret update). Individual backends can be refreshed independently
 * via `invalidateCache()`.
 */
export class BackendRegistry {
  private instances: Map<string, BackendInstance> = new Map();
  /**
   * Maps each model ID (as exposed to VS Code) back to the backend name
   * that owns it. Rebuilt on every `getAggregatedModels` call. Non-colliding
   * IDs are mapped unprefixed; colliding ones use the `backend::model` form.
   */
  private modelToBackend: Map<string, string> = new Map();
  private readonly deps: BackendRegistryDeps;

  constructor(deps: BackendRegistryDeps) {
    this.deps = deps;
  }

  /**
   * Rebuild all backend instances from the current config. Called on
   * initialization and whenever the configuration changes.
   */
  public async rebuild(): Promise<void> {
    const config = this.deps.getConfig();
    const profiles = config.backendProfiles;
    const newInstances = new Map<string, BackendInstance>();

    for (const profile of profiles) {
      // Reuse existing instance if the backend name + URL haven't changed
      const existing = this.instances.get(profile.name);
      if (
        existing &&
        existing.profile.serverUrl === profile.serverUrl
      ) {
        // Update the profile reference for changed non-URL settings
        (existing as { profile: BackendProfile }).profile = profile;
        // Refresh secrets
        existing.apiKey = await this.deps.secretsManager.getBackendApiKey(profile.name);
        existing.customHeaders = await this.deps.secretsManager.getBackendCustomHeaders(profile.name);
        // Update the client config
        existing.client.updateConfig(this.buildClientConfig(profile, existing.apiKey, existing.customHeaders));
        newInstances.set(profile.name, existing);
      } else {
        // Create new instance
        const apiKey = await this.deps.secretsManager.getBackendApiKey(profile.name);
        const customHeaders = await this.deps.secretsManager.getBackendCustomHeaders(profile.name);
        const clientConfig = this.buildClientConfig(profile, apiKey, customHeaders);
        const client = new GatewayClient(clientConfig, this.deps.log);
        const discovery = new OllamaDiscovery({ client, log: this.deps.log });
        const catalog = new ModelCatalog({
          client,
          discovery,
          getConfig: () => this.buildCatalogConfig(profile),
          log: this.deps.log,
          onStatusChanged: () => this.deps.onStatusChanged(),
        });
        newInstances.set(profile.name, {
          name: profile.name,
          profile,
          client,
          catalog,
          discovery,
          apiKey,
          customHeaders,
        });
      }
    }

    this.instances = newInstances;
  }

  /**
   * Build a `GatewayConfig`-shaped object for the `GatewayClient`. The
   * client only reads a subset of the full config.
   */
  private buildClientConfig(
    profile: BackendProfile,
    apiKey: string,
    customHeaders: Record<string, string>
  ): GatewayConfig {
    const globalConfig = this.deps.getConfig();
    return {
      ...globalConfig,
      serverUrl: profile.serverUrl,
      apiKey,
      customHeaders,
      requestTimeout: profile.requestTimeout,
      defaultMaxTokens: profile.defaultMaxTokens,
      defaultMaxOutputTokens: profile.defaultMaxOutputTokens,
      extraModelOptions: profile.extraModelOptions,
      perModelOptions: profile.perModelOptions,
      modelContextWindows: profile.modelContextWindows,
    };
  }

  /**
   * Build the config shape the `ModelCatalog` reads via `getConfig()`.
   */
  private buildCatalogConfig(profile: BackendProfile): GatewayConfig {
    const globalConfig = this.deps.getConfig();
    return {
      ...globalConfig,
      serverUrl: profile.serverUrl,
      requestTimeout: profile.requestTimeout,
      defaultMaxTokens: profile.defaultMaxTokens,
      defaultMaxOutputTokens: profile.defaultMaxOutputTokens,
      extraModelOptions: profile.extraModelOptions,
      perModelOptions: profile.perModelOptions,
      modelContextWindows: profile.modelContextWindows,
    };
  }

  // ---------- model aggregation ----------

  /**
   * Whether multiple backends are configured (controls model ID prefixing).
   */
  public isMultiBackend(): boolean {
    return this.instances.size > 1;
  }

  /** All known backend names. */
  public getBackendNames(): ReadonlySet<string> {
    return new Set(this.instances.keys());
  }

  /** Get a specific backend instance by name. */
  public getInstance(name: string): BackendInstance | undefined {
    return this.instances.get(name);
  }

  /** Get the first (or only) backend instance. */
  public getDefaultInstance(): BackendInstance | undefined {
    const first = this.instances.values().next();
    return first.done ? undefined : first.value;
  }

  /**
   * Fetch models from all backends in parallel and return a unified list.
   * Model IDs are only prefixed with `backendName::` when the same model ID
   * appears on multiple backends (collision). Non-colliding IDs stay plain
   * so VS Code's utility-model auto-detection keeps working.
   */
  public async getAggregatedModels(
    token: CancellationToken
  ): Promise<{ models: LanguageModelChatInformation[]; errors: Map<string, string> }> {
    const multi = this.isMultiBackend();
    const errors = new Map<string, string>();

    const fetchPromises = Array.from(this.instances.entries()).map(
      async ([name, instance]) => {
        const outcome = await instance.catalog.getOrFetchModels(token);
        if (outcome.error) {
          errors.set(name, outcome.error);
        }
        return { name, models: outcome.models };
      }
    );

    const results = await Promise.all(fetchPromises);

    // Collect all (backendName, model) pairs and detect ID collisions.
    const entries: Array<{ backendName: string; model: LanguageModelChatInformation }> = [];
    const idCount = new Map<string, number>();
    for (const { name, models } of results) {
      for (const model of models) {
        entries.push({ backendName: name, model });
        idCount.set(model.id, (idCount.get(model.id) ?? 0) + 1);
      }
    }

    // Rebuild the model-to-backend mapping for routing.
    this.modelToBackend.clear();

    const allModels: LanguageModelChatInformation[] = [];
    for (const { backendName, model } of entries) {
      const collides = multi && (idCount.get(model.id) ?? 0) > 1;
      const finalId = collides
        ? prefixModelId(backendName, model.id, true)
        : model.id;
      const finalName = collides
        ? `${model.name} (${backendName})`
        : multi
          ? `${model.name} (${backendName})`
          : model.name;

      this.modelToBackend.set(finalId, backendName);

      allModels.push({
        ...model,
        id: finalId,
        name: finalName,
      } as LanguageModelChatInformation);
    }

    return { models: allModels, errors };
  }

  // ---------- routing ----------

  /**
   * Resolve a model ID to the backend instance and the raw model ID to send
   * on the wire. Uses the internal model-to-backend mapping first (covers
   * both prefixed and unprefixed IDs). Falls back to prefix parsing and
   * then to the first backend.
   */
  public resolveBackend(
    modelId: string
  ): { instance: BackendInstance; rawModelId: string } | undefined {
    // 1. Direct lookup from the aggregation map
    const mappedBackend = this.modelToBackend.get(modelId);
    if (mappedBackend) {
      const instance = this.instances.get(mappedBackend);
      if (instance) {
        // Strip the prefix if present to get the wire model ID
        const { rawModelId } = splitModelId(modelId, this.getBackendNames());
        return { instance, rawModelId };
      }
    }

    // 2. Try prefix parsing (handles IDs from previous sessions / cache)
    const { backendName, rawModelId } = splitModelId(
      modelId,
      this.getBackendNames()
    );
    if (backendName) {
      const instance = this.instances.get(backendName);
      if (instance) {
        return { instance, rawModelId };
      }
    }

    // 3. Fall back to default/first backend
    const fallback = this.getDefaultInstance();
    if (!fallback) {
      return undefined;
    }
    return { instance: fallback, rawModelId: modelId };
  }

  // ---------- cache management ----------

  /** Invalidate model caches on all backends. */
  public invalidateAllCaches(): void {
    for (const instance of this.instances.values()) {
      instance.catalog.invalidateCache();
      instance.discovery.reset();
    }
  }

  /** Invalidate model cache on a specific backend. */
  public invalidateBackendCache(backendName: string): void {
    const instance = this.instances.get(backendName);
    if (instance) {
      instance.catalog.invalidateCache();
      instance.discovery.reset();
    }
  }

  /** Clear learned contexts on all backends (config reload). */
  public clearAllLearnedContexts(): void {
    for (const instance of this.instances.values()) {
      instance.catalog.clearLearnedContexts();
    }
  }

  /** Reset all discovery probes (config reload). */
  public resetAllDiscovery(): void {
    for (const instance of this.instances.values()) {
      instance.discovery.reset();
    }
  }

  // ---------- status ----------

  /**
   * Connection info for each backend, for the status bar tooltip.
   */
  public getConnectionInfos(): BackendConnectionInfo[] {
    const infos: BackendConnectionInfo[] = [];
    for (const instance of this.instances.values()) {
      const cachedModels = instance.catalog.getCachedModels();
      const lastError = instance.catalog.getLastConnectionError();
      const lastFetch = instance.catalog.getLastSuccessfulFetchAt();

      let state: BackendConnectionInfo['state'];
      if (lastError) {
        state = 'error';
      } else if (lastFetch === undefined) {
        state = 'unknown';
      } else if (cachedModels.length === 0) {
        state = 'noModels';
      } else {
        state = 'ok';
      }

      infos.push({
        name: instance.name,
        serverUrl: instance.profile.serverUrl,
        state,
        errorMessage: lastError,
        modelCount: cachedModels.length,
        lastSuccessfulFetchAt: lastFetch,
      });
    }
    return infos;
  }

  /**
   * Whether any backend has successfully fetched models.
   */
  public hasAnyModels(): boolean {
    for (const instance of this.instances.values()) {
      if (instance.catalog.getCachedModels().length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether all backends have errored.
   */
  public allBackendsErrored(): boolean {
    for (const instance of this.instances.values()) {
      if (!instance.catalog.getLastConnectionError()) {
        return false;
      }
    }
    return this.instances.size > 0;
  }
}
