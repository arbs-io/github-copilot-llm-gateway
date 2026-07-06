import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseContextOverflowError,
  resolveContextWindowOverride,
  serverReportedContext,
} from '../contextWindow';
import { OpenAIModel } from '../types';

function baseModel(overrides: Partial<OpenAIModel> = {}): OpenAIModel {
  return {
    id: 'test-model',
    object: 'model',
    created: 0,
    owned_by: 'llamacpp',
    ...overrides,
  };
}

describe('serverReportedContext', () => {
  test('prefers max_model_len over every other field', () => {
    const model = baseModel({
      max_model_len: 131072,
      context_length: 8192,
      context_window: 4096,
      meta: { n_ctx: 2048, n_ctx_train: 1024 },
    });
    assert.equal(serverReportedContext(model), 131072);
  });

  test('reads llama.cpp meta.n_ctx when the flat fields are absent (issue #55)', () => {
    const model = baseModel({ meta: { n_ctx: 123904, n_ctx_train: 262144 } });
    assert.equal(serverReportedContext(model), 123904);
  });

  test('falls back to meta.n_ctx_train when n_ctx is absent', () => {
    const model = baseModel({ meta: { n_ctx_train: 32768 } });
    assert.equal(serverReportedContext(model), 32768);
  });

  test('returns undefined when nothing is reported (llama-server router mode, model not loaded)', () => {
    assert.equal(serverReportedContext(baseModel()), undefined);
    assert.equal(serverReportedContext(baseModel({ meta: {} })), undefined);
  });

  test('skips zero / negative / non-numeric values instead of trusting them', () => {
    const model = baseModel({
      max_model_len: 0,
      context_length: -1,
      meta: { n_ctx: 4096 },
    });
    assert.equal(serverReportedContext(model), 4096);
  });
});

describe('resolveContextWindowOverride', () => {
  test('returns the exact-id entry', () => {
    assert.equal(resolveContextWindowOverride('qwen3-8b', { 'qwen3-8b': 32768 }), 32768);
  });

  test('matches * wildcards case-insensitively', () => {
    assert.equal(resolveContextWindowOverride('Qwen3-8B', { 'qwen*': 32768 }), 32768);
  });

  test('exact-id entry wins over a wildcard entry', () => {
    assert.equal(
      resolveContextWindowOverride('qwen3-8b', { 'qwen*': 16384, 'qwen3-8b': 32768 }),
      32768
    );
  });

  test('ignores non-numeric and non-positive values', () => {
    assert.equal(
      resolveContextWindowOverride('m', { m: '32768' as unknown as number }),
      undefined
    );
    assert.equal(resolveContextWindowOverride('m', { m: 0 }), undefined);
    assert.equal(resolveContextWindowOverride('m', { m: -5 }), undefined);
  });

  test('returns undefined for no match / empty / undefined map', () => {
    assert.equal(resolveContextWindowOverride('m', { other: 1024 }), undefined);
    assert.equal(resolveContextWindowOverride('m', {}), undefined);
    assert.equal(resolveContextWindowOverride('m', undefined), undefined);
  });
});

describe('parseContextOverflowError', () => {
  test('extracts n_ctx from a llama.cpp exceed_context_size_error body (issue #55)', () => {
    const message =
      'Chat completion failed: 400 Bad Request - {"error":{"code":400,"message":"request (124315 tokens) exceeds the available context size (123904 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":124315,"n_ctx":123904}}';
    assert.equal(parseContextOverflowError(message), 123904);
  });

  test('extracts the size from llama.cpp message text when the JSON fields are missing', () => {
    const message = 'request (5000 tokens) exceeds the available context size (4096 tokens)';
    assert.equal(parseContextOverflowError(message), 4096);
  });

  test('extracts the size from the OpenAI / vLLM wording', () => {
    const message =
      "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.";
    assert.equal(parseContextOverflowError(message), 8192);
  });

  test('returns undefined for unrelated errors', () => {
    assert.equal(parseContextOverflowError('Chat completion failed: 500 Internal Server Error'), undefined);
    assert.equal(parseContextOverflowError('fetch failed: ECONNREFUSED'), undefined);
    assert.equal(parseContextOverflowError(''), undefined);
  });

  test('does not match numbers in errors that merely mention context', () => {
    assert.equal(
      parseContextOverflowError('error in context handler: expected 42 items'),
      undefined
    );
  });
});
