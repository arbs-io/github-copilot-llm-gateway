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

      // Let the user choose Workspace vs. User scope so different VS Code
      // windows can point at different inference servers (issue #23).
      const target = await pickConfigurationTarget(config);
      if (target === undefined) { return; } // cancelled

      await config.update('serverUrl', url, target);
      if (apiKey) {
        await config.update('apiKey', apiKey, target);
      }

      // The config-change listener handles reloadConfig + model refresh
      // automatically, but we also refresh the status bar here.
      provider.invalidateModelCache();
      await refreshStatusBar();

      await offerAdvancedSettings();
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

/**
 * After the basic Configure Server flow, offer the user a chance to jump
 * straight to the Settings UI for advanced options (custom headers, extra
 * model options) that aren't worth dedicated InputBox steps. The Settings UI
 * is filtered to this extension so the headers key/value table is one click
 * away.
 */
async function offerAdvancedSettings(): Promise<void> {
  const completePick: vscode.QuickPickItem = {
    label: 'Complete',
    description: 'Finish configuration',
  };
  const advancedPick: vscode.QuickPickItem = {
    label: 'Edit advanced settings...',
    description: 'Custom headers, extra model options, timeouts, logging',
  };

  const pick = await vscode.window.showQuickPick([completePick, advancedPick], {
    title: 'LLM Gateway — Configuration saved',
    placeHolder: 'Done, or open advanced settings?',
    ignoreFocusOut: true,
  });
  if (pick === advancedPick) {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'github.copilot.llm-gateway'
    );
  }
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
    description: inspection?.workspaceValue !== undefined ? '(currently set)' : undefined,
    detail: 'Apply to this workspace only — different VS Code windows can use different servers.',
  };
  const globalPick: vscode.QuickPickItem = {
    label: 'User Settings (Global)',
    description: inspection?.globalValue !== undefined ? '(currently set)' : undefined,
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
