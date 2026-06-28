/**
 * Pure logic for the experimental inline (fill-in-the-middle) completion
 * provider — VS Code-free so it can be unit-tested in isolation. The VS Code
 * surface (document/position parsing, debouncing, `InlineCompletionItem`
 * wrapping) lives in {@link ./inlineCompletionProvider}.
 *
 * VS Code does not let bring-your-own-key models drive its own inline
 * suggestions (microsoft/vscode#318545), so this powers a separate provider
 * that talks straight to the inference server's `/v1/completions` endpoint with
 * a `suffix` for FIM. The server/model must support FIM for results to be
 * meaningful.
 */

import { OpenAICompletionRequest, OpenAICompletionResponse } from './types';

/**
 * How much surrounding text to send. Completion latency and server prompt
 * limits both scale with context size, so we clamp to a generous-but-bounded
 * window around the cursor rather than shipping the whole file every keystroke.
 */
export const MAX_PREFIX_CHARS = 4000;
export const MAX_SUFFIX_CHARS = 1000;

/** Low temperature keeps completions deterministic and on-distribution. */
export const COMPLETION_TEMPERATURE = 0.2;

export interface FimContext {
  prefix: string;
  suffix: string;
}

/**
 * Clamp the text on each side of the cursor to the FIM context budget. The
 * prefix keeps its *tail* (the code immediately before the cursor matters
 * most) and the suffix keeps its *head* (the code immediately after).
 */
export function extractFimContext(textBefore: string, textAfter: string): FimContext {
  const prefix = textBefore.length > MAX_PREFIX_CHARS
    ? textBefore.slice(textBefore.length - MAX_PREFIX_CHARS)
    : textBefore;
  const suffix = textAfter.length > MAX_SUFFIX_CHARS
    ? textAfter.slice(0, MAX_SUFFIX_CHARS)
    : textAfter;
  return { prefix, suffix };
}

/**
 * Whether a completion request is worth sending. Skips the degenerate case of
 * an entirely empty document (nothing to condition on), which otherwise
 * produces noise on a fresh/blank file.
 */
export function shouldRequestCompletion(context: FimContext): boolean {
  return context.prefix.length > 0 || context.suffix.trim().length > 0;
}

export interface CompletionRequestParams {
  model: string;
  context: FimContext;
  maxTokens: number;
}

/**
 * Build the `/v1/completions` request body for a FIM completion. `suffix` is
 * omitted when empty so servers that reject an empty `suffix` field still work
 * for end-of-file completions.
 */
export function buildCompletionRequestBody(
  params: CompletionRequestParams
): OpenAICompletionRequest {
  const request: OpenAICompletionRequest = {
    model: params.model,
    prompt: params.context.prefix,
    max_tokens: params.maxTokens,
    temperature: COMPLETION_TEMPERATURE,
    stream: false,
  };
  if (params.context.suffix.length > 0) {
    request.suffix = params.context.suffix;
  }
  return request;
}

/**
 * Pull the completion text out of a `/v1/completions` response, tolerating
 * servers that omit `choices` or `text`. Returns an empty string when there's
 * nothing usable.
 */
export function extractCompletionText(response: OpenAICompletionResponse | undefined): string {
  const text = response?.choices?.[0]?.text;
  return typeof text === 'string' ? text : '';
}

/**
 * Normalise a raw completion before it's shown as a ghost-text suggestion:
 * drop whitespace-only results (which render as a blank, un-acceptable
 * suggestion) and trim a single trailing newline the model often appends.
 */
export function cleanCompletionText(text: string): string {
  if (text.trim().length === 0) {
    return '';
  }
  return text.replace(/\n+$/, '');
}
