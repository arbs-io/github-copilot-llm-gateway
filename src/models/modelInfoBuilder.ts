/**
 * Build the `LanguageModelChatInformation` object that VS Code's model picker
 * renders. Kept as its own module so the picker-facing shape (especially the
 * first-party-style `detail`/`multiplierNumeric` fields) can be unit-tested
 * without standing up the full provider.
 */

import { OpenAIModel } from '../api/types';
import {
  describeModel,
  friendlyModelName,
  inferModelFamily,
  modelIdPrefix,
} from './modelDisplay';
import {
  hasSeparateOutputWindow,
  serverReportedContext,
  serverReportedMaxOutput,
} from '../chat/contextWindow';
import { TOKEN_CONSTANTS } from '../chat/tokenBudget';
import type { ModelConfigurationSchema } from '../config/thinkingEffort';

/**
 * Grey right-hand label rendered next to the model in VS Code's chat model
 * picker. Matches the shape native Copilot Chat BYOK providers use (e.g.
 * `detail: 'Anthropic'`). Grouping in the picker is by vendor, not by this
 * string, so it may vary per model.
 */
export const PROVIDER_DETAIL_LABEL = 'LLM Gateway';

/**
 * Picker `detail` for a model id. Ids with a prefix — a Hugging-Face org on
 * vLLM, or the upstream provider behind an aggregator like LiteLLM / Open
 * WebUI — append it to the provider label (`LLM Gateway · openrouter`), which
 * is what VS Code documents `detail` for: distinguishing models of the same
 * name. Unprefixed ids keep the plain label (issue #99).
 *
 * Current VS Code builds hide `detail` in the list whenever more than one
 * provider group is shown (always the case next to Copilot's own models), so
 * this alone doesn't guarantee visibility — `resolveDisplayNames` keeps the
 * full id as `name` for genuine collisions, which is what the user sees.
 */
export function providerDetailLabel(modelId: string): string {
  const prefix = modelIdPrefix(modelId);
  return prefix ? `${PROVIDER_DETAIL_LABEL} · ${prefix}` : PROVIDER_DETAIL_LABEL;
}

/**
 * Cost-tier multiplier surfaced to Copilot Chat. Set to 0 so BYOK / self-hosted
 * models don't appear to consume Copilot premium request quota.
 */
export const PROVIDER_MULTIPLIER_NUMERIC = 0;

export interface ModelCapabilities {
  readonly imageInput?: boolean;
  readonly toolCalling?: boolean | number;
}

export interface BuildModelInfoInput {
  readonly model: OpenAIModel;
  readonly defaultMaxTokens: number;
  readonly defaultMaxOutputTokens: number;
  readonly capabilities: ModelCapabilities;
  /**
   * Picker `name` chosen with the whole model list in view (see
   * `resolveDisplayNames`), so ids that share a friendly name can keep their
   * full id. Defaults to the friendly (post-slash) name.
   */
  readonly displayName?: string;
  /**
   * User-configured context window for this model (from the
   * `modelContextWindows` setting). Wins over everything else.
   */
  readonly contextOverride?: number;
  /**
   * Context discovered from the backend (Ollama `/api/show`: runtime
   * `num_ctx`, else the model's trained context length; LiteLLM
   * `/model/info`: `max_input_tokens`). Sits below the user override but
   * above the OpenAI `/v1/models` value, which those backends omit.
   */
  readonly discoveredContext?: number;
  /**
   * Completion ceiling discovered alongside `discoveredContext` (LiteLLM
   * `max_output_tokens`). Only consulted when `discoveredContext` is in use.
   */
  readonly discoveredMaxOutput?: number;
  /**
   * Whether `discoveredContext` is prompt-only with `discoveredMaxOutput` as a
   * separate window (LiteLLM), rather than one shared window (Ollama). Only
   * consulted when `discoveredContext` is in use.
   */
  readonly discoveredOutputWindowIsSeparate?: boolean;
  /**
   * Per-model options VS Code renders in the model picker (proposed
   * `configurationSchema`), e.g. Thinking Effort. Omitted when undefined.
   */
  readonly configurationSchema?: ModelConfigurationSchema;
}

/**
 * Picker-facing fields plus the resolved total context size. Total context is
 * returned separately because the chat-response path budgets against the
 * whole window, not the input-only figure handed to VS Code.
 */
