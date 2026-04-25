import * as vscode from 'vscode';
import { GatewayProvider } from './provider';

const STATUS_BAR_PROBE_DELAY_MS = 1500;

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext): void {
  const provider = new GatewayProvider(context);

  const disposable = vscode.lm.registerLanguageModelChatProvider(
    'copilot-llm-gateway',
    provider
  );

  context.subscriptions.push(disposable);

  // Status bar entry so users can see connection state at a glance and
  // quickly refresh the model list. Without this, failed model fetches were
  // invisible unless users happened to open the model picker.
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.name = 'LLM Gateway';
  statusBar.command = 'github.copilot.llm-gateway.refreshModels';
  statusBar.text = '$(sync~spin) LLM Gateway';
  statusBar.tooltip = 'Click to refresh the LLM Gateway models';
  statusBar.show();
  context.subscriptions.push(statusBar);

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
        statusBar.text = `$(check) LLM Gateway: ${models.length}`;
        statusBar.tooltip = `LLM Gateway: ${models.length} model(s) available.\nClick to refresh.`;
      } else {
        statusBar.text = '$(warning) LLM Gateway: no models';
        statusBar.tooltip = 'No models reported by the inference server. Click to refresh.';
      }
    } catch {
      statusBar.text = '$(error) LLM Gateway';
      statusBar.tooltip = 'LLM Gateway connection failed. Click to refresh.';
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
          statusBar.text = `$(check) LLM Gateway: ${models.length}`;
          statusBar.tooltip = `LLM Gateway: ${models.length} model(s) available.\nClick to refresh.`;
          vscode.window.showInformationMessage(
            `GitHub Copilot LLM Gateway: Successfully connected! Found ${models.length} model(s): ${models.map((m) => m.name).join(', ')}`
          );
        } else {
          statusBar.text = '$(warning) LLM Gateway: no models';
          vscode.window.showWarningMessage(
            'GitHub Copilot LLM Gateway: Connected but no models found.'
          );
        }
      } catch (error) {
        statusBar.text = '$(error) LLM Gateway';
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
  // via the managementCommand contribution. Prompts for server URL and API
  // key, writes them to the extension's settings, and refreshes models.
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
        prompt: 'Enter the API key (leave empty if not required)',
        password: true,
        placeHolder: 'Optional',
        ignoreFocusOut: true,
      });
      if (apiKey === undefined) { return; } // cancelled

      await config.update('serverUrl', url, vscode.ConfigurationTarget.Global);
      if (apiKey) {
        await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
      }

      // The config-change listener handles reloadConfig + model refresh
      // automatically, but we also refresh the status bar here.
      provider.invalidateModelCache();
      await refreshStatusBar();
    }
  );

  context.subscriptions.push(manageCommand);

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
