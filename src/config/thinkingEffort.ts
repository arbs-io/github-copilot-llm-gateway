/**
 * Thinking-effort presets for gateway models (issue #82).
 *
 * Copilot Chat shows a native "Thinking Effort" submenu for the reasoning
 * models it knows about, but third-party providers can't hook into that
 * menu: the public `LanguageModelChatInformation` carries no reasoning
 * capability and there is no contribution point for the per-model context
 * menu. So the extension owns the setting instead — a command writes the
 * chosen level into `perModelOptions`, which already flows into the request
 * body, and this module holds the pure helpers behind that command.
 *
 * The request-body key defaults to OpenAI's `reasoning_effort` (honoured by
 * vLLM, LiteLLM, and most OpenAI-compatible servers) but is configurable via
 * `thinkingEffortParameter` for backends that use another name.
 */

import { resolvePerModelOptions } from './perModelOptions';

/** Default request-body key the presets are written to. */
export const DEFAULT_THINKING_EFFORT_PARAMETER = 'reasoning_effort';

/**
 * Preset levels offered by the command. `off` removes the parameter rather
 * than sending a literal value — not every server accepts `"none"`, and an
 * absent key always falls back to the server's own default.
 */
export type ThinkingEffortLevel = 'off' | 'low' | 'medium' | 'high';

export interface ThinkingEffortPreset {
  readonly level: ThinkingEffortLevel;
  readonly label: string;
  readonly detail: string;
  /** Value written to the request body; `undefined` removes the key. */
  readonly value: string | undefined;
}

export const THINKING_EFFORT_PRESETS: readonly ThinkingEffortPreset[] = [
  { level: 'off', label: 'Off', detail: 'Do not send the parameter; use the server default', value: undefined },
  { level: 'low', label: 'Low', detail: 'Faster replies, minimal reasoning', value: 'low' },
  { level: 'medium', label: 'Medium', detail: 'Balanced reasoning and latency', value: 'medium' },
  { level: 'high', label: 'High', detail: 'Deeper reasoning, slower replies', value: 'high' },
];

/** A value is only usable as an options bag if it's a plain (non-array) object. */
function isOptionsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the thinking-effort value that currently applies to `modelId`, taking
 * wildcard and exact `perModelOptions` entries into account exactly as the
 * chat path does. Returns `undefined` when nothing is set.
 */
export function resolveThinkingEffort(
  modelId: string,
  perModelOptions: Record<string, unknown> | undefined,
  parameter: string = DEFAULT_THINKING_EFFORT_PARAMETER
): string | undefined {
  const value = resolvePerModelOptions(modelId, perModelOptions)[parameter];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/**
 * Return a copy of `perModelOptions` with `parameter` set to `value` on the
 * exact-id entry for `modelId` — or removed when `value` is `undefined`. An
 * entry left empty by the removal is dropped so the setting stays tidy.
 * Wildcard entries are never touched: an exact-id key already outranks them,
 * so writing there is enough to make the choice stick.
 */
export function applyThinkingEffort(
  perModelOptions: Record<string, unknown> | undefined,
  modelId: string,
  value: string | undefined,
  parameter: string = DEFAULT_THINKING_EFFORT_PARAMETER
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(perModelOptions ?? {}) };
  const existing = next[modelId];
  const entry: Record<string, unknown> = isOptionsObject(existing) ? { ...existing } : {};

  if (value === undefined) {
    delete entry[parameter];
  } else {
    entry[parameter] = value;
  }

  if (Object.keys(entry).length === 0) {
    delete next[modelId];
  } else {
    next[modelId] = entry;
  }
  return next;
}
