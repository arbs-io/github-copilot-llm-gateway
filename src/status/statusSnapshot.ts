/**
 * Shared data model behind both the status-bar tooltip and the status webview
 * panel. Pure module — no `vscode` imports — so the snapshot shape and the
 * formatting helpers can be unit-tested without the editor.
 */

import { formatTokenCount } from './statusBarController';
import { SessionStats, TokenUsage } from './sessionStats';

export type ConnectionState = 'ok' | 'error' | 'noModels' | 'unknown';

export interface ModelSummary {
  readonly id: string;
  readonly name: string;
  /** Pre-formatted context size (e.g. "131K ctx") or empty when unknown. */
  readonly contextLabel: string;
  /** Raw context window in tokens — used to compute "% of context used" bars. Undefined when the server didn't report it. */
  readonly totalContext?: number;
  /** Pre-formatted capability tags (e.g. ["tools", "vision"]). */
  readonly capabilityLabels: readonly string[];
}

export interface LastRequestInfo {
  readonly modelId: string;
  readonly modelName: string;
  readonly completedAt: number;
  readonly usage?: TokenUsage;
}

export interface FeatureFlags {
  readonly toolCalling: boolean;
  readonly imageInput: boolean;
  readonly parallelToolCalling: boolean;
  readonly agentTemperature: number;
}

export interface StatusSnapshot {
  readonly host: string;
  readonly connection: { readonly state: ConnectionState; readonly errorMessage?: string };
  readonly lastSuccessfulFetchAt?: number;
  readonly models: readonly ModelSummary[];
  readonly sessionStats: SessionStats;
  readonly lastRequest?: LastRequestInfo;
  readonly features: FeatureFlags;
  /** Injected so relative-time output is deterministic in tests. */
  readonly now: number;
}

/**
 * Pre-format a model's context size into the short label the dialog renders
 * ("131K ctx", "8K ctx", or `''` when unknown).
 */
export function formatContextLabel(contextTokens: number | undefined): string {
  if (!contextTokens || contextTokens <= 0) {
    return '';
  }
  return `${formatTokenCount(contextTokens)} ctx`;
}

/**
 * Pre-format a model's capabilities into short tags ("tools", "vision"). Order
 * is stable so test assertions are stable.
 */
export function formatCapabilityLabels(capabilities: {
  readonly toolCalling?: boolean | number;
  readonly imageInput?: boolean;
}): readonly string[] {
  const labels: string[] = [];
  if (capabilities.toolCalling) {
    labels.push('tools');
  }
  if (capabilities.imageInput) {
    labels.push('vision');
  }
  return labels;
}
