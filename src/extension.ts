import * as vscode from 'vscode';
import { GatewayProvider } from './provider/gatewayProvider';
import { GatewayInlineCompletionProvider } from './completions/inlineCompletionProvider';
import { StatusBarManager } from './status/statusBarManager';
import { registerCommands } from './commands';

const STATUS_BAR_PROBE_DELAY_MS = 1500;

/**
 * Extension activation. Async so we can pull the API key + custom headers
 * out of SecretStorage (and migrate legacy plain-text settings, issue #28)
 * before registering the provider — otherwise the first model fetch races
 * the secret load and is sent unauthenticated.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new GatewayProvider(context);
  await provider.loadSecrets();

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider('copilot-llm-gateway', provider)
  );

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
  // model + token count after) — see status/statusBarRenderer.ts.
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

  registerCommands(context, provider, statusManager, refreshStatusBar);
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  // no-op
}
