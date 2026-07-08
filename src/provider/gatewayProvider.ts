import * as vscode from 'vscode';
import { GatewayClient } from '../api/client';
import { GatewayConfig } from '../config/gatewayConfig';
import {
  FrameworkConfigOverride,
  readFrameworkConfiguration,
  resolveApiKey,
} from '../config/frameworkConfig';
import { estimateTextTokens } from '../chat/tokenBudget';
import { diagnoseModelFetchError } from '../chat/errorDiagnostics';
import { InlineCompletionBackend } from '../completions/inlineCompletionProvider';
import { extractHost } from '../status/format';
import {
  SessionStats,
  TokenUsage,
  accumulateUsage,
  emptySessionStats,
  recordRequest,
} from '../status/sessionStats';
import {
  ConnectionState,
  ModelSummary,
  StatusSnapshot,
  formatCapabilityLabels,
  formatContextLabel,
} from '../status/statusSnapshot';
import { ChatRequestHandler, RequestStateEvent } from './chatRequestHandler';
import { ConfigService } from './configService';
import { InlineCompletionService } from './inlineCompletionService';
import { ModelCatalog } from './modelCatalog';
import { SecretsManager } from './secretsManager';
import { promptOpenSettings } from './notifications';
import { countMessageTokens } from './vscodeParts';

export type { RequestStateEvent } from './chatRequestHandler';

/**
 * Setting keys that change the shape of the model list returned from the
 * server (and so require VS Code to re-request it). Other keys like
 * `agentTemperature` don't, so we don't want to fire the change event for
 * them — otherwise every keystroke in the settings UI triggers a re-fetch.
 *
 * `apiKey` and `customHeaders` are intentionally listed here for the
 * backward-compat path: if a user re-adds a legacy value to settings.json,
 * the config-change handler triggers a re-migration into SecretStorage and a
 * model refresh (issue #28). Those settings are deprecated for direct use.
 */
const MODEL_AFFECTING_KEYS: readonly string[] = [
  'github.copilot.llm-gateway.serverUrl',
  'github.copilot.llm-gateway.apiKey',
  'github.copilot.llm-gateway.requestTimeout',
  'github.copilot.llm-gateway.defaultMaxTokens',
  'github.copilot.llm-gateway.defaultMaxOutputTokens',
  'github.copilot.llm-gateway.enableImageInput',
  'github.copilot.llm-gateway.enableToolCalling',
  'github.copilot.llm-gateway.customHeaders',
  'github.copilot.llm-gateway.modelContextWindows',
];

/**
 * Legacy plain-text settings that we still watch on the config-change event
 * so a user manually re-adding them in `settings.json` gets re-migrated into
 * SecretStorage instead of silently sitting in plain text (issue #28).
 */
const LEGACY_SECRET_KEYS: readonly string[] = [
  'github.copilot.llm-gateway.apiKey',
  'github.copilot.llm-gateway.customHeaders',
];

/**
 * Language model provider for OpenAI-compatible inference servers.
 *
 * A thin facade over focused services: {@link ConfigService} (settings +
 * validation), {@link SecretsManager} (SecretStorage cache + legacy
 * migration), {@link ModelCatalog} (model list cache + context sizes),
 * {@link ChatRequestHandler} (the chat pipeline), and
 * {@link InlineCompletionService} (FIM ghost text). This class owns the
 * VS Code API surface, the event emitters, and the session stats the status
 * dialog renders — the services carry the logic and are unit-tested
 * independently (as are the pure modules under chat/, models/, api/…).
 */
