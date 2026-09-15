/**
 * Item model for the status-bar click menu.
 *
 * GitHub Copilot's status bar entry opens an anchored popup on click. That
 * popup is drawn by VS Code core with raw DOM and locked open via an internal
 * command the status bar matches by object identity, so extensions can't
 * reproduce it — the stable API offers a Markdown hover and a command id.
 * The closest native equivalent is a Quick Pick laid out the same way:
 * section headers, status rows with a right-aligned value, checkbox-style
 * toggles that flip a setting in place, and the action links.
 *
 * Pure module (no `vscode` import) so the menu contents can be unit-tested
 * from a {@link StatusSnapshot}; `commands/statusMenu.ts` maps these items
 * onto `QuickPickItem`s and runs the chosen action.
 */

import { formatTokenCount } from './format';
import { formatRelativeTime } from './sessionStats';
import { StatusSnapshot } from './statusSnapshot';

/** Boolean settings the menu can flip, keyed by their setting name. */
export type ToggleSetting =
  | 'enableInlineCompletion'
  | 'enableToolCalling'
  | 'parallelToolCalling'
  | 'enableImageInput';

export type StatusMenuAction =
  | { readonly kind: 'command'; readonly command: string; readonly args?: readonly unknown[] }
  | { readonly kind: 'toggle'; readonly setting: ToggleSetting; readonly enabled: boolean }
  | { readonly kind: 'thinkingEffort'; readonly modelId?: string }
  | { readonly kind: 'none' };

export interface StatusMenuItem {
  readonly label: string;
  /** Dimmed text to the right of the label — the popup's right-hand value column. */
  readonly description?: string;
  /** Optional second line under the label. */
  readonly detail?: string;
  /** Section header; other fields are ignored except `label`. */
  readonly separator?: true;
  readonly action: StatusMenuAction;
}

export const STATUS_MENU_COMMANDS = {
  Refresh: 'github.copilot.llm-gateway.refreshModels',
  Configure: 'github.copilot.llm-gateway.manage',
  Output: 'github.copilot.llm-gateway.showOutput',
  TestConnection: 'github.copilot.llm-gateway.testConnection',
  EditHeaders: 'github.copilot.llm-gateway.editCustomHeaders',
  OpenSettings: 'workbench.action.openSettings',
} as const;

const SETTINGS_QUERY = 'github.copilot.llm-gateway';
/** Models listed in the menu before collapsing to "and N more". */
export const STATUS_MENU_MODEL_LIST_MAX = 6;
/** Width of the text meter drawn under the last request row. */
const METER_WIDTH = 20;

const ENABLED_ICON = '$(check)';
const DISABLED_ICON = '$(blank)';

function separator(label: string): StatusMenuItem {
  return { label, separator: true, action: { kind: 'none' } };
}

function command(
  label: string,
  commandId: string,
  description?: string,
  args?: readonly unknown[]
): StatusMenuItem {
  return {
    label,
    ...(description ? { description } : {}),
    action: { kind: 'command', command: commandId, ...(args ? { args } : {}) },
  };
}

function toggle(label: string, setting: ToggleSetting, enabled: boolean, note = ''): StatusMenuItem {
  return {
    label: `${enabled ? ENABLED_ICON : DISABLED_ICON} ${label}`,
    description: [enabled ? 'Enabled' : 'Disabled', note].filter(Boolean).join(' · '),
    action: { kind: 'toggle', setting, enabled },
  };
}

/**
 * Draw a fixed-width usage meter from a raw ratio. Rounds up so tiny usage
 * still shows one filled cell, mirroring the hover's bar.
 */
export function renderTextMeter(ratio: number, width = METER_WIDTH): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = clamped > 0 ? Math.max(1, Math.round(clamped * width)) : 0;
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function connectionItems(snapshot: StatusSnapshot): StatusMenuItem[] {
  const { state, errorMessage } = snapshot.connection;
  const lastFetch = snapshot.lastSuccessfulFetchAt
    ? formatRelativeTime(snapshot.lastSuccessfulFetchAt, snapshot.now)
    : undefined;

  switch (state) {
    case 'ok':
      return [
        command(
          '$(check) Connected',
          STATUS_MENU_COMMANDS.Refresh,
          lastFetch ? `Last refresh ${lastFetch}` : undefined
        ),
      ];
    case 'noModels':
      return [
        command('$(warning) Connected · no models', STATUS_MENU_COMMANDS.Refresh, 'Server returned an empty list'),
      ];
    case 'error':
      return [
        {
          label: '$(error) Disconnected',
          ...(lastFetch ? { description: `Last success ${lastFetch}` } : {}),
          ...(errorMessage ? { detail: errorMessage } : {}),
          action: { kind: 'command', command: STATUS_MENU_COMMANDS.TestConnection },
        },
      ];
    case 'unknown':
      return [command('$(sync~spin) Checking connection…', STATUS_MENU_COMMANDS.TestConnection)];
    default: {
      const _never: never = state;
      throw new Error(`Unknown connection state: ${String(_never)}`);
    }
  }
}

