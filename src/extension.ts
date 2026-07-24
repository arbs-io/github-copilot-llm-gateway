import * as vscode from 'vscode';
import { GatewayProvider } from './provider/gatewayProvider';
import { GatewayInlineCompletionProvider } from './completions/inlineCompletionProvider';
import { StatusBarManager } from './status/statusBarManager';
import { HealthMonitor } from './status/healthMonitor';
import { registerCommands } from './commands';

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
  const probeStatusBar = async (signal?: AbortSignal): Promise<boolean> => {
    const cts = new vscode.CancellationTokenSource();
    const cancel = (): void => cts.cancel();
    if (signal?.aborted) {
      cts.dispose();
      return false;
    }
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const models = await provider.provideLanguageModelChatInformation(
        { silent: true },
        cts.token
      );
      if (signal?.aborted) { return false; }
      if (models.length > 0) {
        statusManager.setIdle(models.map((m) => m.id));
      } else {
        statusManager.setNoModels();
      }
      return true;
    } catch (error) {
      if (signal?.aborted) { return false; }
      statusManager.setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      signal?.removeEventListener('abort', cancel);
      cts.dispose();
    }
  };

  // Manual refreshes reuse the same silent probe but are not part of the
  // monitor's failure history.
  const refreshStatusBar = async (): Promise<void> => {
    await probeStatusBar();
  };

  // Start after the same 1.5s activation delay as the original one-shot
  // probe. Healthy gateways are sampled once a minute; failures back off from
  // 30s to five minutes. The monitor owns cancellation and never overlaps a
  // slow probe with the next scheduled run.
  context.subscriptions.push(new HealthMonitor({ probe: probeStatusBar }));

  registerCommands(context, provider, statusManager, refreshStatusBar);
}

/**
 * Extension deactivation
 */
export function deactivate(): void {
  // no-op
}
