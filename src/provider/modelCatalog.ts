import type { CancellationToken, LanguageModelChatInformation } from 'vscode';
import { GatewayClient } from '../api/client';
import { GatewayConfig } from '../config/gatewayConfig';
import { DiscoveredModelInfo, ModelDiscovery } from '../discovery/types';
import { TOKEN_CONSTANTS } from '../chat/tokenBudget';
import { parseContextOverflowError, resolveContextWindowOverride } from '../chat/contextWindow';
import { dedupeModels } from '../models/modelDisplay';
import { buildModelInfo } from '../models/modelInfoBuilder';

interface ModelCatalogDeps {
  client: GatewayClient;
  /**
   * Backend-native metadata probe (currently Ollama `/api/show`). Detects the
   * backend once per config generation and answers instantly for servers it
   * doesn't recognise.
   */
  discovery: ModelDiscovery;
  getConfig: () => GatewayConfig;
  log: (message: string) => void;
  /** Fired when connection state / cached data changes (status dialog refresh). */
  onStatusChanged: () => void;
}

/**
 * Owns everything the provider knows about the server's model list: the
 * short-lived fetch cache with single-flight dedup, the per-model context
 * sizes reported by the server, and the (smaller) context sizes learned from
 * the server's own overflow errors.
 *
 * Only uses `vscode` type imports so it stays unit-testable under
 * `node --test`.
 */
export class ModelCatalog {
  /**
   * In-flight model-fetch promise + its completion timestamp. Shared between
   * `provideLanguageModelChatInformation` (called by VS Code's picker) and
   * the status-bar probe, so rapid-fire calls don't stack HTTP requests
   * against the inference server.
   */
  private fetchInFlight?: Promise<LanguageModelChatInformation[]>;
  private fetchLast?: { at: number; result: LanguageModelChatInformation[] };
  /**
   * Real server-reported context per model id (`max_model_len` / etc.).
   * Needed because the picker-facing `maxInputTokens` is the full context
   * on purpose — the chat-response code path needs the separate true value
   * so it doesn't double-count when budgeting output tokens.
   */
  private readonly contextByModelId: Map<string, number> = new Map();
  /**
   * Context sizes learned from the server's own context-overflow errors
   * (issue #55). Ground truth from the backend, so it wins over anything the
   * model list reported — llama-server router mode in particular advertises
   * nothing until a model is loaded. Survives model-list refreshes; cleared
   * on config reload since the server (or its presets) may have changed.
   */
  private readonly learnedContextByModelId: Map<string, number> = new Map();
  /**
   * Backend-discovered metadata per model id (context, sampler params,
   * capabilities — e.g. from Ollama `/api/show`). Rebuilt on every model
   * fetch; empty for backends without native discovery. Lets the chat path
   * auto-apply server-side sampler params so the user doesn't have to mirror
   * them in `perModelOptions` client-side.
   */
  private readonly discoveredByModelId: Map<string, DiscoveredModelInfo> = new Map();
  private lastSuccessfulFetchAt?: number;
  private lastConnectionError?: string;

  constructor(private readonly deps: ModelCatalogDeps) {}

  /** Most recent successful fetch result, or empty when none is cached. */
  public getCachedModels(): LanguageModelChatInformation[] {
    return this.fetchLast?.result ?? [];
  }

  public getContextForModel(modelId: string): number | undefined {
    return this.contextByModelId.get(modelId);
  }

  /**
   * Numeric sampler params discovered from the backend's native API
   * (temperature, top_p, top_k, ...), or `undefined` when the backend has no
   * native discovery or the first model fetch hasn't happened. Consumed by
   * the chat request handler to fill sampler params the caller/settings
   * didn't specify.
   */
  public getDiscoveredParams(modelId: string): Readonly<Record<string, number>> | undefined {
    return this.discoveredByModelId.get(modelId)?.samplerParams;
  }

  public getLastSuccessfulFetchAt(): number | undefined {
    return this.lastSuccessfulFetchAt;
  }

  public getLastConnectionError(): string | undefined {
    return this.lastConnectionError;
  }

