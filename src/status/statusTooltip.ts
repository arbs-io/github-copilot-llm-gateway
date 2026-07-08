/**
 * Renders the LLM Gateway status popup as the GHCP-style hover card. Lives in
 * the status-bar `MarkdownString` tooltip — the closest stable-API analogue
 * to GHCP's floating popup (which uses the proposed `chatStatusItem` API
 * marketplace extensions can't enable).
 *
 * Important sanitizer constraints (from `microsoft/vscode`
 * `markdownRenderer.ts` and `domSanitize.ts`):
 *
 *   - `style="…"` is **only allowed on `<span>`** and only matches the regex
 *     `^(color:VALUE;)?(background-color:VALUE;)?(border-radius:Npx;)?$` in
 *     that exact order. Values are `#hex` or `var(--vscode-foo-bar)`.
 *     `display`, `padding`, `margin`, `width`, `flex` on a `<div>` are
 *     silently stripped — every value must round-trip through that regex.
 *   - Tags allowed: `a`, `span`, `div`, `table`/`tr`/`td`/`th`, `details`/
 *     `summary`, `h1`-`h6`, `hr`, `strong`, `em`, `code`, `pre`, `ul`/`ol`/
 *     `li`, `br`. Most attributes other than `align`, `width`, `height`,
 *     `colspan`, `rowspan`, `href`, `title`, `target` are dropped.
 *   - `class="codicon codicon-NAME"` is allowed on `<span>` (alternative to
 *     the `$(name)` shorthand). We use `$(name)` for terseness.
 *
 * Everything renders as plain text if a style violates the regex, so the
 * helpers below build styles by string concatenation in the **mandated order**
 * (color → background-color → border-radius). The shape of the popup is
 * therefore: `<table>` rows for layout, `<span>` chips for badges, and
 * coloured unicode blocks for the progress bars.
 *
 * All user-controlled fields flow through {@link esc} before reaching the
 * HTML so a malicious model id or server URL can't inject markup.
 */

import {
  averageTokensPerRequest,
  formatRelativeTime,
} from './sessionStats';
import { formatTokenCount } from './format';
import {
  ConnectionState,
  ModelSummary,
  StatusSnapshot,
} from './statusSnapshot';

/** Commands referenced by the popup's footer action links. */
export const TOOLTIP_COMMANDS = {
  Refresh: 'github.copilot.llm-gateway.refreshModels',
  Configure: 'github.copilot.llm-gateway.manage',
  Output: 'github.copilot.llm-gateway.showOutput',
  TestConnection: 'github.copilot.llm-gateway.testConnection',
  EditHeaders: 'github.copilot.llm-gateway.editCustomHeaders',
  OpenSettings: 'workbench.action.openSettings',
} as const;

const SETTINGS_QUERY = 'github.copilot.llm-gateway';
/** Cap models listed in the popup; remainder collapses to "and N more". */
const TOOLTIP_MODEL_LIST_MAX = 8;
/**
 * Progress-bar width in `&nbsp;` cells. The bar is drawn as two coloured
 * `<span>` runs of non-breaking spaces; each `&nbsp;` is ~one character of
 * the tooltip font, so 40 cells gives roughly the same visual width GHCP's
 * native popup uses, with 2.5% granularity per cell.
 */
const PROGRESS_BAR_WIDTH = 40;