export interface BuildModelInfoResult {
  readonly info: {
    readonly id: string;
    readonly name: string;
    readonly family: string;
    readonly version: string;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly capabilities: ModelCapabilities;
    readonly detail: string;
    readonly tooltip: string;
    readonly description?: string;
    readonly isUserSelectable: true;
    readonly multiplierNumeric: number;
    readonly configurationSchema?: ModelConfigurationSchema;
  };
  readonly totalContext: number;
  readonly hasServerReportedContext: boolean;
  /**
   * True when `totalContext` is an input-only ceiling and the model has its own
   * separate completion window, so the chat path must not reserve output space
   * out of it. Always false under a user override (one shared window); for a
   * backend-discovered size it's whatever that backend said — Ollama's
   * `num_ctx` is shared, LiteLLM's `/model/info` limits may be separate.
   */
  readonly outputWindowIsSeparate: boolean;
}

/**
 * Translate a raw `/v1/models` entry into the picker-facing model info plus
 * the resolved total context.
 *
 * Copilot Chat treats `maxInputTokens + maxOutputTokens` as the model's
 * context window — that sum is what the picker's "Max context" label and the
 * Session Info widget display, and what drives Copilot's own compaction. For
 * a shared window `maxInputTokens` is therefore the total *minus* the output
 * allowance, so the sum lands on the real limit (issue #84: exposing the full
 * window as input made a 248K llama-server model show as 288K and let Copilot
 * compact too late). A separate LiteLLM output window really is additive, so
 * that case keeps the full input ceiling. When LiteLLM reports
 * `max_output_tokens`, that model-specific ceiling replaces the configured
 * fallback.
 */
export function buildModelInfo({
  model,
  defaultMaxTokens,
  defaultMaxOutputTokens,
  capabilities,
  displayName,
  contextOverride,
  discoveredContext,
  discoveredMaxOutput,
  discoveredOutputWindowIsSeparate,
  configurationSchema,
}: BuildModelInfoInput): BuildModelInfoResult {
  const serverContext = serverReportedContext(model);
  const serverMaxOutput = serverReportedMaxOutput(model);
  const totalContext =
    contextOverride ?? discoveredContext ?? serverContext ?? defaultMaxTokens;

  // Only believe a two-window story from whichever source supplied the
  // context we ended up using. A `modelContextWindows` override describes a
  // single shared window; so does an Ollama-discovered size, whereas LiteLLM
  // discovery says explicitly whether its output ceiling is separate. Server
  // fields are only consulted when neither of those is in play.
  let outputWindowIsSeparate = false;
  if (contextOverride === undefined) {
    if (discoveredContext !== undefined) {
      outputWindowIsSeparate = discoveredOutputWindowIsSeparate === true;
    } else if (serverContext !== undefined) {
      outputWindowIsSeparate = hasSeparateOutputWindow(model);
    }
  }

  // A shared window never gives output more than half the context, matching
  // `calculateMaxInputTokens` — otherwise a generous default output budget
  // (sized for thinking models) would leave a small-context model almost no
  // room for its prompt.
  const outputCeiling =
    (discoveredContext !== undefined ? discoveredMaxOutput : undefined) ??
    serverMaxOutput ??
    defaultMaxOutputTokens;
  const maxOutputTokens = outputWindowIsSeparate
    ? outputCeiling
    : Math.min(
        outputCeiling,
        Math.max(
          TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS,
          Math.min(Math.floor(totalContext / 2), totalContext - TOKEN_CONSTANTS.ADJUST_TOKEN_BUFFER)
        )
      );

  // Shared window: hand VS Code the prompt-only share so its input + output
  // sum equals the window the server enforces. `maxOutputTokens` is already
  // clamped to leave ADJUST_TOKEN_BUFFER, so this can't collapse to zero.
  const maxInputTokens = outputWindowIsSeparate ? totalContext : totalContext - maxOutputTokens;

  const description = describeModel(model);
  const tooltip = description ? `${model.id} — ${description}` : model.id;
  const friendlyName = friendlyModelName(model.id);
  const name = displayName ?? friendlyName;

  const info: BuildModelInfoResult['info'] = {
    id: model.id,
    name,
    family: inferModelFamily(model.id),
    // Deliberately not `name`: `version` is a selector lookup value
    // (`LanguageModelChatSelector.version`), so it must not change just
    // because a second upstream started serving the same model name.
    version: friendlyName,
    maxInputTokens,
    maxOutputTokens,
    capabilities,
    detail: providerDetailLabel(model.id),
    tooltip,
    isUserSelectable: true,
    multiplierNumeric: PROVIDER_MULTIPLIER_NUMERIC,
    ...(description ? { description } : {}),
    ...(configurationSchema ? { configurationSchema } : {}),
  };

  return {
    info,
    totalContext,
    hasServerReportedContext: serverContext !== undefined,
    outputWindowIsSeparate,
  };
}