  /**
   * Invalidate the in-memory model-fetch cache so the next call re-probes
   * the server. Called from the `Refresh Models` command.
   */
  public invalidateCache(): void {
    this.fetchLast = undefined;
  }

  /** Called on config reload — a different server's learned sizes no longer apply. */
  public clearLearnedContexts(): void {
    this.learnedContextByModelId.clear();
  }

  /**
   * Model-fetch with cache + single-flight dedup. Never shows any UI itself —
   * that decision belongs to the caller based on its `silent` flag.
   */
  public async getOrFetchModels(
    token: CancellationToken
  ): Promise<{ models: LanguageModelChatInformation[]; error?: string }> {
    const now = Date.now();
    const cacheTtlMs = 1000;
    if (this.fetchLast && now - this.fetchLast.at < cacheTtlMs) {
      return { models: this.fetchLast.result };
    }
    if (this.fetchInFlight) {
      try {
        return { models: await this.fetchInFlight };
      } catch (error) {
        return { models: [], error: error instanceof Error ? error.message : String(error) };
      }
    }

    const inFlight = this.doFetchModels(token);
    this.fetchInFlight = inFlight;
    try {
      const result = await inFlight;
      // Don't poison the cache with cancelled-empty results — the next caller
      // should re-probe instead of seeing a stale empty list.
      if (!token.isCancellationRequested) {
        this.fetchLast = { at: Date.now(), result };
        this.lastSuccessfulFetchAt = Date.now();
        this.lastConnectionError = undefined;
        this.deps.onStatusChanged();
      }
      return { models: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastConnectionError = message;
      this.deps.onStatusChanged();
      return { models: [], error: message };
    } finally {
      if (this.fetchInFlight === inFlight) {
        this.fetchInFlight = undefined;
      }
    }
  }

  private async doFetchModels(
    token: CancellationToken
  ): Promise<LanguageModelChatInformation[]> {
    const { log } = this.deps;
    log('Fetching models from inference server...');
    let response;
    try {
      response = await this.deps.client.fetchModels(token);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log(`ERROR: Failed to fetch models: ${errorMessage}`);
      throw error;
    }

    if (token.isCancellationRequested) {
      return [];
    }

    const uniqueModels = dedupeModels(response.data);
    if (uniqueModels.length !== response.data.length) {
      log(
        `Server returned ${response.data.length} models, ${uniqueModels.length} unique after dedupe`
      );
    }

    // Build replacement per-id maps and swap them in only after the async
    // work below finishes — clearing up front would leave a window where a
    // concurrent chat request sees no context/params at all.
    const nextContextByModelId = new Map<string, number>();
    const nextDiscoveredByModelId = new Map<string, DiscoveredModelInfo>();

    const config = this.deps.getConfig();
    const models = await Promise.all(
      uniqueModels.map(async (model) => {
        const contextOverride = resolveContextWindowOverride(
          model.id,
          config.modelContextWindows
        );

        // Backend-native discovery (currently Ollama /api/show): context,
        // capabilities, and sampler params the OpenAI /v1/models list doesn't
        // carry. Answers `undefined` instantly for backends it doesn't
        // recognise — detection is a single cached short-timeout probe. A
        // failing probe must degrade to "no metadata", never fail the list.
        const discovered = await this.deps.discovery
          .enrichModel(model.id, token)
          .catch(() => undefined);
        if (discovered) {
          nextDiscoveredByModelId.set(model.id, discovered);
        }

        const { info, totalContext, hasServerReportedContext } = buildModelInfo({
          model,
          defaultMaxTokens: config.defaultMaxTokens,
          defaultMaxOutputTokens: config.defaultMaxOutputTokens,
          capabilities: {
            // A discovered capability verdict wins; `undefined` means the
            // server didn't say (e.g. older Ollama), so keep the setting.
            imageInput: config.enableImageInput && (discovered?.visionSupported ?? true),
            toolCalling: config.enableToolCalling && (discovered?.toolsSupported ?? true),
          },
          contextOverride,
          discoveredContext: discovered?.contextLength,
        });
        nextContextByModelId.set(model.id, totalContext);

        const exposed = `exposed as input=${info.maxInputTokens}, output=${info.maxOutputTokens}`;
        if (contextOverride !== undefined) {
          log(
            `  Model ${model.id}: context ${totalContext} tokens from 'modelContextWindows' setting (${exposed})`
          );
        } else if (discovered?.contextLength !== undefined) {
          log(
            `  Model ${model.id}: context ${totalContext} tokens from ${discovered.contextSource} (${exposed})`
          );
        } else if (hasServerReportedContext) {
          log(
            `  Model ${model.id}: server-reported context ${totalContext} tokens (${exposed})`
          );
        } else {
          log(
            `  Model ${model.id}: no server-reported context; using defaultMaxTokens=${totalContext}. If this is wrong, set 'github.copilot.llm-gateway.modelContextWindows'.`
          );
        }
        if (discovered) {
          const capability = (value: boolean | undefined): string =>
            value === undefined ? 'unknown' : String(value);
          const samplerKeys = Object.keys(discovered.samplerParams).join(', ') || '(none)';
          log(
            `  Model ${model.id}: discovered vision=${capability(discovered.visionSupported)}, tools=${capability(discovered.toolsSupported)}; params: ${samplerKeys}`
          );
        }

        return info;
      })
    );

    // Swap in the rebuilt maps. If the server removed a model, its entry is
    // gone so stale data can't leak into future chat requests.
    this.contextByModelId.clear();
    this.discoveredByModelId.clear();
    for (const [id, context] of nextContextByModelId) {
      this.contextByModelId.set(id, context);
    }
    for (const [id, discovered] of nextDiscoveredByModelId) {
      this.discoveredByModelId.set(id, discovered);
    }

    log(`Found ${models.length} models: ${models.map((m) => m.id).join(', ')}`);
    return models;
  }

  /**
   * Resolve the real server-reported context size for a model. The
   * picker-facing `maxInputTokens` equals `totalContext`, so naive
   * `maxInputTokens + maxOutputTokens` would overshoot by `maxOutputTokens`
   * and cause context-length errors at the server.
   */
  public resolveModelMaxContext(model: LanguageModelChatInformation): number {
    let context: number;
    const cached = this.contextByModelId.get(model.id);
    if (cached && cached > 0) {
      context = cached;
    } else if (model.maxInputTokens && model.maxInputTokens > 0) {
      // Fallback path: the model list hasn't been fetched yet in this session
      // (e.g. VS Code routed a cached chat directly to the provider). Use the
      // picker-facing input window, which equals totalContext after the
      // provideLanguageModelChatInformation change.
      context = model.maxInputTokens;
    } else {
      context = TOKEN_CONSTANTS.DEFAULT_CONTEXT_TOKENS;
    }
    // A size learned from the server's own overflow error is ground truth —
    // it wins whenever it's smaller than what the model list claimed.
    const learned = this.learnedContextByModelId.get(model.id);
    if (learned !== undefined && learned < context) {
      return learned;
    }
    return context;
  }

  /**
   * Inspect a failed chat request for a context-overflow error and record the
   * context size the server says it actually has. Returns true when a new,
   * smaller size was learned — i.e. retrying with a recomputed budget can
   * succeed. Returns false when the error is unrelated, or when we were
   * already budgeting within the reported window (estimation drift — a retry
   * with the same numbers would fail identically).
   */
  public learnContextSizeFromError(
    model: LanguageModelChatInformation,
    error: unknown
  ): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const serverContext = parseContextOverflowError(message);
    if (serverContext === undefined) {
      return false;
    }
    const current = this.resolveModelMaxContext(model);
    if (serverContext >= current) {
      return false;
    }
    this.learnedContextByModelId.set(model.id, serverContext);
    this.deps.log(
      `Learned context size for ${model.id} from server error: ${serverContext} tokens (was budgeting for ${current}). ` +
        `Add it to 'github.copilot.llm-gateway.modelContextWindows' to persist across sessions.`
    );
    return true;
  }
}
