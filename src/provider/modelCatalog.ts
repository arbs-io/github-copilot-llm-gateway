import type { CancellationToken, LanguageModelChatInformation } from 'vscode';
import { GatewayClient } from '../api/client';
import { GatewayConfig } from '../config/gatewayConfig';
import { TOKEN_CONSTANTS } from '../chat/tokenBudget';
import { parseContextOverflowError, resolveContextWindowOverride } from '../chat/contextWindow';
import { dedupeModels } from '../models/modelDisplay';
import { buildModelInfo } from '../models/modelInfoBuilder';

interface ModelCatalogDeps {
  client: GatewayClient;
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

    // Rebuild the per-id context map from the latest fetch. If the server
    // removed a model, drop its entry so stale data can't leak into future
    // chat requests.
    this.contextByModelId.clear();

    const config = this.deps.getConfig();
    const models = uniqueModels.map((model) => {
      const contextOverride = resolveContextWindowOverride(
        model.id,
        config.modelContextWindows
      );
      const { info, totalContext, hasServerReportedContext } = buildModelInfo({
        model,
        defaultMaxTokens: config.defaultMaxTokens,
        defaultMaxOutputTokens: config.defaultMaxOutputTokens,
        capabilities: {
          imageInput: config.enableImageInput,
          toolCalling: config.enableToolCalling,
        },
        contextOverride,
      });
      this.contextByModelId.set(model.id, totalContext);

      if (contextOverride !== undefined) {
        log(
          `  Model ${model.id}: context ${totalContext} tokens from 'modelContextWindows' setting (exposed as input=${info.maxInputTokens}, output=${info.maxOutputTokens})`
        );
      } else if (hasServerReportedContext) {
        log(
          `  Model ${model.id}: server-reported context ${totalContext} tokens (exposed as input=${info.maxInputTokens}, output=${info.maxOutputTokens})`
        );
      } else {
        log(
          `  Model ${model.id}: no server-reported context; using defaultMaxTokens=${totalContext}. If this is wrong, set 'github.copilot.llm-gateway.modelContextWindows'.`
        );
      }

      return info;
    });

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
