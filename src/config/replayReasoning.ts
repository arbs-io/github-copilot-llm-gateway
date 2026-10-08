/**
 * Resolve whether a model's earlier reasoning is replayed as
 * `reasoning_content`.
 *
 * `replayReasoning` is one switch for every model, but a gateway such as
 * LiteLLM can serve DeepSeek (which needs the field with tools) next to
 * OpenAI models (which may reject it). `replayReasoningModels` overrides the
 * switch per model id, with the same key matching as `modelContextWindows`:
 * an exact id wins, otherwise the last matching `*` wildcard applies.
 */
import { matchesWildcard } from './perModelOptions';

export function resolveReplayReasoning(
  modelId: string,
  config: { replayReasoning: boolean; replayReasoningModels: Record<string, boolean> }
): boolean {
  let wildcardMatch: boolean | undefined;
  for (const [pattern, value] of Object.entries(config.replayReasoningModels)) {
    if (typeof value !== 'boolean') {
      continue;
    }
    if (pattern === modelId) {
      return value;
    }
    if (pattern.includes('*') && matchesWildcard(pattern, modelId)) {
      wildcardMatch = value;
    }
  }
  return wildcardMatch ?? config.replayReasoning;
}
