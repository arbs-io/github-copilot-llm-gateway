import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_DETAIL_LABEL,
  PROVIDER_MULTIPLIER_NUMERIC,
  buildModelInfo,
} from '../modelInfoBuilder';
import { TOKEN_CONSTANTS } from '../tokenBudget';
import { OpenAIModel } from '../types';

function baseModel(overrides: Partial<OpenAIModel> = {}): OpenAIModel {
  return {
    id: 'qwen/Qwen3-8B',
    object: 'model',
    created: 0,
    owned_by: 'vllm',
    ...overrides,
  };
}

describe('buildModelInfo first-party look-and-feel fields', () => {
  test('sets detail to the provider label so the picker groups models', () => {
    const { info } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.detail, PROVIDER_DETAIL_LABEL);
    assert.equal(info.detail, 'LLM Gateway');
  });

  test('sets multiplierNumeric to 0 so BYOK models do not appear premium', () => {
    const { info } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.multiplierNumeric, 0);
    assert.equal(info.multiplierNumeric, PROVIDER_MULTIPLIER_NUMERIC);
  });

  test('marks the model user-selectable for the chat picker (1.120 requirement)', () => {
    const { info } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.isUserSelectable, true);
  });
});

describe('buildModelInfo id-derived fields', () => {
  test('uses the friendly (post-slash) name', () => {
    const { info } = buildModelInfo({
      model: baseModel({ id: 'meta-llama/Llama-3.1-8B-Instruct' }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.name, 'Llama-3.1-8B-Instruct');
    assert.equal(info.version, 'Llama-3.1-8B-Instruct');
    assert.equal(info.id, 'meta-llama/Llama-3.1-8B-Instruct');
  });

  test('infers a known family when the id matches', () => {
    const { info } = buildModelInfo({
      model: baseModel({ id: 'mistralai/Mistral-7B' }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.family, 'mistral');
  });

  test('falls back to the llm-gateway family for unknown ids', () => {
    const { info } = buildModelInfo({
      model: baseModel({ id: 'unknown-org/unknown-model' }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.family, 'llm-gateway');
  });
});

describe('buildModelInfo context resolution', () => {
  test('prefers max_model_len over the other context fields', () => {
    const { totalContext, info, hasServerReportedContext } = buildModelInfo({
      model: baseModel({
        max_model_len: 131072,
        context_length: 8192,
        context_window: 4096,
      }),
      defaultMaxTokens: 9999,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(totalContext, 131072);
    assert.equal(info.maxInputTokens, 131072);
    assert.equal(hasServerReportedContext, true);
  });

  test('falls back to context_length when max_model_len is absent', () => {
    const { totalContext, hasServerReportedContext } = buildModelInfo({
      model: baseModel({ context_length: 8192 }),
      defaultMaxTokens: 9999,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(totalContext, 8192);
    assert.equal(hasServerReportedContext, true);
  });

  test('falls back to context_window when max_model_len and context_length are absent', () => {
    const { totalContext, hasServerReportedContext } = buildModelInfo({
      model: baseModel({ context_window: 4096 }),
      defaultMaxTokens: 9999,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(totalContext, 4096);
    assert.equal(hasServerReportedContext, true);
  });

  test('falls back to defaultMaxTokens when the server reports no context size', () => {
    const { totalContext, hasServerReportedContext } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 32768,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(totalContext, 32768);
    assert.equal(hasServerReportedContext, false);
  });

  test('reads llama.cpp meta.n_ctx when the flat fields are absent (issue #55)', () => {
    const { totalContext, hasServerReportedContext } = buildModelInfo({
      model: baseModel({ meta: { n_ctx: 123904, n_ctx_train: 262144 } }),
      defaultMaxTokens: 9999,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(totalContext, 123904);
    assert.equal(hasServerReportedContext, true);
  });

  test('a user contextOverride wins over server-reported values', () => {
    const { totalContext, info, hasServerReportedContext } = buildModelInfo({
      model: baseModel({ max_model_len: 131072 }),
      defaultMaxTokens: 9999,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
      contextOverride: 32768,
    });
    assert.equal(totalContext, 32768);
    assert.equal(info.maxInputTokens, 32768);
    // Server still reported a value; the override just outranked it.
    assert.equal(hasServerReportedContext, true);
  });

  test('a user contextOverride also wins over defaultMaxTokens when nothing is reported', () => {
    const { totalContext } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 9999,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
      contextOverride: 16384,
    });
    assert.equal(totalContext, 16384);
  });
});

describe('buildModelInfo output token math', () => {
  test('caps maxOutputTokens at the configured default', () => {
    const { info } = buildModelInfo({
      model: baseModel({ max_model_len: 131072 }),
      defaultMaxTokens: 32768,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.maxOutputTokens, 2048);
  });

  test('reduces maxOutputTokens to leave the ADJUST_TOKEN_BUFFER headroom when the window is tight', () => {
    const totalContext = 512;
    const { info } = buildModelInfo({
      model: baseModel({ max_model_len: totalContext }),
      defaultMaxTokens: 32768,
      defaultMaxOutputTokens: 4096,
      capabilities: {},
    });
    assert.equal(info.maxOutputTokens, totalContext - TOKEN_CONSTANTS.ADJUST_TOKEN_BUFFER);
  });

  test('never drops below MIN_OUTPUT_TOKENS', () => {
    const { info } = buildModelInfo({
      model: baseModel({ max_model_len: TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS }),
      defaultMaxTokens: 32768,
      defaultMaxOutputTokens: 4096,
      capabilities: {},
    });
    assert.equal(info.maxOutputTokens, TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS);
  });
});

describe('buildModelInfo description and tooltip', () => {
  test('includes description when describeModel returns content', () => {
    const { info } = buildModelInfo({
      model: baseModel({ max_model_len: 32768, owned_by: 'vllm' }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.ok(info.description, 'expected description to be set');
    assert.ok(info.description!.includes('ctx'));
    assert.equal(info.tooltip, `qwen/Qwen3-8B — ${info.description}`);
  });

  test('omits description when describeModel returns an empty string', () => {
    const { info } = buildModelInfo({
      // No context fields + filtered-out owned_by leaves describeModel empty.
      model: baseModel({ owned_by: 'organization-owner' }),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.equal(info.description, undefined);
    assert.equal(info.tooltip, 'qwen/Qwen3-8B');
  });
});

describe('buildModelInfo capabilities pass-through', () => {
  test('forwards capabilities as-is', () => {
    const { info } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: { imageInput: true, toolCalling: 16 },
    });
    assert.deepEqual(info.capabilities, { imageInput: true, toolCalling: 16 });
  });

  test('accepts empty capabilities', () => {
    const { info } = buildModelInfo({
      model: baseModel(),
      defaultMaxTokens: 8192,
      defaultMaxOutputTokens: 2048,
      capabilities: {},
    });
    assert.deepEqual(info.capabilities, {});
  });
});
