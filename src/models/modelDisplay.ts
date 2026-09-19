/**
 * Helpers for turning raw OpenAI `/v1/models` entries into the shape that the
 * VS Code Copilot Chat model picker renders nicely.
 *
 * Kept as its own module so it can be unit-tested without VS Code.
 */

import { OpenAIModel } from '../api/types';
import { serverReportedContext } from '../chat/contextWindow';

/**
 * Produce a display-friendly short name for a model ID.
 *
 * Hugging-Face-style IDs contain an org prefix (`Qwen/Qwen3-8B`) that the
 * Copilot model picker renders verbatim with a slash. Strip the prefix so the
 * picker shows `Qwen3-8B` (the owner is still available on the tooltip).
 */
export function friendlyModelName(id: string): string {
  const slash = id.lastIndexOf('/');
  if (slash >= 0 && slash < id.length - 1) {
    return id.slice(slash + 1);
  }
  return id;
}

/**
 * The part of a model id that {@link friendlyModelName} strips: the
 * Hugging-Face org (`Qwen/Qwen3-8B` → `Qwen`) or, behind an aggregator such
 * as LiteLLM or Open WebUI, the upstream provider (`openrouter/deepseek-chat`
 * → `openrouter`). `undefined` when the id has no prefix. Surfaced in the
 * picker so two upstreams serving the same model name stay distinguishable
 * (issue #99).
 */
export function modelIdPrefix(id: string): string | undefined {
  const slash = id.lastIndexOf('/');
  if (slash <= 0 || slash >= id.length - 1) {
    return undefined;
  }
  return id.slice(0, slash);
}

/**
 * Choose the picker `name` for every model in a list. Names are the friendly
 * (post-slash) form, except where two ids would collapse to the same friendly
 * name — `deepseek/deepseek-chat` and `openrouter/deepseek-chat` behind
 * LiteLLM — in which case those models keep their full id so the chat
 * input's model button, which shows only `name`, still tells them apart
 * (issue #99). Comparison is case-sensitive, matching VS Code's treatment
 * of model ids.
 */
export function resolveDisplayNames(ids: readonly string[]): Map<string, string> {
  const idsByFriendlyName = new Map<string, string[]>();
  for (const id of ids) {
    const friendly = friendlyModelName(id);
    const group = idsByFriendlyName.get(friendly);
    if (group) {
      group.push(id);
    } else {
      idsByFriendlyName.set(friendly, [id]);
    }
  }
  const names = new Map<string, string>();
  for (const [friendly, group] of idsByFriendlyName) {
    for (const id of group) {
      names.set(id, group.length > 1 ? id : friendly);
    }
  }
  return names;
}

const FAMILY_KEYWORDS: Array<{ match: RegExp; family: string }> = [
  { match: /qwen/i, family: 'qwen' },
  { match: /llama/i, family: 'llama' },
  { match: /mistral/i, family: 'mistral' },
  { match: /mixtral/i, family: 'mixtral' },
  { match: /deepseek/i, family: 'deepseek' },
  { match: /phi/i, family: 'phi' },
  { match: /gemma/i, family: 'gemma' },
  { match: /gpt-?oss/i, family: 'gpt-oss' },
  { match: /yi[-_]/i, family: 'yi' },
  { match: /command[-_]?r/i, family: 'command-r' },
];

/**
 * Infer a VS Code `family` value from the model ID. Falls back to
 * `'llm-gateway'` so the picker still groups all gateway models together when
 * the family can't be determined.
 */
export function inferModelFamily(id: string): string {
  for (const { match, family } of FAMILY_KEYWORDS) {
    if (match.test(id)) { return family; }
  }
  return 'llm-gateway';
}

/**
 * Build a short description string highlighting context size and owner.
 * Used as the `detail` shown under the model name in the picker.
 */
export function describeModel(model: OpenAIModel): string {
  const context = serverReportedContext(model);
  const parts: string[] = [];
  if (context) {
    parts.push(`${formatTokens(context)} ctx`);
  }
  if (model.owned_by && model.owned_by !== 'organization-owner') {
    parts.push(model.owned_by);
  }
  return parts.join(' • ');
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) { return `${Math.round(n / 1_000_000)}M`; }
  if (n >= 1_000) { return `${Math.round(n / 1_000)}K`; }
  return String(n);
}

/**
 * Deduplicate a list of models by `id`, preserving first-seen order. Servers
 * occasionally return the same id twice (e.g. LoRA adapters sharing a base
 * model id); the picker shouldn't show duplicates.
 */
export function dedupeModels(models: readonly OpenAIModel[]): OpenAIModel[] {
  const seen = new Set<string>();
  const result: OpenAIModel[] = [];
  for (const model of models) {
    if (!seen.has(model.id)) {
      seen.add(model.id);
      result.push(model);
    }
  }
  return result;
}
