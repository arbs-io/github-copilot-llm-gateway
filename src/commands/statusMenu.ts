import * as vscode from 'vscode';
import { GatewayProvider } from '../provider/gatewayProvider';
import { StatusMenuItem, ToggleSetting, buildStatusMenu } from '../status/statusMenu';
import { setThinkingEffortFlow } from './thinkingEffort';

const CONFIG_SECTION = 'github.copilot.llm-gateway';

interface StatusQuickPickItem extends vscode.QuickPickItem {
  readonly item: StatusMenuItem;
}

/**
 * Status-bar click handler: a Quick Pick laid out like Copilot's status popup.
 * Toggles flip their setting and re-open the menu so the change is visible in
 * place, like ticking a checkbox; every other row runs its action and closes.
 */
export async function showStatusMenu(provider: GatewayProvider): Promise<void> {
  // Loop so a toggle re-renders the menu with the new state. Bounded by the
  // user closing the pick or choosing a non-toggle row.
  while (true) {
    const snapshot = provider.getStatusSnapshot();
    const items = buildStatusMenu(snapshot).map(toQuickPickItem);

    const picked = await vscode.window.showQuickPick(items, {
      title: `LLM Gateway — ${snapshot.host || 'not configured'}`,
      placeHolder: 'Select an action, or toggle a feature',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: false,
    });
    if (!picked) {
      return;
    }

    const { action } = picked.item;
    switch (action.kind) {
      case 'toggle':
        await flipSetting(action.setting, action.enabled);
        continue;
      case 'command':
        await vscode.commands.executeCommand(action.command, ...(action.args ?? []));
        return;
      case 'thinkingEffort':
        await setThinkingEffortFlow(provider, action.modelId);
        return;
      case 'none':
        // Informational row — behave like the popup and just stay open.
        continue;
      default: {
        const _never: never = action;
        throw new Error(`Unexpected menu action: ${String(_never)}`);
      }
    }
  }
}

function toQuickPickItem(item: StatusMenuItem): StatusQuickPickItem {
  if (item.separator) {
    return { label: item.label, kind: vscode.QuickPickItemKind.Separator, item };
  }
  return {
    label: item.label,
    ...(item.description ? { description: item.description } : {}),
    ...(item.detail ? { detail: item.detail } : {}),
    item,
  };
}

/**
 * Flip a boolean setting in whichever scope currently defines it (folder →
 * workspace → user) so a workspace override isn't shadowed by a new
 * user-level value. Defaults to user settings when unset everywhere.
 */
async function flipSetting(setting: ToggleSetting, currentlyEnabled: boolean): Promise<void> {
  const settings = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const inspected = settings.inspect<boolean>(setting);
  let target = vscode.ConfigurationTarget.Global;
  if (inspected?.workspaceFolderValue !== undefined) {
    target = vscode.ConfigurationTarget.WorkspaceFolder;
  } else if (inspected?.workspaceValue !== undefined) {
    target = vscode.ConfigurationTarget.Workspace;
  }
  await settings.update(setting, !currentlyEnabled, target);
}
