import * as vscode from 'vscode';
import { GatewayProvider, RequestStateEvent } from './provider';
import { GatewayInlineCompletionProvider } from './inlineCompletionProvider';
import {
  StatusBarState,
  TokenUsage,
  extractHost,
  renderStatusBar,
} from './statusBarController';
import { StatusSnapshot } from './statusSnapshot';
import { renderStatusTooltipHtml } from './statusTooltip';

const STATUS_BAR_PROBE_DELAY_MS = 1500;
/** How long the "responded" pulse stays in the bar before reverting to idle. */
const RESPONDED_DISPLAY_MS = 10_000;

/**
 * Drives the LLM Gateway status bar. Pure rendering lives in
 * `statusBarController.ts`; this class only handles the VS Code-side state
 * machine: timers, in-flight counting, mapping events onto state transitions.
 */
class StatusBarManager implements vscode.Disposable {
  private state: StatusBarState;
  private respondedRevertTimer?: NodeJS.Timeout;
  private activeRequestCount = 0;
  private cachedIdle: { host: string; modelIds: readonly string[] } = {
    host: '',
    modelIds: [],
  };

  constructor(
    private readonly item: vscode.StatusBarItem,
    private readonly getServerUrl: () => string,
    private readonly getSnapshot: () => StatusSnapshot
  ) {
    this.state = { kind: 'probing', host: extractHost(this.getServerUrl()) };
    this.render();
  }

  /**
   * Called from outside whenever the provider's snapshot changes (session
   * totals, last request, models, connection state). The tooltip is rebuilt
   * from the snapshot, so any new data shows up the next time the user hovers
   * the status bar — even if the bar's icon state hasn't changed.
   */
  refreshTooltip(): void {
    this.render();
  }

  dispose(): void {
    this.cancelRespondedRevert();
  }

  setIdle(modelIds: readonly string[]): void {
    this.cachedIdle = { host: this.host(), modelIds };
    this.cancelRespondedRevert();
    this.applyIdle();
  }

  setNoModels(): void {
    this.cancelRespondedRevert();
    this.state = { kind: 'noModels', host: this.host() };
    this.render();
  }

  setError(errorMessage: string): void {
    this.cancelRespondedRevert();
    this.state = { kind: 'error', host: this.host(), errorMessage };
    this.render();
  }

  onRequest(event: RequestStateEvent): void {
    switch (event.kind) {
      case 'start':
        this.onRequestStart(event);
        return;
      case 'complete':
        this.onRequestComplete(event);
        return;
      case 'error':
        this.onRequestError(event);
        return;
      default: {
        const _never: never = event;
        throw new Error(`Unexpected request state kind: ${String(_never)}`);
      }
    }
  }

  private onRequestStart(event: Extract<RequestStateEvent, { kind: 'start' }>): void {
    this.cancelRespondedRevert();
    this.activeRequestCount++;
    this.state = {
      kind: 'streaming',
      host: this.host(),
      modelId: event.modelId,
      modelName: event.modelName,
      activeCount: this.activeRequestCount,
    };
    this.render();
  }

  private onRequestComplete(
    event: Extract<RequestStateEvent, { kind: 'complete' }>
  ): void {
    this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
    if (this.activeRequestCount > 0) {
      // Other requests still streaming — keep the bar in streaming state with
      // an updated count rather than briefly flashing "responded".
      this.state = {
        kind: 'streaming',
        host: this.host(),
        modelId: event.modelId,
        modelName: event.modelName,
        activeCount: this.activeRequestCount,
      };
      this.render();
      return;
    }
    this.state = {
      kind: 'responded',
      host: this.host(),
      modelId: event.modelId,
      modelName: event.modelName,
      ...(event.usage ? { usage: this.toUsage(event.usage) } : {}),
    };
    this.render();
    this.scheduleRespondedRevert();
  }

  private onRequestError(event: Extract<RequestStateEvent, { kind: 'error' }>): void {
    this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
    this.setError(event.errorMessage);
  }

  private toUsage(usage: TokenUsage): TokenUsage {
    return { prompt: usage.prompt, completion: usage.completion, total: usage.total };
  }

