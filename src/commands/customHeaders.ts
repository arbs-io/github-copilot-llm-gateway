import * as vscode from 'vscode';
import { GatewayProvider } from '../provider/gatewayProvider';

interface HeaderQuickPickItem extends vscode.QuickPickItem {
  action: 'add' | 'edit' | 'clear' | 'done';
  headerName?: string;
}

/**
 * Quick-pick driven editor for custom headers persisted in SecretStorage.
 * Shows only header names (not values) so peeking at someone else's screen
 * doesn't leak credentials, and supports add / edit / delete / clear-all.
 */
export async function editCustomHeadersFlow(provider: GatewayProvider): Promise<void> {
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
