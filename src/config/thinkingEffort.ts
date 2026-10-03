/**
 * Thinking-effort presets for gateway models (issue #82).
 *
 * Two ways to choose a level, both landing on the same request-body key:
 *
 * - **Model picker (preferred).** A model that declares a
 *   `configurationSchema` with a `navigation`-group property gets VS Code's
 *   native "Thinking Effort" control in the chat model picker — the same
 *   mechanism Copilot's built-in BYOK providers use. The user's choice comes
 *   back on every request as `options.modelConfiguration`. This is part of the
 *   `chatProvider` proposed API; VS Code reads the field from any provider, so
 *   it works for us without enabling the proposal, and older builds simply
 *   ignore it.
 * - **Set Thinking Effort command (fallback).** Writes the chosen level into
 *   `perModelOptions`, which already flows into the request body. It also
 *   seeds the picker's default, so the two stay consistent.
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
  const next: Record<string, unknown> = { ...perModelOptions };
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

/**
 * Key of the thinking-effort property in a model's `configurationSchema`, and
 * so of the value VS Code hands back in `options.modelConfiguration`. Matches
 * the key Copilot's built-in BYOK providers use.
 */
export const MODEL_CONFIG_EFFORT_KEY = 'reasoningEffort';

/** Picker value meaning "don't send the parameter; let the server decide". */
export const SERVER_DEFAULT_EFFORT = 'default';

/**
 * When the model picker offers Thinking Effort for a gateway model:
 * - `auto`: models the server reports as reasoning-capable, plus any model
 *   that already has an effort configured in `perModelOptions`.
 * - `all`: every gateway model.
 * - `off`: never (the Set Thinking Effort command still works).
 */
export type ThinkingEffortPickerMode = 'auto' | 'all' | 'off';

export function parseThinkingEffortPickerMode(value: unknown): ThinkingEffortPickerMode {
  return value === 'all' || value === 'off' ? value : 'auto';
}

/** Whether a model should get the Thinking Effort control in the picker. */
export function shouldOfferThinkingEffortPicker(
  mode: ThinkingEffortPickerMode,
  reasoningSupported: boolean | undefined,
  currentEffort: string | undefined
): boolean {
  if (mode === 'off') { return false; }
  if (mode === 'all') { return true; }
  return reasoningSupported === true || currentEffort !== undefined;
}

/**
 * Structural copy of VS Code's proposed `LanguageModelConfigurationSchema`
 * (the subset we emit), kept here so this module stays free of `vscode`.
 */
export interface ModelConfigurationSchema {
  readonly properties: {
    readonly [key: string]: {
      readonly type: 'string';
      readonly title: string;
      readonly enum: readonly string[];
      readonly enumItemLabels: readonly string[];
      readonly enumDescriptions: readonly string[];
      readonly default: string;
      readonly group: 'navigation';
    };
  };
}

/**
 * Build the `configurationSchema` that puts Thinking Effort in the model
 * picker. The default is whatever `perModelOptions` currently sends for the
 * model (so a level set with the command shows as selected), or "Server
 * default" when nothing is set. A custom value the presets don't cover —
 * `minimal`, or a numeric llama.cpp budget — is kept as an extra option
 * rather than silently replaced.
 */
export function buildThinkingEffortSchema(currentEffort: string | undefined): ModelConfigurationSchema {
  const values: string[] = [SERVER_DEFAULT_EFFORT];
  const labels: string[] = ['Server Default'];
  const descriptions: string[] = ["Don't send a thinking effort; use the server's default"];
  for (const preset of THINKING_EFFORT_PRESETS) {
    if (preset.value === undefined) { continue; }
    values.push(preset.value);
    labels.push(preset.label);
    descriptions.push(preset.detail);
  }
  if (currentEffort !== undefined && !values.includes(currentEffort)) {
    values.push(currentEffort);
    labels.push(currentEffort);
    descriptions.push('Custom value from perModelOptions');
  }
  return {
    properties: {
      [MODEL_CONFIG_EFFORT_KEY]: {
        type: 'string',
        title: 'Thinking Effort',
        enum: values,
        enumItemLabels: labels,
        enumDescriptions: descriptions,
        default: currentEffort ?? SERVER_DEFAULT_EFFORT,
        group: 'navigation',
      },
    },
  };
}

/**
 * Apply the picker's thinking-effort choice (from
 * `options.modelConfiguration`) to the merged request options. "Server
 * default" removes the parameter; any other value sets it. Without a picker
 * value — older VS Code, or a model with no schema — the options are returned
 * unchanged, so `perModelOptions` keeps working on its own.
 *
 * When the value is unchanged from a numeric setting (a llama.cpp
 * `reasoning_budget`, say), the original number is kept rather than replaced
 * by its string form.
 */
export function applyModelConfigurationEffort(
  options: Readonly<Record<string, unknown>>,
  modelConfiguration: unknown,
  parameter: string = DEFAULT_THINKING_EFFORT_PARAMETER
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...options };
  if (!isOptionsObject(modelConfiguration)) { return next; }
  const value = modelConfiguration[MODEL_CONFIG_EFFORT_KEY];
  if (typeof value !== 'string' || value.length === 0) { return next; }

  if (value === SERVER_DEFAULT_EFFORT) {
    delete next[parameter];
    return next;
  }
  const existing = next[parameter];
  next[parameter] = typeof existing === 'number' && String(existing) === value ? existing : value;
  return next;
}