  private applyIdle(): void {
    this.state = {
      kind: 'idle',
      host: this.cachedIdle.host,
      modelCount: this.cachedIdle.modelIds.length,
      modelIds: this.cachedIdle.modelIds,
    };
    this.render();
  }

  private scheduleRespondedRevert(): void {
    this.cancelRespondedRevert();
    this.respondedRevertTimer = setTimeout(() => {
      this.respondedRevertTimer = undefined;
      this.applyIdle();
    }, RESPONDED_DISPLAY_MS);
  }

  private cancelRespondedRevert(): void {
    if (this.respondedRevertTimer) {
      clearTimeout(this.respondedRevertTimer);
      this.respondedRevertTimer = undefined;
    }
  }

  private host(): string {
    return extractHost(this.getServerUrl());
  }

  private render(): void {
    // Bar text stays minimal (vm-active/vm-disconnect + host) — that's the
    // "is the gateway up" signal. All the rich data goes into the hover
    // tooltip, which is the closest stable-API approximation to GHCP's
    // floating popup (`chatStatusItem` is proposed-API-only).
    const { text } = renderStatusBar(this.state);
    this.item.text = text;
    // Tooltip renders as the GHCP-style popup: HTML card with theme icons,
    // section headers, and command-link buttons. MarkdownString runs the value
    // through VS Code's hover renderer, which is the closest stable-API path
    // to a click-triggered floating popup (`chatStatusItem` is proposed-only).
    const tooltipHtml = renderStatusTooltipHtml(this.getSnapshot());
    const md = new vscode.MarkdownString(tooltipHtml);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.supportHtml = true;
    this.item.tooltip = md;
  }
}

