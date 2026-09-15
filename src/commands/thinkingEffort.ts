import * as vscode from 'vscode';
import { GatewayProvider } from '../provider/gatewayProvider';
import {
  THINKING_EFFORT_PRESETS,
  ThinkingEffortPreset,
  applyThinkingEffort,
  resolveThinkingEffort,
} from '../config/thinkingEffort';

const CONFIG_SECTION = 'github.copilot.llm-gateway';
const PER_MODEL_OPTIONS_KEY = 'perModelOptions';

interface ModelPickItem extends vscode.QuickPickItem {
  modelId: string;
}

interface EffortPickItem extends vscode.QuickPickItem {
  preset?: ThinkingEffortPreset;
  custom?: true;
}

/**
 * Quick-pick flow behind the "Set Thinking Effort" command (issue #82):
 * choose a gateway model, then a preset (or a custom value), and persist it
 * to `perModelOptions[modelId][thinkingEffortParameter]`. The provider
 * reloads its config on the settings change, so the next request picks the
 * value up without a model refresh.
 */
export async function setThinkingEffortFlow(provider: GatewayProvider): Promise<void> {
  const models = await listModels(provider);
  if (models.length === 0) {
    vscode.window.showWarningMessage(
      'GitHub Copilot LLM Gateway: No models available. Check the server connection first.'
    );
    return;
  }

  const config = provider.getConfigSnapshot();
  const parameter = config.thinkingEffortParameter;

  const modelPick = await vscode.window.showQuickPick<ModelPickItem>(
    models.map((model) => {
      const current = resolveThinkingEffort(model.id, config.perModelOptions, parameter);
      return {
        label: model.name,
        description: model.id === model.name ? undefined : model.id,
        detail: current ? `Current: ${parameter} = ${current}` : `Current: server default (${parameter} not sent)`,
        modelId: model.id,
      };
    }),
    {
      title: 'LLM Gateway — Set Thinking Effort',
      placeHolder: 'Select a model',
      matchOnDescription: true,
      ignoreFocusOut: true,
    }
  );
  if (!modelPick) { return; }

  const current = resolveThinkingEffort(modelPick.modelId, config.perModelOptions, parameter);
  const effortItems: EffortPickItem[] = THINKING_EFFORT_PRESETS.map((preset) => ({
    label: preset.label,
    detail: preset.detail,
    description: preset.value !== undefined && preset.value === current ? '(current)' : undefined,
    preset,
  }));
  effortItems.push({
    label: 'Custom…',
    detail: `Enter any value your server accepts for ${parameter} (e.g. minimal, xhigh)`,
    custom: true,
  });

  const effortPick = await vscode.window.showQuickPick(effortItems, {
    title: `Thinking Effort — ${modelPick.label}`,
    placeHolder: `Choose the ${parameter} value to send for this model`,
    ignoreFocusOut: true,
  });
  if (!effortPick) { return; }

  let value: string | undefined;
  if (effortPick.custom) {
    const entered = await vscode.window.showInputBox({
      title: `Thinking Effort — ${modelPick.label}`,
      prompt: `Value to send as "${parameter}"`,
      value: current ?? '',
      ignoreFocusOut: true,
      validateInput: (text) => (text.trim().length === 0 ? 'Enter a value, or pick "Off" to clear it' : undefined),
    });
    if (entered === undefined) { return; }
    value = entered.trim();
  } else {
    value = effortPick.preset?.value;
  }

  await persistThinkingEffort(modelPick.modelId, value, parameter);

  vscode.window.showInformationMessage(
    value === undefined
      ? `GitHub Copilot LLM Gateway: ${modelPick.label} will use the server's default thinking effort.`
      : `GitHub Copilot LLM Gateway: ${modelPick.label} will send ${parameter} = ${value}.`
  );
}

/**
 * Write the choice back to whichever settings scope currently defines
 * `perModelOptions` (workspace-folder, workspace, or user), so a workspace
 * override isn't silently shadowed by a new user-level value. Defaults to
 * user settings when the key isn't set anywhere yet.
 */
async function persistThinkingEffort(
  modelId: string,
  value: string | undefined,
  parameter: string
): Promise<void> {
  const settings = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const inspected = settings.inspect<Record<string, unknown>>(PER_MODEL_OPTIONS_KEY);

  let target = vscode.ConfigurationTarget.Global;
  let existing = inspected?.globalValue;
  if (inspected?.workspaceFolderValue !== undefined) {
    target = vscode.ConfigurationTarget.WorkspaceFolder;
    existing = inspected.workspaceFolderValue;
  } else if (inspected?.workspaceValue !== undefined) {
    target = vscode.ConfigurationTarget.Workspace;
    existing = inspected.workspaceValue;
  }

  const next = applyThinkingEffort(existing, modelId, value, parameter);
  await settings.update(PER_MODEL_OPTIONS_KEY, next, target);
}

/** Cached model list, falling back to a fetch when nothing is cached yet. */
async function listModels(provider: GatewayProvider): Promise<vscode.LanguageModelChatInformation[]> {
  const cached = provider.getCachedModels();
  if (cached.length > 0) {
    return cached;
  }
  const cts = new vscode.CancellationTokenSource();
  try {
    return await provider.provideLanguageModelChatInformation({ silent: true }, cts.token);
  } catch {
    return [];
  } finally {
    cts.dispose();
  }
}