/** HTML-escape user-controlled text. */
export function esc(value: string | number | undefined | null): string {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

/**
 * Compose the full popup HTML for a snapshot. Empty sections (no session
 * yet, no last request, no models) are omitted so the popup stays compact.
 */
export function renderStatusTooltipHtml(snapshot: StatusSnapshot): string {
  return [
    renderHeader(snapshot),
    renderConnection(snapshot),
    renderSession(snapshot),
    renderLastRequest(snapshot),
    renderModels(snapshot),
    renderFeatures(snapshot),
    renderFooter(),
  ]
    .filter(Boolean)
    .join('\n');
}

function renderHeader(snapshot: StatusSnapshot): string {
  const host = snapshot.host || 'not configured';
  return [
    '<table width="100%"><tr>',
    `<td><strong>LLM Gateway</strong>&nbsp;${mutedSpan(esc(host))}</td>`,
    `<td align="right"><a href="command:${TOOLTIP_COMMANDS.Refresh}" title="Refresh model list">$(refresh) Refresh</a></td>`,
    '</tr></table>',
  ].join('');
}

function renderConnection(snapshot: StatusSnapshot): string {
  const desc = describeConnection(snapshot);
  const errorRow =
    snapshot.connection.state === 'error' && snapshot.connection.errorMessage
      ? `\n\n<pre>${esc(snapshot.connection.errorMessage)}</pre>`
      : '';
  return [
    '\n<hr>\n',
    '<table width="100%"><tr>',
    `<td>${desc.icon}&nbsp;${coloredSpan(`<strong>${esc(desc.label)}</strong>`, desc.color)}</td>`,
    desc.sideText
      ? `<td align="right">${mutedSpan(esc(desc.sideText))}</td>`
      : '<td></td>',
    '</tr></table>',
    errorRow,
  ].join('');
}

interface ConnectionDescriptor {
  icon: string;
  label: string;
  sideText: string;
  /** VS Code CSS variable suffix (with leading dash), e.g. "-charts-green". */
  color: string | undefined;
}

function describeConnection(snapshot: StatusSnapshot): ConnectionDescriptor {
  const state: ConnectionState = snapshot.connection.state;
  switch (state) {
    case 'ok':
      return {
        icon: '$(check)',
        label: 'Connected',
        sideText: snapshot.lastSuccessfulFetchAt
          ? `Last refresh: ${formatRelativeTime(snapshot.lastSuccessfulFetchAt, snapshot.now)}`
          : '',
        color: '-charts-green',
      };
    case 'noModels':
      return {
        icon: '$(warning)',
        label: 'Connected · empty',
        sideText: 'Server returned no models',
        color: '-editorWarning-foreground',
      };
    case 'error':
      return {
        icon: '$(error)',
        label: 'Disconnected',
        sideText: '',
        color: '-errorForeground',
      };
    case 'unknown':
      return {
        icon: '$(sync~spin)',
        label: 'Checking…',
        sideText: '',
        color: '-descriptionForeground',
      };
    default: {
      const _never: never = state;
      throw new Error(`Unknown connection state: ${String(_never)}`);
    }
  }
}

function renderSession(snapshot: StatusSnapshot): string {
  const s = snapshot.sessionStats;
  if (s.requestCount === 0) {
    return '';
  }
  const noun = s.requestCount === 1 ? 'request' : 'requests';
  const avg = averageTokensPerRequest(s);
  const avgText = avg > 0 ? ` · avg ${formatTokenCount(avg)}/req` : '';
  const ioRow =
    s.requestsWithUsage > 0
      ? `<tr><td colspan="2">${mutedSpan(
          `$(arrow-up) ${esc(s.promptTokens.toLocaleString())} in · $(arrow-down) ${esc(s.completionTokens.toLocaleString())} out`
        )}</td></tr>`
      : '';
  return [
    '\n<hr>\n',
    '<strong>Session usage</strong>',
    '<table width="100%">',
    '<tr>',
    `<td><strong>${esc(s.requestCount.toLocaleString())}</strong>&nbsp;${mutedSpan(esc(noun))}</td>`,
    `<td align="right">${mutedSpan(`${esc(formatTokenCount(s.totalTokens))} tokens${esc(avgText)}`)}</td>`,
    '</tr>',
    ioRow,
    '</table>',
  ].join('');
}

function renderLastRequest(snapshot: StatusSnapshot): string {
  const last = snapshot.lastRequest;
  if (!last) {
    return '';
  }
  const when = formatRelativeTime(last.completedAt, snapshot.now);
  const modelMatch = snapshot.models.find((m) => m.id === last.modelId);
  const totalContext = modelMatch?.totalContext;

  const rows: string[] = [];
  rows.push(
    '<tr>',
    `<td><strong>${esc(last.modelName)}</strong></td>`,
    `<td align="right">${mutedSpan(esc(when))}</td>`,
    '</tr>'
  );
  if (last.modelId !== last.modelName) {
    rows.push(`<tr><td colspan="2">${mutedSpan(esc(last.modelId))}</td></tr>`);
  }
  if (last.usage) {
    rows.push(
      `<tr><td colspan="2">${mutedSpan(
        `$(arrow-up) ${esc(last.usage.prompt.toLocaleString())} · $(arrow-down) ${esc(last.usage.completion.toLocaleString())} / ${esc(last.usage.total.toLocaleString())} total`
      )}</td></tr>`
    );
    if (totalContext && totalContext > 0) {
      const ratio = last.usage.total / totalContext;
      // Display percent rounds to int, but the bar receives the raw ratio so
      // tiny usage (e.g. 100 tokens of a 1M-context model = 0.01% → rounds
      // to 0) still shows a single filled cell rather than vanishing.
      const pct = Math.min(100, Math.round(ratio * 100));
      rows.push(
        `<tr><td colspan="2">${renderUsageBar(ratio)} ${mutedSpan(`${pct}% of ${esc(formatTokenCount(totalContext))} context`)}</td></tr>`
      );
    }
  } else {
    rows.push(`<tr><td colspan="2">${mutedSpan('usage not reported')}</td></tr>`);
  }

  return [
    '\n<hr>\n',
    '<strong>Last request</strong>',
    `<table width="100%">${rows.join('')}</table>`,
  ].join('');
}

/**
 * Render a thin coloured progress bar matching the native VS Code Copilot
 * status popup. The sanitizer won't let us touch `<div>` width or use a real
 * `<progress>` element, so the bar is drawn as two `background-color`-only
 * `<span>` runs of `&nbsp;` cells. Each cell is roughly one character wide;
 * the cell background paints across the cell, giving a continuous coloured
 * rectangle when consecutive cells share a colour.
 *
 * - Filled run uses `--vscode-progressBar-background` (the same token VS
 *   Code's own progress widgets pick up from the active theme).
 * - Track run uses `--vscode-input-background` for a subtle backdrop —
 *   visible enough to convey "this is the rest of the bar" without
 *   competing with the foreground.
 *
 * Takes the raw ratio (not a rounded percent) so tiny usage like 0.01% still
 * renders one filled cell — otherwise the caller's display rounding wipes
 * out the visual signal.
 */
function renderUsageBar(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const raw = clamped * PROGRESS_BAR_WIDTH;
  const filled = clamped > 0 ? Math.max(1, Math.round(raw)) : 0;
  const empty = PROGRESS_BAR_WIDTH - filled;
  const filledSpan =
    filled > 0
      ? `<span style="background-color:var(--vscode-progressBar-background);">${'&nbsp;'.repeat(filled)}</span>`
      : '';
  const emptySpan =
    empty > 0
      ? `<span style="background-color:var(--vscode-input-background);">${'&nbsp;'.repeat(empty)}</span>`
      : '';
  return filledSpan + emptySpan;
}

function renderModels(snapshot: StatusSnapshot): string {
  if (snapshot.models.length === 0) {
    return '';
  }
  const shown = snapshot.models.slice(0, TOOLTIP_MODEL_LIST_MAX);
  const rows = shown.map(renderModelRow).join('');
  const overflowRow =
    snapshot.models.length > TOOLTIP_MODEL_LIST_MAX
      ? `<tr><td colspan="2">${mutedSpan(
          `…and ${esc(snapshot.models.length - TOOLTIP_MODEL_LIST_MAX)} more`
        )}</td></tr>`
      : '';
  return [
    '\n<hr>\n',
    `<table width="100%"><tr><td><strong>Models</strong></td><td align="right">${mutedSpan(`${esc(snapshot.models.length)} available`)}</td></tr></table>`,
    `<table width="100%">${rows}${overflowRow}</table>`,
  ].join('');
}

function renderModelRow(model: ModelSummary): string {
  const pills = model.capabilityLabels.map((c) => capabilityPill(c)).join('&nbsp;');
  const meta = model.contextLabel ? mutedSpan(esc(model.contextLabel)) : '';
  return [
    '<tr>',
    `<td><code>${esc(model.name)}</code>${meta ? ` ${meta}` : ''}</td>`,
    `<td align="right">${pills}</td>`,
    '</tr>',
  ].join('');
}

function capabilityPill(label: string): string {
  // Allowed-style triplet: color → background-color → border-radius. No
  // padding allowed, so we wrap the label in non-breaking spaces to keep the
  // pill from collapsing to glyph-width.
  return `<span style="color:var(--vscode-badge-foreground);background-color:var(--vscode-badge-background);border-radius:4px;">&nbsp;${esc(label)}&nbsp;</span>`;
}

function renderFeatures(snapshot: StatusSnapshot): string {
  const f = snapshot.features;
  const featureRows = [
    featureRow('Tool calling', f.toolCalling),
    featureRow('Image input', f.imageInput),
    featureRow(
      'Parallel tool calls',
      f.parallelToolCalling,
      ` · temp ${f.agentTemperature.toFixed(1)}`
    ),
  ].join('');
  return [
    '\n<hr>\n',
    '<strong>Features</strong>',
    `<table width="100%">${featureRows}</table>`,
  ].join('');
}

function featureRow(label: string, enabled: boolean, suffix = ''): string {
  const icon = enabled ? '$(check)' : '$(circle-slash)';
  const statusLabel = enabled ? 'Enabled' : 'Disabled';
  const status = enabled
    ? `<span style="color:var(--vscode-charts-green);">${statusLabel}</span>`
    : mutedSpan(statusLabel);
  return `<tr><td>${icon}&nbsp;${esc(label)}</td><td align="right">${status}${esc(suffix)}</td></tr>`;
}

function renderFooter(): string {
  const c = TOOLTIP_COMMANDS;
  const settingsArg = encodeURIComponent(JSON.stringify(SETTINGS_QUERY));
  return [
    '\n<hr>\n',
    mutedSpan(
      'Configure additional behaviour in settings. Headers and API keys live in VS Code secret storage.'
    ),
    '\n\n',
    `[$(beaker) Test connection](command:${c.TestConnection}) · `,
    `[$(gear) Configure](command:${c.Configure}) · `,
    `[$(edit) Edit headers](command:${c.EditHeaders})`,
    '\n\n',
    `[$(settings-gear) Open settings](command:${c.OpenSettings}?${settingsArg}) · `,
    `[$(output) Show output log](command:${c.Output})`,
  ].join('');
}

/**
 * Wrap content in a `<span>` styled with one of VS Code's CSS variable colors.
 * `colorVar` is the suffix after `--vscode` (e.g. "-charts-green"). When
 * `colorVar` is `undefined`, returns the content unwrapped — useful for the
 * Connected state where the default theme color is fine.
 */
function coloredSpan(content: string, colorVar: string | undefined): string {
  if (!colorVar) {
    return content;
  }
  return `<span style="color:var(--vscode${colorVar});">${content}</span>`;
}

/** Shorthand for the description-foreground colour used by every "muted" run. */
function mutedSpan(content: string): string {
  return `<span style="color:var(--vscode-descriptionForeground);">${content}</span>`;
}
