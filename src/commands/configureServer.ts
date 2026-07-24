import * as vscode from 'vscode';
import { GatewayProvider } from '../provider/gatewayProvider';
import { RawBackendEntry } from '../config/backendConfig';
import { editCustomHeadersFlow } from './customHeaders';

/**
 * "Configure Server" / "Manage Backends" unified flow — triggered by the
 * "Add Models..." dropdown via the managementCommand contribution. Shows a
 * list of configured backends with options to add, edit, or remove.
 * All backend configuration lives in the `backends` setting object.
 */
export async function configureServerFlow(
  provider: GatewayProvider,
  refreshStatusBar: () => Promise<void>
): Promise<void> {
  const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
  const backends = config.get<Record<string, RawBackendEntry>>('backends', {}) ?? {};
  const names = Object.keys(backends);

  // Build the QuickPick list: existing backends + "Add new..."
  const items: vscode.QuickPickItem[] = [];

  for (const name of names) {
    items.push({
      label: `$(server) ${name}`,
      description: backends[name].serverUrl,
      detail: 'Edit or remove this backend',
    });
  }

  items.push({
    label: '$(add) Add new backend...',
    description: '',
    detail: 'Connect a new inference server',
  });

  if (names.length > 0) {
    items.push({
      label: '$(gear) Advanced settings...',
      description: '',
      detail: 'Extra model options, timeouts, logging',
    });
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: 'LLM Gateway — Manage Backends',
    placeHolder: names.length > 0
      ? `${names.length} backend(s) configured — select to edit, or add a new one`
      : 'No backends configured — add your first inference server',
    ignoreFocusOut: true,
  });
  if (!pick) { return; }

  if (pick.label === '$(add) Add new backend...') {
    await addBackendInteractive(provider, refreshStatusBar);
  } else if (pick.label === '$(gear) Advanced settings...') {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'github.copilot.llm-gateway'
    );
  } else {
    // Editing an existing backend — extract name from the label
    const backendName = pick.label.replace('$(server) ', '');
    await editBackendInteractive(provider, refreshStatusBar, backendName);
  }
}

/**
 * Interactive flow to add a new backend.
 */
async function addBackendInteractive(
  provider: GatewayProvider,
  refreshStatusBar: () => Promise<void>
): Promise<void> {
  const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
  const existingBackends = config.get<Record<string, RawBackendEntry>>('backends', {}) ?? {};

  const name = await vscode.window.showInputBox({
    title: 'LLM Gateway — Add Backend',
    prompt: 'Enter a unique name for this backend (e.g. "local-vllm", "dgx-spark-1")',
    placeHolder: 'my-backend',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) { return 'Name cannot be empty'; }
      if (/[^a-zA-Z0-9_-]/.test(trimmed)) {
        return 'Name must only contain letters, numbers, hyphens, and underscores';
      }
      if (existingBackends[trimmed]) { return `Backend "${trimmed}" already exists`; }
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
      try { new URL(value); return undefined; }
      catch { return 'Please enter a valid URL'; }
    },
  });
  if (url === undefined) { return; }

  const apiKey = await vscode.window.showInputBox({
    title: `LLM Gateway — Add Backend "${name}"`,
    prompt: 'API key for this backend (leave empty for unauthenticated servers)',
    password: true,
    placeHolder: 'Optional',
    ignoreFocusOut: true,
  });
  if (apiKey === undefined) { return; }

  const target = await pickConfigurationTarget();
  if (target === undefined) { return; }

  // Write the new backend entry
  const newBackends = { ...existingBackends, [name.trim()]: { serverUrl: url } as RawBackendEntry };
  await config.update('backends', newBackends, target);

  // Store API key in SecretStorage
  if (apiKey.trim().length > 0) {
    await provider.getSecretsManager().setBackendApiKey(name.trim(), apiKey);
  }

  provider.invalidateModelCache();
  provider.refreshModels();
  await refreshStatusBar();

  vscode.window.showInformationMessage(
    `GitHub Copilot LLM Gateway: Backend "${name.trim()}" added.`
  );
}

/**
 * Interactive flow to edit or remove an existing backend.
 */