/**
 * Extension activation. Async so we can pull the API key + custom headers
 * out of SecretStorage (and migrate legacy plain-text settings, issue #28)
 * before registering the provider — otherwise the first model fetch races
 * the secret load and is sent unauthenticated.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new GatewayProvider(context);
  await provider.loadSecrets();

  const disposable = vscode.lm.registerLanguageModelChatProvider(
    'copilot-llm-gateway',
    provider
  );

  context.subscriptions.push(disposable);

  // Experimental standalone inline (ghost-text) completions backed by the
  // inference server's /v1/completions endpoint. Registered unconditionally
  // for all files; it no-ops unless the user opts in via
  // `enableInlineCompletion`, so toggling the setting takes effect without a
  // reload. This runs alongside GitHub Copilot because VS Code doesn't expose
  // BYOK models to its own inline suggestions (issue #44).
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new GatewayInlineCompletionProvider(provider)
    )
  );

  // Status bar entry so users can see connection state at a glance and
  // quickly refresh the model list. Without this, failed model fetches were
  // invisible unless users happened to open the model picker. The visible
  // label is context-aware (host when idle, model name during streaming,
  // model + token count after) — see statusBarController.ts.
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.name = 'LLM Gateway';
  // Click refreshes the gateway. The rich GHCP-style popup is the hover
  // tooltip — it's the closest stable-API approximation to a floating
  // status-bar popup. Clicking is wired to a useful action so the bar
  // isn't dead.
  statusBar.command = 'github.copilot.llm-gateway.refreshModels';
  statusBar.show();
  context.subscriptions.push(statusBar);

  const statusManager = new StatusBarManager(
    statusBar,
    () =>
      vscode.workspace
        .getConfiguration('github.copilot.llm-gateway')
        .get<string>('serverUrl', 'http://localhost:8000'),
    () => provider.getStatusSnapshot()
  );
  context.subscriptions.push(statusManager);

  // Live request state: streaming → responded → idle, with errors flashing in
  // place. The provider fires `start` / `complete` / `error` events around
  // each provideLanguageModelChatResponse call.
  context.subscriptions.push(
    provider.onDidChangeRequestState((event) => statusManager.onRequest(event))
  );

  // Rich hover tooltip is rebuilt from the provider's snapshot — refresh it
  // whenever the snapshot changes (model refresh, request completion, session
  // totals tick) so a hovering user always sees current numbers.
  context.subscriptions.push(
    provider.onDidChangeStatusSnapshot(() => statusManager.refreshTooltip())
  );

  // Status dialog (opened by clicking the status bar) — the GHCP-style
  // QuickPick with connection state, session totals, models, feature toggles,
  // and quick actions. The controller subscribes to the provider's snapshot
  // event while open so the values stay fresh without polling.
  // Tooltip's "Show output log" link needs a registered command (command-link
  // anchors can't call class methods directly). Tiny wrapper around
  // provider.showOutput.
  context.subscriptions.push(
    vscode.commands.registerCommand('github.copilot.llm-gateway.showOutput', () =>
      provider.showOutput()
    )
  );

  /**
   * Probe the gateway silently (no error toast) and render the result in the
   * status bar. Uses the provider's cached fetch so it doesn't double-hit the
   * server when VS Code is already asking for models.
   */
  const refreshStatusBar = async (): Promise<void> => {
    const cts = new vscode.CancellationTokenSource();
    try {
      const models = await provider.provideLanguageModelChatInformation(
        { silent: true },
        cts.token
      );
      if (models.length > 0) {
        statusManager.setIdle(models.map((m) => m.id));
      } else {
        statusManager.setNoModels();
      }
    } catch (error) {
      statusManager.setError(error instanceof Error ? error.message : String(error));
    } finally {
      cts.dispose();
    }
  };

  // Initial silent probe shortly after activation, once VS Code has settled.
  // The timer is registered as a disposable so it can't fire into a
  // disposed provider if the extension is deactivated in the interim.
  const initialProbeTimer = setTimeout(() => {
    void refreshStatusBar();
  }, STATUS_BAR_PROBE_DELAY_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(initialProbeTimer) });

  const testCommand = vscode.commands.registerCommand(
    'github.copilot.llm-gateway.testConnection',
    async () => {
      const cts = new vscode.CancellationTokenSource();
      try {
        const models = await provider.provideLanguageModelChatInformation(
          { silent: false },
          cts.token
        );

        if (models.length > 0) {
          statusManager.setIdle(models.map((m) => m.id));
          vscode.window.showInformationMessage(
            `GitHub Copilot LLM Gateway: Successfully connected! Found ${models.length} model(s): ${models.map((m) => m.name).join(', ')}`
          );
        } else {
          statusManager.setNoModels();
          vscode.window.showWarningMessage(
            'GitHub Copilot LLM Gateway: Connected but no models found.'
          );
        }
      } catch (error) {
        statusManager.setError(error instanceof Error ? error.message : String(error));
        vscode.window.showErrorMessage(
          `GitHub Copilot LLM Gateway: Connection test failed. ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        cts.dispose();
      }
    }
  );

  context.subscriptions.push(testCommand);

  // "Configure Server" command — triggered by the "Add Models..." dropdown
  // via the managementCommand contribution. Prompts for server URL (stored
  // in workspace/user settings) and API key (stored in SecretStorage,
  // issue #28). Refreshes the model list when done.
  const manageCommand = vscode.commands.registerCommand(
    'github.copilot.llm-gateway.manage',
    async () => {
      const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
      const currentUrl = config.get<string>('serverUrl', 'http://localhost:8000');

      const url = await vscode.window.showInputBox({
        title: 'LLM Gateway — Server URL',
        prompt: 'Enter the inference server URL (OpenAI-compatible endpoint)',
        value: currentUrl,
        placeHolder: 'http://localhost:8000',
        ignoreFocusOut: true,
        validateInput: (value) => {
          try {
            new URL(value);
            return undefined;
          } catch {
            return 'Please enter a valid URL';
          }
        },
      });
      if (url === undefined) { return; } // cancelled

      const apiKey = await vscode.window.showInputBox({
        title: 'LLM Gateway — API Key',
        prompt: 'Enter the API key — saved to VS Code\'s secret storage. Leave empty to clear.',
        password: true,
        placeHolder: 'Optional',
        ignoreFocusOut: true,
      });
      if (apiKey === undefined) { return; } // cancelled

      // Let the user choose Workspace vs. User scope so different VS Code
      // windows can point at different inference servers (issue #23). Only
      // applies to `serverUrl` — the API key is always global because
      // SecretStorage isn't workspace-aware.
      const target = await pickConfigurationTarget(config);
      if (target === undefined) { return; } // cancelled

      await config.update('serverUrl', url, target);
      await provider.setApiKey(apiKey);

      // The config-change listener handles reloadConfig + model refresh
      // automatically, but we also refresh the status bar here.
      provider.invalidateModelCache();
      provider.refreshModels();
      await refreshStatusBar();

      await offerAdvancedSettings(provider);
    }
  );

  context.subscriptions.push(manageCommand);

  // "Edit Custom Headers" command — lets users manage additional HTTP
  // headers (e.g. `Authorization: Token …`, `Anthropic-Version`) without
  // touching settings.json. Values are persisted via SecretStorage because
  // these headers commonly carry credentials (issue #28).
  const editHeadersCommand = vscode.commands.registerCommand(
    'github.copilot.llm-gateway.editCustomHeaders',
    async () => {
      await editCustomHeadersFlow(provider);
      provider.invalidateModelCache();
      provider.refreshModels();
      await refreshStatusBar();
    }
  );

  context.subscriptions.push(editHeadersCommand);

  // Explicit "Refresh Models" command — previously users could only trigger
  // a re-fetch by editing settings, which was confusing when models
  // temporarily went missing.
  const refreshCommand = vscode.commands.registerCommand(
    'github.copilot.llm-gateway.refreshModels',
    async () => {
      // Invalidate the provider's cache so the next fetch is fresh, then
      // fire the change event (VS Code will re-call
      // provideLanguageModelChatInformation on its own schedule) and
      // update the status bar immediately.
      provider.invalidateModelCache();
      provider.refreshModels();
      await refreshStatusBar();
    }
  );

  context.subscriptions.push(refreshCommand);
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  // no-op
}

/**
 * After the basic Configure Server flow, offer the user a chance to edit
 * custom headers (kept in SecretStorage, issue #28) or jump to the Settings
 * UI for the remaining non-secret options.
 */
async function offerAdvancedSettings(provider: GatewayProvider): Promise<void> {
  const completePick: vscode.QuickPickItem = {
    label: 'Complete',
    description: 'Finish configuration',
  };
  const headersPick: vscode.QuickPickItem = {
    label: 'Edit custom headers...',
    description: 'Add or remove HTTP headers (stored in secret storage)',
  };
  const advancedPick: vscode.QuickPickItem = {
    label: 'Edit advanced settings...',
    description: 'Extra model options, timeouts, logging',
  };

  const pick = await vscode.window.showQuickPick(
    [completePick, headersPick, advancedPick],
    {
      title: 'LLM Gateway — Configuration saved',
      placeHolder: 'Done, or continue to advanced options?',
      ignoreFocusOut: true,
    }
  );
  if (pick === headersPick) {
    await editCustomHeadersFlow(provider);
  } else if (pick === advancedPick) {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'github.copilot.llm-gateway'
    );
  }
}

interface HeaderQuickPickItem extends vscode.QuickPickItem {
  action: 'add' | 'edit' | 'clear' | 'done';
  headerName?: string;
}

/**
 * Quick-pick driven editor for custom headers persisted in SecretStorage.
 * Shows only header names (not values) so peeking at someone else's screen
 * doesn't leak credentials, and supports add / edit / delete / clear-all.
 */
async function editCustomHeadersFlow(provider: GatewayProvider): Promise<void> {
  while (true) {
    const headers = provider.getCustomHeadersSnapshot();
    const headerNames = Object.keys(headers).sort((a, b) => a.localeCompare(b));
    const items = buildHeaderQuickPickItems(headerNames);

    const pick = await vscode.window.showQuickPick(items, {
      title: `LLM Gateway — Custom Headers (${headerNames.length})`,
      placeHolder:
        headerNames.length === 0
          ? 'No custom headers yet. Add one or close.'
          : 'Select a header to edit, or add a new one',
      ignoreFocusOut: true,
    });
    if (!pick || pick.action === 'done') { return; }

    if (pick.action === 'add') {
      await addHeader(provider, headers);
    } else if (pick.action === 'clear') {
      await confirmAndClearHeaders(provider, headerNames.length);
    } else if (pick.action === 'edit' && pick.headerName) {
      await editOrDeleteHeader(provider, headers, pick.headerName);
    }
  }
}

/**
 * Build the quick-pick items for the custom-headers editor. Pulled out so
 * `editCustomHeadersFlow` stays under SonarCloud's cognitive-complexity
 * budget — and so the item shape lives next to its uses.
 */
function buildHeaderQuickPickItems(headerNames: readonly string[]): HeaderQuickPickItem[] {
  const items: HeaderQuickPickItem[] = [
    { label: 'Done', description: 'Save and close', action: 'done' },
    { label: '$(add) Add header...', description: 'Add a new header', action: 'add' },
  ];
  if (headerNames.length === 0) {
    return items;
  }
  items.push(
    {
      label: '$(trash) Clear all headers',
      description: 'Remove every custom header',
      action: 'clear',
    },
    {
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
      action: 'done',
    },
    ...headerNames.map<HeaderQuickPickItem>((name) => ({
      label: name,
      description: 'Edit or remove (value hidden)',
      action: 'edit',
      headerName: name,
    }))
  );
  return items;
}

async function confirmAndClearHeaders(provider: GatewayProvider, count: number): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Remove all ${count} custom header(s)?`,
    { modal: true },
    'Remove'
  );
  if (confirm === 'Remove') {
    await provider.setCustomHeaders({});
  }
}

async function addHeader(
  provider: GatewayProvider,
  current: Record<string, string>
): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'LLM Gateway — New header name',
    prompt: 'e.g. Authorization, Anthropic-Version, HTTP-Referer',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (value.trim().length === 0) { return 'Header name cannot be empty'; }
      if (/[^\w-]/.test(value)) { return 'Header names typically only contain letters, digits, and dashes'; }
      return undefined;
    },
  });
  if (!name) { return; }
  const value = await vscode.window.showInputBox({
    title: `LLM Gateway — Value for ${name}`,
    prompt: 'Saved to VS Code\'s secret storage',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) { return; }
  await provider.setCustomHeaders({ ...current, [name.trim()]: value });
}