export class GatewayProvider
  implements vscode.LanguageModelChatProvider, InlineCompletionBackend
{
  private readonly client: GatewayClient;
  private config: GatewayConfig;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly configService: ConfigService;
  private readonly secretsManager: SecretsManager;
  private readonly catalog: ModelCatalog;
  private readonly chatHandler: ChatRequestHandler;
  private readonly inlineCompletions: InlineCompletionService;
  /**
   * Latest API-key override supplied by VS Code's framework-managed
   * `configuration` schema (the `chatProvider@4` proposed API used by native
   * BYOK providers). Wins over the SecretStorage cache when set so users can
   * manage credentials from the native model-picker UI without going through
   * our bespoke `Configure Server` command. Empty values are meaningful —
   * a user clearing the field in the native UI should override any stale
   * SecretStorage entry.
   */
  private frameworkOverride: FrameworkConfigOverride = {};

  private readonly _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

  /**
   * Fired around each chat request so the status bar (or other listeners) can
   * surface live request state. `complete` may carry the usage frame the
   * inference server reported; `error` carries the message that failed the
   * request — both kinds always fire eventually, never both for the same call.
   */
  private readonly _onDidChangeRequestState = new vscode.EventEmitter<RequestStateEvent>();
  readonly onDidChangeRequestState = this._onDidChangeRequestState.event;

  /**
   * Fired whenever the data behind `getStatusSnapshot()` changes (model
   * fetch outcome, request completion, session totals). The status dialog
   * subscribes to this to live-refresh while it's open.
   */
  private readonly _onDidChangeStatusSnapshot = new vscode.EventEmitter<void>();
  readonly onDidChangeStatusSnapshot = this._onDidChangeStatusSnapshot.event;

  private sessionStats: SessionStats = emptySessionStats();
  private lastRequest?: {
    modelId: string;
    modelName: string;
    completedAt: number;
    usage?: TokenUsage;
  };

  constructor(context: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('GitHub Copilot LLM Gateway');
    const log = (msg: string): void => this.outputChannel.appendLine(msg);

    this.secretsManager = new SecretsManager(context.secrets, {
      log,
      onDidUpdate: () => this.reloadConfig(),
    });
    this.configService = new ConfigService({
      getApiKey: () =>
        resolveApiKey(this.frameworkOverride, this.secretsManager.getCache().apiKey),
      getCustomHeaders: () => this.secretsManager.getCache().customHeaders,
      log,
      promptOpenSettings: (message) => promptOpenSettings(message, log),
    });
    this.config = this.configService.load();
    this.client = new GatewayClient(this.config, log);
    this.catalog = new ModelCatalog({
      client: this.client,
      getConfig: () => this.config,
      log,
      onStatusChanged: () => this._onDidChangeStatusSnapshot.fire(),
    });
    this.chatHandler = new ChatRequestHandler({
      client: this.client,
      catalog: this.catalog,
      getConfig: () => this.config,
      log,
      onRequestState: (event) => this._onDidChangeRequestState.fire(event),
      onCompleted: (modelId, modelName, usage) =>
        this.recordCompletedRequest(modelId, modelName, usage),
      showOutput: () => this.outputChannel.show(),
    });
    this.inlineCompletions = new InlineCompletionService({
      client: this.client,
      getConfig: () => this.config,
      getDefaultModelId: () => this.catalog.getCachedModels()[0]?.id,
      log,
    });

    context.subscriptions.push(
      this.outputChannel,
      this._onDidChangeLanguageModelChatInformation,
      this._onDidChangeRequestState,
      this._onDidChangeStatusSnapshot,
      vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
        if (!e.affectsConfiguration('github.copilot.llm-gateway')) {
          return;
        }
        this.outputChannel.appendLine('Configuration changed, reloading...');
        // If a deprecated legacy secret setting just gained a value (manually
        // typed into settings.json or pasted via the settings UI), pull it
        // back into SecretStorage and clear the plain-text copy. Errors are
        // logged but never thrown — the config-change listener can't be async.
        if (LEGACY_SECRET_KEYS.some((key) => e.affectsConfiguration(key))) {
          void this.secretsManager.reMigrateLegacySecrets();
        }
        this.reloadConfig();
        // Only nudge VS Code to refetch models when a setting that actually
        // affects the model list has changed.
        const affectsModels = MODEL_AFFECTING_KEYS.some((key) => e.affectsConfiguration(key));
        if (affectsModels) {
          this._onDidChangeLanguageModelChatInformation.fire();
        }
      }),
      context.secrets.onDidChange((e: vscode.SecretStorageChangeEvent) => {
        if (!this.secretsManager.ownsSecretKey(e.key)) {
          return;
        }
        // Another VS Code window (or our own setApiKey) updated a secret —
        // refresh the cache + config so subsequent requests use the new
        // values. Errors here would silently produce stale credentials, so
        // we surface them in the output channel.
        void this.secretsManager.refreshCache().catch((err: unknown) => {
          this.outputChannel.appendLine(
            `Failed to refresh secret cache after change: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      })
    );
  }

  // ---------- secrets ----------

  /**
   * Called from `extension.activate` after construction so the first chat
   * request uses the right credentials (issue #28).
   */
  public async loadSecrets(): Promise<void> {
    await this.secretsManager.loadSecrets();
  }

  public async setApiKey(apiKey: string): Promise<void> {
    await this.secretsManager.setApiKey(apiKey);
  }

  public async setCustomHeaders(headers: Record<string, string>): Promise<void> {
    await this.secretsManager.setCustomHeaders(headers);
  }

  /** Snapshot of the cached custom headers — used by the Edit flow. */
  public getCustomHeadersSnapshot(): Record<string, string> {
    return this.secretsManager.getCustomHeadersSnapshot();
  }

  // ---------- model list ----------

  /**
   * Force a refresh of the language model list. Called from the
   * `Refresh Models` command so users can re-probe the server without
   * editing settings.
   */
  public refreshModels(): void {
    this._onDidChangeLanguageModelChatInformation.fire();
  }

  /**
   * Invalidate the in-memory model-fetch cache so the next call re-probes
   * the server. Called from the `Refresh Models` command.
   */
  public invalidateModelCache(): void {
    this.catalog.invalidateCache();
  }

  /**
   * Provide language model information - fetches available models from
   * inference server. Multiple concurrent callers share a single HTTP
   * request; successful results are cached for a short window so the picker
   * and the status bar don't double-probe.
   */
  async provideLanguageModelChatInformation(
    options: { silent: boolean; configuration?: { readonly [key: string]: unknown } },
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // Pick up any framework-managed configuration (e.g. an apiKey entered via
    // VS Code's native model-picker UI). Only mutates state when the
    // configuration actually changed so we don't churn the cache on every
    // picker open.
    this.applyFrameworkConfiguration(options.configuration);

    const outcome = await this.catalog.getOrFetchModels(token);
    if (!options.silent && outcome.error) {
      promptOpenSettings(
        `GitHub Copilot LLM Gateway: Failed to fetch models. ${diagnoseModelFetchError(outcome.error)}`,
        (msg) => this.outputChannel.appendLine(msg)
      );
    }
    return outcome.models;
  }

  /**
   * Merge a framework-supplied configuration into the in-memory override.
   * Only forwards `apiKey` for now — `serverUrl` stays in workspace settings
   * so the per-window scope picker (issue #23) keeps working. An explicit
   * empty string is preserved as a "no key" override; a missing/non-string
   * `apiKey` leaves the previous override untouched (defensive — the framework
   * may simply not pass `configuration` on every call).
   */
  private applyFrameworkConfiguration(
    configuration: { readonly [key: string]: unknown } | undefined
  ): void {
    const next = readFrameworkConfiguration(configuration);
    if (next.apiKey === undefined) {
      return;
    }
    if (next.apiKey === this.frameworkOverride.apiKey) {
      return;
    }
    this.frameworkOverride.apiKey = next.apiKey;
    this.outputChannel.appendLine(
      'API key updated from VS Code framework configuration; reloading.'
    );
    this.catalog.invalidateCache();
    this.reloadConfig();
  }

  // ---------- chat ----------

  /**
   * Provide language model chat response - streams responses from inference server
   */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    return this.chatHandler.handle(model, messages, options, progress, token);
  }

  /**
   * Provide token count estimation (rough char/4 approximation). Non-text
   * parts contribute too — see {@link countMessageTokens}.
   */
  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    if (typeof text === 'string') {
      return estimateTextTokens(text);
    }
    return countMessageTokens(text);
  }

  // ---------- status ----------

  /**
   * Capture a successful request in the running session totals and the
   * `lastRequest` slot the status dialog renders. Failed requests are not
   * counted — the connection-state row already reflects them and a single
   * failure shouldn't pad the request count.
   */
  private recordCompletedRequest(
    modelId: string,
    modelName: string,
    usage: TokenUsage | undefined
  ): void {
    let next = recordRequest(this.sessionStats);
    if (usage) {
      next = accumulateUsage(next, usage);
    }
    this.sessionStats = next;
    this.lastRequest = {
      modelId,
      modelName,
      completedAt: Date.now(),
      ...(usage ? { usage } : {}),
    };
    this._onDidChangeStatusSnapshot.fire();
  }

  /**
   * Open the extension's output channel. Exposed so the status dialog's
   * "Open output log" button can show the panel without the controller
   * having to reach into the provider's internals.
   */
  public showOutput(): void {
    this.outputChannel.show();
  }

  /**
   * Snapshot of everything the status dialog renders: connection state, the
   * cached model list, running session totals, last request, feature flags.
   * Re-built fresh on every call so relative-time fields ("2m ago") move
   * forward whenever the dialog re-renders.
   */
  public getStatusSnapshot(): StatusSnapshot {
    const cachedModels = this.catalog.getCachedModels();
    const models: ModelSummary[] = cachedModels.map((m) => {
      const totalContext = this.catalog.getContextForModel(m.id);
      return {
        id: m.id,
        name: m.name,
        contextLabel: formatContextLabel(totalContext),
        ...(totalContext !== undefined ? { totalContext } : {}),
        capabilityLabels: formatCapabilityLabels(m.capabilities ?? {}),
      };
    });

    const lastConnectionError = this.catalog.getLastConnectionError();
    const lastSuccessfulFetchAt = this.catalog.getLastSuccessfulFetchAt();
    let connection: { state: ConnectionState; errorMessage?: string };
    if (lastConnectionError) {
      connection = { state: 'error', errorMessage: lastConnectionError };
    } else if (lastSuccessfulFetchAt === undefined) {
      connection = { state: 'unknown' };
    } else if (cachedModels.length === 0) {
      connection = { state: 'noModels' };
    } else {
      connection = { state: 'ok' };
    }

    return {
      host: extractHost(this.config.serverUrl),
      connection,
      ...(lastSuccessfulFetchAt !== undefined ? { lastSuccessfulFetchAt } : {}),
      models,
      sessionStats: this.sessionStats,
      ...(this.lastRequest ? { lastRequest: this.lastRequest } : {}),
      features: {
        toolCalling: this.config.enableToolCalling,
        imageInput: this.config.enableImageInput,
        parallelToolCalling: this.config.parallelToolCalling,
        agentTemperature: this.config.agentTemperature,
      },
      now: Date.now(),
    };
  }

  // ---------- inline completion (InlineCompletionBackend) ----------

  /** Whether the experimental inline-completion provider should run (issue #44). */
  public isInlineCompletionEnabled(): boolean {
    return this.config.enableInlineCompletion;
  }

  /** Debounce window the VS Code provider waits before firing a request. */
  public getInlineCompletionDebounceMs(): number {
    return this.config.inlineCompletionDebounce;
  }

  public async provideInlineCompletion(
    textBefore: string,
    textAfter: string,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    return this.inlineCompletions.provideCompletion(textBefore, textAfter, token);
  }

  // ---------- config ----------

  private reloadConfig(): void {
    this.config = this.configService.load();
    this.client.updateConfig(this.config);
    // The server (or its capabilities) may have changed — probe suffix support again.
    this.inlineCompletions.resetSuffixProbe();
    // Context sizes learned from a previous server's errors no longer apply.
    this.catalog.clearLearnedContexts();
    this.outputChannel.appendLine('Configuration reloaded');
  }
}
