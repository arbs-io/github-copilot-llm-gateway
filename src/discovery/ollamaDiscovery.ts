import type { CancellationToken } from 'vscode';
import { DiscoveredModelInfo, ModelDiscovery, REQUEST_SAMPLER_KEYS } from './types';

/**
 * Ollama-specific model discovery via the native `POST /api/show` endpoint.
 * The OpenAI-compatible `/v1/models` list carries no context window, sampler
 * params, or capabilities for Ollama, so without this the gateway can't
 * auto-configure them (issues: agent temperature always applied, context
 * never discovered, top_p defaulted to 1.0, capabilities not read).
 *
 * All Ollama knowledge lives in this module; everything downstream consumes
 * the backend-neutral {@link DiscoveredModelInfo}.
 */

/** Raw metadata parsed from an `/api/show` response body. */
export interface OllamaModelInfo {
  /** Runtime context from Modelfile `PARAMETER num_ctx` — what's allocated. */
  readonly numCtx?: number;
  /** Trained context ceiling (`model_info["<arch>.context_length"]`). */
  readonly trainedContext?: number;
  /** Numeric sampler params from the Modelfile (temperature, top_p, ...). */
  readonly params: Readonly<Record<string, number>>;
  /**
   * Capability tags, e.g. ["completion","vision","tools","thinking"], or
   * `undefined` when the server didn't report them (older Ollama versions
   * omit the field — that must read as "unknown", not "none").
   */
  readonly capabilities?: readonly string[];
}

/** Modelfile parameter keys whose values are numeric and worth surfacing. */
const NUMERIC_PARAM_KEYS = new Set<string>([
  ...REQUEST_SAMPLER_KEYS,
  'temperature', 'repeat_last_n',
  'num_ctx', 'num_predict', 'seed', 'tfs_z',
  'mirostat', 'mirostat_tau', 'mirostat_eta',
]);

/**
 * Parse Ollama's `parameters` field — a newline-separated list of
 * `key<whitespace>value` lines (e.g. "temperature 0.7\nnum_ctx 65536") — into
 * a map of the numeric sampler/config params we understand. Non-numeric or
 * unknown keys (e.g. repeated `stop` strings) are ignored.
 */
export function parseOllamaParameters(parameters: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof parameters !== 'string') { return out; }
  for (const line of parameters.split('\n')) {
    const match = /^(\S+)\s+(.+)$/.exec(line.trim());
    if (!match) { continue; }
    const key = match[1];
    if (!NUMERIC_PARAM_KEYS.has(key)) { continue; }
    const value = Number(match[2].trim());
    if (Number.isFinite(value)) { out[key] = value; }
  }
  return out;
}

/** Find the `<arch>.context_length` entry in Ollama's `model_info` block. */
function findTrainedContext(modelInfo: unknown): number | undefined {
  if (!modelInfo || typeof modelInfo !== 'object') { return undefined; }
  for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
    if (
      key.endsWith('.context_length') &&
      typeof value === 'number' && Number.isFinite(value) && value > 0
    ) {
      return value;
    }
  }
  return undefined;
}

/**
 * Parse a raw `POST /api/show` JSON body into {@link OllamaModelInfo}, or
 * `undefined` when the body doesn't look like an Ollama `/api/show` response
 * (so non-Ollama servers that happen to return 200 are ignored).
 */
export function parseOllamaShowResponse(raw: unknown): OllamaModelInfo | undefined {
  if (!raw || typeof raw !== 'object') { return undefined; }
  const obj = raw as Record<string, unknown>;
  const looksLikeOllama =
    'model_info' in obj || 'parameters' in obj || 'capabilities' in obj;
  if (!looksLikeOllama) { return undefined; }

  const params = parseOllamaParameters(obj.parameters);
  const numCtx =
    Number.isFinite(params.num_ctx) && params.num_ctx > 0 ? params.num_ctx : undefined;
  const trainedContext = findTrainedContext(obj.model_info);
  const capabilities = Array.isArray(obj.capabilities)
    ? obj.capabilities.filter((c): c is string => typeof c === 'string')
    : undefined;

  return { numCtx, trainedContext, params, capabilities };
}

/** Map parsed Ollama metadata onto the backend-neutral discovery shape. */
export function toDiscoveredModelInfo(info: OllamaModelInfo): DiscoveredModelInfo {
  const contextLength = info.numCtx ?? info.trainedContext;
  return {
    contextLength,
    contextSource:
      contextLength === undefined
        ? undefined
        : info.numCtx !== undefined
          ? 'Ollama num_ctx (/api/show)'
          : 'Ollama trained context (/api/show)',
    samplerParams: info.params,
    visionSupported: info.capabilities?.includes('vision'),
    toolsSupported: info.capabilities?.includes('tools'),
  };
}

/** The subset of the gateway client the discovery probe needs. */
export interface OllamaDiscoveryClient {
  /** `GET /api/version` — true only when the server answers like Ollama. */
  probeOllama(token?: CancellationToken): Promise<boolean>;
  /** `POST /api/show` raw JSON body, or `undefined` on any failure. */
  showModel(modelId: string, token?: CancellationToken): Promise<unknown>;
}

interface OllamaDiscoveryDeps {
  client: OllamaDiscoveryClient;
  log: (message: string) => void;
}

/**
 * {@link ModelDiscovery} implementation for Ollama. Detection is a single
 * short-timeout `GET /api/version` probe, cached (single-flight) until
 * `reset()` — so non-Ollama backends pay one cheap request per config
 * generation and zero `/api/show` calls, and the model list is never held
 * hostage by a server that hangs on unknown paths.
 */
export class OllamaDiscovery implements ModelDiscovery {
  private detection?: Promise<boolean>;
  /**
   * Per-model `/api/show` results (including "nothing found"), kept until
   * `reset()`. The model list re-fetches as often as every second (picker +
   * status probe), but Modelfile metadata only changes when the user edits a
   * model — so pay the N requests once per config generation, not per fetch.
   */
  private readonly infoByModelId: Map<string, DiscoveredModelInfo | undefined> = new Map();

  constructor(private readonly deps: OllamaDiscoveryDeps) {}

  public reset(): void {
    this.detection = undefined;
    this.infoByModelId.clear();
  }

  public async enrichModel(
    modelId: string,
    token?: CancellationToken
  ): Promise<DiscoveredModelInfo | undefined> {
    if (!(await this.isOllamaServer(token))) { return undefined; }
    if (this.infoByModelId.has(modelId)) { return this.infoByModelId.get(modelId); }
    const parsed = parseOllamaShowResponse(await this.deps.client.showModel(modelId, token));
    const info = parsed ? toDiscoveredModelInfo(parsed) : undefined;
    // An aborted fetch reads as "no info" — don't let that verdict stick.
    if (!token?.isCancellationRequested) {
      this.infoByModelId.set(modelId, info);
    }
    return info;
  }

  private isOllamaServer(token?: CancellationToken): Promise<boolean> {
    if (!this.detection) {
      const probe = this.deps.client
        .probeOllama(token)
        .catch(() => false)
        .then((detected) => {
          if (!detected && token?.isCancellationRequested) {
            // The probe was aborted, not answered — don't cache the verdict.
            if (this.detection === probe) { this.detection = undefined; }
            return false;
          }
          this.deps.log(
            detected
              ? 'Ollama server detected (/api/version); enabling native model discovery via /api/show'
              : 'Server is not Ollama (/api/version probe failed); skipping native model discovery'
          );
          return detected;
        });
      this.detection = probe;
    }
    return this.detection;
  }
}