async function editBackendInteractive(
  provider: GatewayProvider,
  refreshStatusBar: () => Promise<void>,
  backendName: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
  const backends = config.get<Record<string, RawBackendEntry>>('backends', {}) ?? {};
  const entry = backends[backendName];
  if (!entry) { return; }

  const editUrl: vscode.QuickPickItem = {
    label: '$(pencil) Edit Server URL',
    description: entry.serverUrl,
  };
  const editKey: vscode.QuickPickItem = {
    label: '$(key) Change API Key',
    description: 'Update the stored API key for this backend',
  };
  const editHeaders: vscode.QuickPickItem = {
    label: '$(list-flat) Edit Custom Headers',
    description: 'Add or remove HTTP headers',
  };
  const remove: vscode.QuickPickItem = {
    label: '$(trash) Remove Backend',
    description: `Delete "${backendName}" from configuration`,
  };

  const pick = await vscode.window.showQuickPick(
    [editUrl, editKey, editHeaders, remove],
    {
      title: `LLM Gateway — Backend "${backendName}"`,
      placeHolder: 'Choose an action',
      ignoreFocusOut: true,
    }
  );
  if (!pick) { return; }

  if (pick === editUrl) {
    const newUrl = await vscode.window.showInputBox({
      title: `LLM Gateway — Edit "${backendName}" URL`,
      prompt: 'Enter the new server URL',
      value: entry.serverUrl,
      ignoreFocusOut: true,
      validateInput: (value) => {
        try { new URL(value); return undefined; }
        catch { return 'Please enter a valid URL'; }
      },
    });
    if (newUrl === undefined) { return; }

    const target = await pickConfigurationTarget();
    if (target === undefined) { return; }

    const updated = { ...backends, [backendName]: { ...entry, serverUrl: newUrl } };
    await config.update('backends', updated, target);
  } else if (pick === editKey) {
    const newKey = await vscode.window.showInputBox({
      title: `LLM Gateway — API Key for "${backendName}"`,
      prompt: 'Enter the API key. Leave empty to clear.',
      password: true,
      placeHolder: 'Optional',
      ignoreFocusOut: true,
    });
    if (newKey === undefined) { return; }
    await provider.getSecretsManager().setBackendApiKey(backendName, newKey);
  } else if (pick === editHeaders) {
    await editCustomHeadersFlow(provider);
  } else if (pick === remove) {
    const confirm = await vscode.window.showWarningMessage(
      `Remove backend "${backendName}" (${entry.serverUrl})?`,
      { modal: true },
      'Remove'
    );
    if (confirm !== 'Remove') { return; }

    const target = await pickConfigurationTarget();
    if (target === undefined) { return; }

    const { [backendName]: _removed, ...remaining } = backends;
    const settingsValue = Object.keys(remaining).length > 0 ? remaining : undefined;
    await config.update('backends', settingsValue, target);
    await provider.getSecretsManager().deleteBackendSecrets(backendName);
  }

  provider.invalidateModelCache();
  provider.refreshModels();
  await refreshStatusBar();
}

/**
 * Auto-migrate the legacy `serverUrl` setting into the `backends` object.
 * Called once on activation. If `backends` is empty and `serverUrl` is set
 * to a non-default value, creates a "default" backend entry from it.
 */
export async function migrateLegacyServerUrl(_provider: GatewayProvider): Promise<void> {
  const config = vscode.workspace.getConfiguration('github.copilot.llm-gateway');
  const backends = config.get<Record<string, RawBackendEntry>>('backends', {}) ?? {};
  const serverUrl = config.get<string>('serverUrl', '');

  // Only migrate if backends is empty and serverUrl is set to something non-default
  if (Object.keys(backends).length > 0 || !serverUrl || serverUrl === 'http://localhost:8000') {
    return;
  }

  const newBackends: Record<string, RawBackendEntry> = {
    default: { serverUrl },
  };

  // Determine scope — prefer workspace if set there, else global
  const inspection = config.inspect<string>('serverUrl');
  const target = inspection?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

  await config.update('backends', newBackends, target);
  // Don't clear serverUrl — keep it for backward compat with older extension versions
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