async function editOrDeleteHeader(
  provider: GatewayProvider,
  current: Record<string, string>,
  name: string
): Promise<void> {
  const action = await vscode.window.showQuickPick(
    [
      { label: 'Edit value', description: 'Replace the current value' },
      { label: 'Remove header', description: 'Delete this header entirely' },
    ],
    {
      title: `LLM Gateway — ${name}`,
      placeHolder: 'Choose an action',
      ignoreFocusOut: true,
    }
  );
  if (!action) { return; }

  if (action.label === 'Remove header') {
    const next = { ...current };
    delete next[name];
    await provider.setCustomHeaders(next);
    return;
  }

  const value = await vscode.window.showInputBox({
    title: `LLM Gateway — New value for ${name}`,
    prompt: 'Saved to VS Code\'s secret storage',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) { return; }
  await provider.setCustomHeaders({ ...current, [name]: value });
}

/**
 * Asks the user whether to save settings to Workspace or User (Global) scope.
 * Returns undefined if cancelled, or skips the prompt and returns Global when
 * no workspace folder is open (the only meaningful scope in that case).
 *
 * Defaults the highlighted option to whichever scope already has a value, and
 * otherwise prefers Workspace when a folder is open — most users hitting this
 * picker want per-window configuration (issue #23).
 */
async function pickConfigurationTarget(
  config: vscode.WorkspaceConfiguration
): Promise<vscode.ConfigurationTarget | undefined> {
  const hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  if (!hasWorkspaceFolder) {
    return vscode.ConfigurationTarget.Global;
  }

  const inspection = config.inspect('serverUrl');
  const workspacePick: vscode.QuickPickItem = {
    label: 'Workspace Settings',
    description: inspection?.workspaceValue === undefined ? undefined : '(currently set)',
    detail: 'Apply to this workspace only — different VS Code windows can use different servers.',
  };
  const globalPick: vscode.QuickPickItem = {
    label: 'User Settings (Global)',
    description: inspection?.globalValue === undefined ? undefined : '(currently set)',
    detail: 'Apply to all VS Code windows.',
  };

  const items = inspection?.globalValue !== undefined && inspection?.workspaceValue === undefined
    ? [globalPick, workspacePick]
    : [workspacePick, globalPick];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'LLM Gateway — Save settings to',
    placeHolder: 'Choose where these settings should apply',
    ignoreFocusOut: true,
  });
  if (!pick) { return undefined; }

  return pick === workspacePick
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}
