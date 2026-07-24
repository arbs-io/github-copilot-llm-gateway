import * as vscode from 'vscode';
import { GatewayProvider } from '../provider/gatewayProvider';
import { RawBackendEntry } from '../config/backendConfig';

/**
 * "Add Backend" flow — prompts the user for a backend name, server URL, and
 * optional API key. Stores the backend entry in the `backends` setting and
 * the API key in SecretStorage.
 */
export async function addBackendFlow(
  provider: GatewayProvider,
  refreshStatusBar: () => Promise<void>
): Promise<void> {
  const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
  const existingBackends = config.get<Record<string, RawBackendEntry>>('backends', {}) ?? {};

  const name = await vscode.window.showInputBox({
    title: 'LLM Gateway — Add Backend',
    prompt: 'Enter a unique name for this backend (e.g. "local-vllm", "remote-ollama")',
    placeHolder: 'my-backend',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return 'Name cannot be empty';
      }
      if (/[^a-zA-Z0-9_-]/.test(trimmed)) {
        return 'Name must only contain letters, numbers, hyphens, and underscores';
      }
      if (existingBackends[trimmed]) {
        return `Backend "${trimmed}" already exists`;
      }
      return undefined;
    },
  });
  if (name === undefined) { return; }

  const url = await vscode.window.showInputBox({
    title: `LLM Gateway — Add Backend "${name}"`,
    prompt: 'Enter the inference server URL (OpenAI-compatible endpoint)',
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
  if (url === undefined) { return; }

  const apiKey = await vscode.window.showInputBox({
    title: `LLM Gateway — Add Backend "${name}"`,
    prompt: 'Enter the API key for this backend. Leave empty for unauthenticated servers.',
    password: true,
    placeHolder: 'Optional',
    ignoreFocusOut: true,
  });
  if (apiKey === undefined) { return; }

  // Store the backend entry in settings
  const newBackends = {
    ...existingBackends,
    [name.trim()]: { serverUrl: url } as RawBackendEntry,
  };

  // Determine scope
  const target = await pickConfigurationTarget();
  if (target === undefined) { return; }

  await config.update('backends', newBackends, target);

  // Store the API key in SecretStorage
  if (apiKey.trim().length > 0) {
    await provider.getSecretsManager().setBackendApiKey(name.trim(), apiKey);
  }

  // Trigger a config reload + model refresh
  provider.invalidateModelCache();
  provider.refreshModels();
  await refreshStatusBar();

  vscode.window.showInformationMessage(
    `GitHub Copilot LLM Gateway: Backend "${name.trim()}" added successfully.`
  );
}

/**
 * "Remove Backend" flow — shows a picker of existing backends and removes
 * the selected one from settings + SecretStorage.
 */
export async function removeBackendFlow(
  provider: GatewayProvider,
  refreshStatusBar: () => Promise<void>
): Promise<void> {
  const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
  const existingBackends = config.get<Record<string, RawBackendEntry>>('backends', {}) ?? {};
  const names = Object.keys(existingBackends);

  if (names.length === 0) {
    vscode.window.showInformationMessage(
      'GitHub Copilot LLM Gateway: No backends configured. Use the "Add Backend" command first.'
    );
    return;
  }

  const items: vscode.QuickPickItem[] = names.map((n) => ({
    label: n,
    description: existingBackends[n].serverUrl,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'LLM Gateway — Remove Backend',
    placeHolder: 'Select the backend to remove',
    ignoreFocusOut: true,
  });
  if (!picked) { return; }

  const backendName = picked.label;

  // Confirm removal
  const confirm = await vscode.window.showWarningMessage(
    `Remove backend "${backendName}" (${existingBackends[backendName].serverUrl})?`,
    { modal: true },
    'Remove'
  );
  if (confirm !== 'Remove') { return; }

  // Remove from settings
  const { [backendName]: _removed, ...remaining } = existingBackends;
  const target = await pickConfigurationTarget();
  if (target === undefined) { return; }

  const settingsValue = Object.keys(remaining).length > 0 ? remaining : undefined;
  await config.update('backends', settingsValue, target);

  // Remove secrets
  await provider.getSecretsManager().deleteBackendSecrets(backendName);

  // Trigger a config reload + model refresh
  provider.invalidateModelCache();
  provider.refreshModels();
  await refreshStatusBar();

  vscode.window.showInformationMessage(
    `GitHub Copilot LLM Gateway: Backend "${backendName}" removed.`
  );
}

/**
 * Ask user for workspace vs global configuration target.
 */
async function pickConfigurationTarget(): Promise<vscode.ConfigurationTarget | undefined> {
  const hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  if (!hasWorkspaceFolder) {
    return vscode.ConfigurationTarget.Global;
  }

  const workspacePick: vscode.QuickPickItem = {
    label: 'Workspace Settings',
    detail: 'Apply to this workspace only.',
  };
  const globalPick: vscode.QuickPickItem = {
    label: 'User Settings (Global)',
    detail: 'Apply to all VS Code windows.',
  };

  const pick = await vscode.window.showQuickPick([workspacePick, globalPick], {
    title: 'LLM Gateway — Save settings to',
    placeHolder: 'Choose where these settings should apply',
    ignoreFocusOut: true,
  });
  if (!pick) { return undefined; }

  return pick === workspacePick
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}
