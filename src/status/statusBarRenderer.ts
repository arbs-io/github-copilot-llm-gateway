/**
 * Pure renderer for the LLM Gateway status bar.
 *
 * The status bar is context-aware: it shows a different summary depending on
 * whether the gateway is idle, actively streaming a response, has just
 * finished one, or is broken. Keeping the renderer pure (no `vscode` imports)
 * lets us unit-test every state's text + tooltip without standing up the
 * editor — the thin wrapper in `extension.ts` only has to map the result onto
 * a `StatusBarItem`.
 */

import { TokenUsage } from './sessionStats';
import { stripPort } from './format';

/**
 * Discriminated union of every state the status bar can be in. Each variant
 * carries exactly the data needed to render it — the controller doesn't need
 * to inspect anything outside the value.
 */
export type StatusBarState =
  | { readonly kind: 'probing'; readonly host: string }
  | {
      readonly kind: 'idle';
      readonly host: string;
      readonly modelCount: number;
      /** First several model IDs, for the tooltip preview. */
      readonly modelIds: readonly string[];
    }
  | {
      readonly kind: 'streaming';
      readonly host: string;
      readonly modelId: string;
      readonly modelName: string;
      /** Number of in-flight requests — when >1 we summarise instead of naming one model. */
      readonly activeCount: number;
    }
  | {
      readonly kind: 'responded';
      readonly host: string;
      readonly modelId: string;
      readonly modelName: string;
      readonly usage?: TokenUsage;
    }
  | {
      readonly kind: 'error';
      readonly host: string;
      readonly errorMessage: string;
    }
  | {
      readonly kind: 'noModels';
      readonly host: string;
    };

export interface StatusBarRender {
  readonly text: string;
  /**
   * Markdown source for the tooltip. The extension wraps this in a
   * `vscode.MarkdownString` with `supportThemeIcons = true`.
   */
  readonly tooltip: string;
}

/** Max model ids listed in the tooltip preview before we collapse to "and N more". */
const TOOLTIP_MODEL_LIST_MAX = 5;
/**
 * Codicon shown when the gateway is reachable. Matches the GHCP "running"
 * indicator so the bar reads as a connection light, not a notification.
 */
const ICON_CONNECTED = '$(vm-active)';
/**
 * Codicon shown when the gateway can't be reached (or we haven't probed yet).
 */
const ICON_DISCONNECTED = '$(vm-disconnect)';

/**
 * Render a status-bar text + tooltip for the given state. Exhaustive on the
 * union so adding a new variant is a compile error until handled here.
 */
export function renderStatusBar(state: StatusBarState): StatusBarRender {
  switch (state.kind) {
    case 'probing':
      return renderProbing(state);
    case 'idle':
      return renderIdle(state);
    case 'streaming':
      return renderStreaming(state);
    case 'responded':
      return renderResponded(state);
    case 'error':
      return renderError(state);
    case 'noModels':
      return renderNoModels(state);
    default: {
      const _never: never = state;
      throw new Error(`Unexpected status bar state: ${String(_never)}`);
    }
  }
}

function renderProbing(
  state: Extract<StatusBarState, { kind: 'probing' }>
): StatusBarRender {
  // Default to "disconnected" until the initial probe proves otherwise — a
  // false positive would be more confusing than a brief vm-disconnect flash
  // at activation.
  return {
    text: `${ICON_DISCONNECTED} ${stripPort(state.host) || 'gateway'}`,
    tooltip: '**LLM Gateway**\n\nChecking connection…',
  };
}

function renderIdle(state: Extract<StatusBarState, { kind: 'idle' }>): StatusBarRender {
  const text = `${ICON_CONNECTED} ${stripPort(state.host)}`;
  const tooltip = [
    '**LLM Gateway**',
    '',
    `Server: \`${state.host}\``,
    `Models: ${state.modelCount} available`,
    ...formatModelList(state.modelIds),
    '',
    'Click to open status',
  ].join('\n');
  return { text, tooltip };
}

function renderStreaming(
  state: Extract<StatusBarState, { kind: 'streaming' }>
): StatusBarRender {
  // Streaming = still connected, just busy. Keep the bar visually identical
  // to idle (per the simple two-icon scheme) and surface the active model in
  // the tooltip instead.
  const text = `${ICON_CONNECTED} ${stripPort(state.host)}`;
  const tooltip = [
    '**LLM Gateway**',
    '',
    state.activeCount > 1
      ? `Streaming ${state.activeCount} concurrent responses`
      : `Streaming response from \`${state.modelId}\`…`,
    `Server: \`${state.host}\``,
  ].join('\n');
  return { text, tooltip };
}

function renderResponded(
  state: Extract<StatusBarState, { kind: 'responded' }>
): StatusBarRender {
  const text = `${ICON_CONNECTED} ${stripPort(state.host)}`;
  const tooltipLines = [
    '**LLM Gateway**',
    '',
    `Last request: \`${state.modelId}\``,
    `Server: \`${state.host}\``,
  ];
  if (state.usage) {
    tooltipLines.push(
      '',
      `Tokens: ${state.usage.prompt.toLocaleString()} in / ` +
        `${state.usage.completion.toLocaleString()} out / ` +
        `${state.usage.total.toLocaleString()} total`
    );
  }
  return { text, tooltip: tooltipLines.join('\n') };
}

function renderError(state: Extract<StatusBarState, { kind: 'error' }>): StatusBarRender {
  const text = `${ICON_DISCONNECTED} ${stripPort(state.host)}`;
  const tooltip = [
    '**LLM Gateway — Connection failed**',
    '',
    `Server: \`${state.host}\``,
    '',
    `\`${state.errorMessage}\``,
    '',
    'Click to open status',
  ].join('\n');
  return { text, tooltip };
}

function renderNoModels(
  state: Extract<StatusBarState, { kind: 'noModels' }>
): StatusBarRender {
  // Server is reachable, just returned an empty model list — connection-wise
  // we're still up, so keep the vm-active icon. The "no models" detail lives
  // in the tooltip and the dialog.
  const text = `${ICON_CONNECTED} ${stripPort(state.host)}`;
  const tooltip = [
    '**LLM Gateway**',
    '',
    `Server: \`${state.host}\``,
    'Connected, but no models were reported.',
    '',
    'Click to open status',
  ].join('\n');
  return { text, tooltip };
}

function formatModelList(modelIds: readonly string[]): string[] {
  if (modelIds.length === 0) {
    return [];
  }
  const shown = modelIds.slice(0, TOOLTIP_MODEL_LIST_MAX);
  const lines = ['', ...shown.map((id) => `- \`${id}\``)];
  const hidden = modelIds.length - shown.length;
  if (hidden > 0) {
    lines.push(`- … and ${hidden} more`);
  }
  return lines;
}
