/**
 * Context-window detection helpers (issue #55).
 *
 * Servers report their context size in different places — and some don't
 * report it at all until a model is loaded (llama-server router mode), so the
 * gateway needs three layers of defence:
 *
 *  1. read every context field the server may include in `/v1/models`
 *     (including llama.cpp's `meta.n_ctx` / `meta.n_ctx_train`),
 *  2. let the user pin a per-model value via the `modelContextWindows`
 *     setting, and
 *  3. learn the real limit from the server's context-overflow error and use
 *     it for subsequent requests.
 */

import { OpenAIModel } from '../api/types';

/** A context value is only usable if it's a positive finite number. */
function isUsableContext(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Extract the context window a `/v1/models` entry reports, checking every
 * field the common OpenAI-compatible servers use. llama.cpp nests its values
 * under `meta`: `n_ctx` is the *serving* context (`-c`), `n_ctx_train` the
 * model's training context — prefer the former since that's what the server
 * actually enforces.
 */
export function serverReportedContext(model: OpenAIModel): number | undefined {
  const candidates = [
    model.max_model_len, // vLLM, LiteLLM
    model.context_length, // Ollama, LocalAI, LM Studio
    model.context_window, // llama.cpp (older builds)
    model.meta?.n_ctx, // llama.cpp serving context
    model.meta?.n_ctx_train, // llama.cpp training context
  ];
  return candidates.find(isUsableContext);
}

/**
 * Resolve the user-configured context override for `modelId` from the
 * `modelContextWindows` setting. Keys match the model id exactly or via `*`
 * wildcards (case-insensitive), mirroring `perModelOptions`; an exact-id
 * entry wins over any wildcard match.
 */
export function resolveContextWindowOverride(
  modelId: string,
  overrides: Record<string, unknown> | undefined
): number | undefined {
  if (!overrides) {
    return undefined;
  }

  let wildcardMatch: number | undefined;
  for (const [pattern, value] of Object.entries(overrides)) {
    if (!isUsableContext(value)) {
      continue;
    }
    if (pattern === modelId) {
      return value;
    }
    if (pattern.includes('*') && matchesWildcard(pattern, modelId)) {
      wildcardMatch = value;
    }
  }
  return wildcardMatch;
}

/**
 * Build a case-insensitive `RegExp` that matches `modelId` against a pattern
 * containing `*` wildcards. All other characters are matched literally.
 * (Same semantics as perModelOptions key matching.)
 */
function matchesWildcard(pattern: string, modelId: string): boolean {
  const escaped = pattern
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i').test(modelId);
}

/**
 * Parse a chat-completion error message for the context window the server
 * says it actually has. Returns the server-reported total context in tokens,
 * or `undefined` when the error isn't a context overflow.
 *
 * Recognised shapes (the raw response body is embedded in our error text):
 *  - llama.cpp: `{"code":400,"message":"request (124315 tokens) exceeds the
 *    available context size (123904 tokens), ...","type":
 *    "exceed_context_size_error","n_prompt_tokens":124315,"n_ctx":123904}`
 *  - OpenAI / vLLM / LM Studio: "This model's maximum context length is
 *    8192 tokens. However, you requested ..."
 */
export function parseContextOverflowError(message: string): number | undefined {
  // Cheap guard so unrelated errors never pattern-match by accident.
  if (!/context/i.test(message)) {
    return undefined;
  }

  const patterns = [
    /"n_ctx"\s*:\s*(\d+)/, // llama.cpp JSON field — most precise
    /exceeds? the available context size \((\d+) tokens\)/i, // llama.cpp text
    /maximum context length is (\d+) tokens/i, // OpenAI / vLLM / LM Studio
    /context length of only (\d+) tokens/i, // vLLM (older wording)
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match) {
      const value = parseInt(match[1], 10);
      if (isUsableContext(value)) {
        return value;
      }
    }
  }
  return undefined;
}
