/**
 * Shared `StatusSnapshot` fixture for the status-bar surface tests (tooltip,
 * menu). Each suite pins its own `now` so relative-time labels stay stable.
 */

import { StatusSnapshot } from '../statusSnapshot';
import { emptySessionStats } from '../sessionStats';

export function makeStatusSnapshot(
  now: number,
  overrides: Partial<StatusSnapshot> = {}
): StatusSnapshot {
  return {
    host: 'localhost:8000',
    connection: { state: 'ok' },
    lastSuccessfulFetchAt: now - 120_000,
    models: [
      {
        id: 'qwen/Qwen3-8B',
        name: 'Qwen3-8B',
        contextLabel: '131k ctx',
        totalContext: 131_072,
        capabilityLabels: ['tools', 'vision'],
      },
    ],
    sessionStats: emptySessionStats(),
    features: {
      toolCalling: true,
      imageInput: true,
      parallelToolCalling: true,
      inlineCompletion: false,
      inlineCompletionModel: '',
      agentTemperature: 0,
    },
    now,
    ...overrides,
  };
}