function sessionItems(snapshot: StatusSnapshot): StatusMenuItem[] {
  const stats = snapshot.sessionStats;
  const items: StatusMenuItem[] = [];

  const requests = `${stats.requestCount} request${stats.requestCount === 1 ? '' : 's'}`;
  items.push({
    label: '$(graph) Session usage',
    description:
      stats.requestCount === 0
        ? 'No requests yet'
        : `${requests} · ${formatTokenCount(stats.totalTokens)} tokens (${formatTokenCount(stats.promptTokens)} in / ${formatTokenCount(stats.completionTokens)} out)`,
    action: { kind: 'none' },
  });

  const last = snapshot.lastRequest;
  if (last) {
    const when = formatRelativeTime(last.completedAt, snapshot.now);
    const parts = [last.modelName, when];
    let detail: string | undefined;
    if (last.usage) {
      parts.push(`${formatTokenCount(last.usage.total)} tokens`);
      const model = snapshot.models.find((m) => m.id === last.modelId);
      if (model?.totalContext) {
        const ratio = last.usage.total / model.totalContext;
        const pct = Math.min(100, Math.round(ratio * 100));
        detail = `${renderTextMeter(ratio)}  ${pct}% of ${formatTokenCount(model.totalContext)} context`;
      }
    }
    items.push({
      label: '$(clock) Last request',
      description: parts.join(' · '),
      ...(detail ? { detail } : {}),
      action: { kind: 'none' },
    });
  }
  return items;
}

function modelItems(snapshot: StatusSnapshot): StatusMenuItem[] {
  const shown = snapshot.models.slice(0, STATUS_MENU_MODEL_LIST_MAX);
  const items: StatusMenuItem[] = shown.map((model) => ({
    label: `$(sparkle) ${model.name}`,
    description: [model.contextLabel, ...model.capabilityLabels].filter(Boolean).join(' · '),
    detail: model.id === model.name ? undefined : model.id,
    action: { kind: 'thinkingEffort', modelId: model.id },
  }));
  const remaining = snapshot.models.length - shown.length;
  if (remaining > 0) {
    items.push(command(`$(ellipsis) and ${remaining} more`, STATUS_MENU_COMMANDS.Refresh, 'Refresh to re-list'));
  }
  return items;
}

function featureItems(snapshot: StatusSnapshot): StatusMenuItem[] {
  const f = snapshot.features;
  const inlineModel = f.inlineCompletionModel ? f.inlineCompletionModel : 'first model';
  return [
    toggle('Inline suggestions', 'enableInlineCompletion', f.inlineCompletion, inlineModel),
    toggle('Tool calling', 'enableToolCalling', f.toolCalling),
    toggle('Parallel tool calls', 'parallelToolCalling', f.parallelToolCalling),
    toggle('Image input', 'enableImageInput', f.imageInput),
    {
      label: '$(lightbulb) Thinking effort…',
      description: 'Per-model reasoning effort',
      action: { kind: 'thinkingEffort' },
    },
  ];
}

function actionItems(): StatusMenuItem[] {
  const c = STATUS_MENU_COMMANDS;
  return [
    command('$(refresh) Refresh models', c.Refresh),
    command('$(beaker) Test connection', c.TestConnection),
    command('$(gear) Configure server…', c.Configure),
    command('$(key) Edit custom headers…', c.EditHeaders),
    command('$(settings-gear) Open settings', c.OpenSettings, undefined, [SETTINGS_QUERY]),
    command('$(output) Show output log', c.Output),
  ];
}

/**
 * Build the full menu for a snapshot. Sections mirror the hover popup so the
 * two surfaces read the same: connection, session, models, features, actions.
 */
export function buildStatusMenu(snapshot: StatusSnapshot): StatusMenuItem[] {
  const items: StatusMenuItem[] = [];
  items.push(separator(snapshot.host || 'LLM Gateway'), ...connectionItems(snapshot));
  items.push(separator('Session'), ...sessionItems(snapshot));
  if (snapshot.models.length > 0) {
    items.push(separator(`Models (${snapshot.models.length})`), ...modelItems(snapshot));
  }
  items.push(separator('Features'), ...featureItems(snapshot));
  items.push(separator('Actions'), ...actionItems());
  return items;
}
