import type { CancellationToken } from 'vscode';
import { DiscoveredModelInfo, ModelDiscovery } from './types';

/**
 * LiteLLM-specific model discovery via the proxy's native `GET /model/info`
 * endpoint (issue #100). LiteLLM's OpenAI-compatible `/v1/models` listing is
 * bare — `id` / `object` / `created` / `owned_by` — so models proxied through
 * it fall back to `defaultMaxTokens` unless the deployment happens to enrich
 * the list. `/model/info` carries the per-deployment `model_info` block with
 * the real `max_input_tokens` / `max_output_tokens` and capability flags.
 *
 * All LiteLLM knowledge lives in this module; everything downstream consumes
 * the backend-neutral {@link DiscoveredModelInfo}.
 */

/** Raw per-model metadata parsed from one `/model/info` entry. */
export interface LiteLLMModelInfo {
  /** Public model name — the id the `/v1/models` list exposes. */
  readonly modelName: string;
  /** Prompt-token ceiling (`model_info.max_input_tokens`). */
  readonly maxInputTokens?: number;
  /** Completion-token ceiling (`model_info.max_output_tokens`). */
  readonly maxOutputTokens?: number;
  /** `model_info.supports_vision`, when reported. */
  readonly supportsVision?: boolean;
  /** `model_info.supports_function_calling`, when reported. */
  readonly supportsFunctionCalling?: boolean;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Parse a raw `GET /model/info` JSON body into per-model metadata, or
 * `undefined` when the body doesn't look like a LiteLLM response (so a
 * foreign server that answers 200 on the path is ignored). Entries with a
 * wildcard `model_name` (`*`, `openai/*`) match nothing in the model list
 * and are skipped; when several deployments share a public name (LiteLLM
 * load-balancing), the first one wins.
 */
export function parseLiteLLMModelInfoResponse(
  raw: unknown
): Map<string, LiteLLMModelInfo> | undefined {
  if (!raw || typeof raw !== 'object') { return undefined; }
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) { return undefined; }

  const byName = new Map<string, LiteLLMModelInfo>();
  let looksLikeLiteLLM = false;
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') { continue; }
    const { model_name: modelName, model_info: modelInfo } = entry as {
      model_name?: unknown;
      model_info?: unknown;
    };
    if (typeof modelName !== 'string' || modelName.length === 0) { continue; }
    looksLikeLiteLLM = true;
    if (modelName.includes('*') || byName.has(modelName)) { continue; }

    const info: Record<string, unknown> =
      modelInfo && typeof modelInfo === 'object' ? (modelInfo as Record<string, unknown>) : {};
    byName.set(modelName, {
      modelName,
      maxInputTokens: positiveNumber(info.max_input_tokens),
      maxOutputTokens: positiveNumber(info.max_output_tokens),
      supportsVision: optionalBoolean(info.supports_vision),
      supportsFunctionCalling: optionalBoolean(info.supports_function_calling),
    });
  }
  return looksLikeLiteLLM ? byName : undefined;
}

/**
 * Map parsed LiteLLM metadata onto the backend-neutral discovery shape.
 *
 * Mirrors `hasSeparateOutputWindow` in chat/contextWindow.ts: the two
 * ceilings are only treated as independent windows when the output limit is
 * genuinely smaller than the input one — equal values mean the deployment
 * described one pool twice, and guessing "separate" wrongly produces real
 * context-overflow errors rather than merely wasted headroom.
 */
export function toDiscoveredModelInfo(info: LiteLLMModelInfo): DiscoveredModelInfo {
  const separateOutputWindow =
    info.maxInputTokens !== undefined &&
    info.maxOutputTokens !== undefined &&
    info.maxOutputTokens < info.maxInputTokens;
  return {
    contextLength: info.maxInputTokens,
    contextSource: info.maxInputTokens !== undefined ? 'LiteLLM max_input_tokens (/model/info)' : undefined,
    maxOutputTokens: info.maxOutputTokens,
    separateOutputWindow,
    samplerParams: {},
    visionSupported: info.supportsVision,
    toolsSupported: info.supportsFunctionCalling,
  };
}

/** The subset of the gateway client the discovery probe needs. */
export interface LiteLLMDiscoveryClient {
  /** `GET /model/info` raw JSON body, or `undefined` on any failure. */
  fetchLiteLLMModelInfo(token?: CancellationToken): Promise<unknown>;
}

interface LiteLLMDiscoveryDeps {
  client: LiteLLMDiscoveryClient;
  log: (message: string) => void;
}

/**
 * {@link ModelDiscovery} implementation for LiteLLM. Unlike Ollama's
 * per-model `/api/show`, one `GET /model/info` describes every deployment, so
 * detection and enrichment are the same short-timeout request: fetched once
 * (single-flight) per config generation and cached until `reset()`. Foreign
 * servers answer 404 (or something that doesn't parse) and cost exactly one
 * request per generation.
 */
export class LiteLLMDiscovery implements ModelDiscovery {
  private infoByModelName?: Promise<Map<string, LiteLLMModelInfo> | undefined>;

  constructor(private readonly deps: LiteLLMDiscoveryDeps) {}

  public reset(): void {
    this.infoByModelName = undefined;
  }

  public async enrichModel(
    modelId: string,
    token?: CancellationToken
  ): Promise<DiscoveredModelInfo | undefined> {
    const byName = await this.loadModelInfo(token);
    const info = byName?.get(modelId);
    return info ? toDiscoveredModelInfo(info) : undefined;
  }

  private loadModelInfo(
    token?: CancellationToken
  ): Promise<Map<string, LiteLLMModelInfo> | undefined> {
    if (!this.infoByModelName) {
      const load = this.deps.client
        .fetchLiteLLMModelInfo(token)
        .then(parseLiteLLMModelInfoResponse)
        .catch(() => undefined)
        .then((parsed) => {
          if (!parsed && token?.isCancellationRequested) {
            // The fetch was aborted, not answered — don't cache the verdict.
            if (this.infoByModelName === load) { this.infoByModelName = undefined; }
            return undefined;
          }
          this.deps.log(
            parsed
              ? `LiteLLM proxy detected (/model/info); using its metadata for ${parsed.size} model(s)`
              : 'Server is not LiteLLM (/model/info probe failed); skipping LiteLLM model discovery'
          );
          return parsed;
        });
      this.infoByModelName = load;
    }
    return this.infoByModelName;
  }
}
