import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THINKING_EFFORT_PARAMETER,
  THINKING_EFFORT_PRESETS,
  MODEL_CONFIG_EFFORT_KEY,
  SERVER_DEFAULT_EFFORT,
  applyModelConfigurationEffort,
  applyThinkingEffort,
  buildThinkingEffortSchema,
  parseAcceptedEffortValues,
  parseThinkingEffortPickerMode,
  resolveThinkingEffort,
  shouldOfferThinkingEffortPicker,
} from '../thinkingEffort';
import { resolvePerModelOptions } from '../perModelOptions';

describe('THINKING_EFFORT_PRESETS', () => {
  test('"Off" clears the parameter instead of sending a literal value', () => {
    const off = THINKING_EFFORT_PRESETS.find((p) => p.level === 'off');
    assert.ok(off);
    assert.equal(off.value, undefined);
  });

  test('every other preset sends a standard reasoning_effort value', () => {
    const values = THINKING_EFFORT_PRESETS.filter((p) => p.level !== 'off').map((p) => p.value);
    assert.deepEqual(values, ['low', 'medium', 'high']);
  });
});

describe('applyThinkingEffort', () => {
  test('creates an exact-id entry on an empty map', () => {
    const next = applyThinkingEffort({}, 'qwen3-8b', 'high');
    assert.deepEqual(next, { 'qwen3-8b': { reasoning_effort: 'high' } });
  });

  test('preserves other keys already set for the model', () => {
    const next = applyThinkingEffort(
      { 'qwen3-8b': { temperature: 0.6 } },
      'qwen3-8b',
      'low'
    );
    assert.deepEqual(next, { 'qwen3-8b': { temperature: 0.6, reasoning_effort: 'low' } });
  });

  test('removing the parameter leaves other keys and drops an empty entry', () => {
    const withOthers = applyThinkingEffort(
      { 'qwen3-8b': { temperature: 0.6, reasoning_effort: 'high' } },
      'qwen3-8b',
      undefined
    );
    assert.deepEqual(withOthers, { 'qwen3-8b': { temperature: 0.6 } });

    const emptied = applyThinkingEffort({ 'qwen3-8b': { reasoning_effort: 'high' } }, 'qwen3-8b', undefined);
    assert.deepEqual(emptied, {});
  });

  test('does not touch wildcard entries or other models', () => {
    const original = { 'qwen*': { reasoning_effort: 'low' }, 'deepseek-r1': { top_p: 0.9 } };
    const next = applyThinkingEffort(original, 'qwen3-8b', 'high');
    assert.deepEqual(next['qwen*'], { reasoning_effort: 'low' });
    assert.deepEqual(next['deepseek-r1'], { top_p: 0.9 });
    // The chat path sees the exact-id value win over the wildcard.
    assert.equal(resolvePerModelOptions('qwen3-8b', next).reasoning_effort, 'high');
  });

  test('never mutates the input map', () => {
    const original: Record<string, unknown> = { 'qwen3-8b': { temperature: 0.6 } };
    applyThinkingEffort(original, 'qwen3-8b', 'high');
    assert.deepEqual(original, { 'qwen3-8b': { temperature: 0.6 } });
  });

  test('honours a custom parameter name', () => {
    const next = applyThinkingEffort({}, 'qwen3-8b', '4096', 'reasoning_budget');
    assert.deepEqual(next, { 'qwen3-8b': { reasoning_budget: '4096' } });
  });

  test('replaces a malformed (non-object) entry rather than crashing', () => {
    const next = applyThinkingEffort({ 'qwen3-8b': 'oops' }, 'qwen3-8b', 'medium');
    assert.deepEqual(next, { 'qwen3-8b': { reasoning_effort: 'medium' } });
  });

  test('tolerates an undefined map', () => {
    assert.deepEqual(applyThinkingEffort(undefined, 'm', 'low'), { m: { reasoning_effort: 'low' } });
  });
});

describe('resolveThinkingEffort', () => {
  test('returns undefined when nothing is configured', () => {
    assert.equal(resolveThinkingEffort('qwen3-8b', {}), undefined);
    assert.equal(resolveThinkingEffort('qwen3-8b', undefined), undefined);
  });

  test('reads through wildcard matches like the chat path does', () => {
    assert.equal(resolveThinkingEffort('qwen3-8b', { 'qwen*': { reasoning_effort: 'low' } }), 'low');
  });

  test('exact id wins over a wildcard', () => {
    const options = { 'qwen*': { reasoning_effort: 'low' }, 'qwen3-8b': { reasoning_effort: 'high' } };
    assert.equal(resolveThinkingEffort('qwen3-8b', options), 'high');
  });

  test('stringifies numeric budgets and ignores non-scalar values', () => {
    assert.equal(resolveThinkingEffort('m', { m: { reasoning_budget: 2048 } }, 'reasoning_budget'), '2048');
    assert.equal(resolveThinkingEffort('m', { m: { reasoning_effort: { nested: true } } }), undefined);
  });

  test('uses reasoning_effort by default', () => {
    assert.equal(DEFAULT_THINKING_EFFORT_PARAMETER, 'reasoning_effort');
  });
});

describe('parseThinkingEffortPickerMode', () => {
  test('accepts the known modes and defaults anything else to auto', () => {
    assert.equal(parseThinkingEffortPickerMode('all'), 'all');
    assert.equal(parseThinkingEffortPickerMode('off'), 'off');
    assert.equal(parseThinkingEffortPickerMode('auto'), 'auto');
    assert.equal(parseThinkingEffortPickerMode('ALL'), 'auto');
    assert.equal(parseThinkingEffortPickerMode(undefined), 'auto');
  });
});

describe('shouldOfferThinkingEffortPicker', () => {
  test('auto offers it for reasoning models and models with an effort already set', () => {
    assert.equal(shouldOfferThinkingEffortPicker('auto', true, undefined), true);
    assert.equal(shouldOfferThinkingEffortPicker('auto', undefined, 'high'), true);
    assert.equal(shouldOfferThinkingEffortPicker('auto', false, 'low'), true);
  });

  test('auto skips models with no reasoning signal', () => {
    assert.equal(shouldOfferThinkingEffortPicker('auto', undefined, undefined), false);
    assert.equal(shouldOfferThinkingEffortPicker('auto', false, undefined), false);
  });

  test('all and off ignore the model', () => {
    assert.equal(shouldOfferThinkingEffortPicker('all', false, undefined), true);
    assert.equal(shouldOfferThinkingEffortPicker('off', true, 'high'), false);
  });
});

describe('buildThinkingEffortSchema', () => {
  test('offers Server Default plus the presets as a navigation-group picker', () => {
    const property = buildThinkingEffortSchema(undefined).properties[MODEL_CONFIG_EFFORT_KEY];
    assert.deepEqual(property.enum, [SERVER_DEFAULT_EFFORT, 'low', 'medium', 'high']);
    assert.deepEqual(property.enumItemLabels, ['Server Default', 'Low', 'Medium', 'High']);
    assert.equal(property.enumDescriptions.length, property.enum.length);
    assert.equal(property.default, SERVER_DEFAULT_EFFORT);
    assert.equal(property.group, 'navigation');
    assert.equal(property.title, 'Thinking Effort');
  });

  test('defaults to the effort perModelOptions currently sends', () => {
    const property = buildThinkingEffortSchema('high').properties[MODEL_CONFIG_EFFORT_KEY];
    assert.equal(property.default, 'high');
    assert.equal(property.enum.length, 4);
  });

  test('keeps a custom value as an extra option instead of dropping it', () => {
    const property = buildThinkingEffortSchema('minimal').properties[MODEL_CONFIG_EFFORT_KEY];
    assert.equal(property.default, 'minimal');
    assert.equal(property.enum[property.enum.length - 1], 'minimal');
    assert.equal(property.enumItemLabels[property.enumItemLabels.length - 1], 'minimal');
  });
});

describe('applyModelConfigurationEffort', () => {
  const base = { temperature: 0.6, reasoning_effort: 'low' };

  test('leaves options unchanged without a picker value', () => {
    assert.deepEqual(applyModelConfigurationEffort(base, undefined), base);
    assert.deepEqual(applyModelConfigurationEffort(base, {}), base);
    assert.deepEqual(applyModelConfigurationEffort(base, { reasoningEffort: 3 }), base);
    assert.deepEqual(applyModelConfigurationEffort(base, ['high']), base);
  });

  test('the picker value overrides the settings value', () => {
    assert.deepEqual(applyModelConfigurationEffort(base, { reasoningEffort: 'high' }), {
      temperature: 0.6,
      reasoning_effort: 'high',
    });
  });

  test('Server Default removes the parameter entirely', () => {
    assert.deepEqual(applyModelConfigurationEffort(base, { reasoningEffort: SERVER_DEFAULT_EFFORT }), {
      temperature: 0.6,
    });
  });

  test('writes to the configured parameter name', () => {
    const result = applyModelConfigurationEffort({}, { reasoningEffort: 'medium' }, 'reasoning_budget');
    assert.deepEqual(result, { reasoning_budget: 'medium' });
  });

  test('keeps an unchanged numeric value as a number', () => {
    const result = applyModelConfigurationEffort({ reasoning_budget: 1024 }, { reasoningEffort: '1024' }, 'reasoning_budget');
    assert.deepEqual(result, { reasoning_budget: 1024 });
  });

  test('does not mutate its input', () => {
    const input = { reasoning_effort: 'low' };
    applyModelConfigurationEffort(input, { reasoningEffort: SERVER_DEFAULT_EFFORT });
    assert.deepEqual(input, { reasoning_effort: 'low' });
  });
});

describe('parseAcceptedEffortValues (issue #146)', () => {
  test('reads the list from a vLLM/DeepSeek rejection nested in a LiteLLM error', () => {
    const message =
      'Chat completion failed: 400 Bad Request - {"error":{"message":"litellm.BadRequestError: Hosted_vllmException - ' +
      '{\\"error\\":{\\"message\\":\\"DeepSeek V4.1 reasoning_effort must be low, high, xhigh, max, or an integer within [1, 100] ' +
      'in chat_template_kwargs\\",\\"type\\":\\"BadRequestError\\",\\"param\\":null,\\"code\\":400}}"}}';
    assert.deepEqual(parseAcceptedEffortValues(message), ['low', 'high', 'xhigh', 'max']);
  });

  test('reads a pydantic-style "Input should be" message', () => {
    const message =
      '400 Bad Request - {"detail":[{"loc":["body","reasoning_effort"],"msg":"Input should be \'low\', \'medium\' or \'high\'","type":"literal_error"}]}';
    assert.deepEqual(parseAcceptedEffortValues(message), ['low', 'medium', 'high']);
  });

  test('reads an OpenAI-style "Supported values are" message', () => {
    const message =
      "Unsupported value: 'reasoning_effort' does not support 'medium' with this model. Supported values are: 'low' and 'high'.";
    assert.deepEqual(parseAcceptedEffortValues(message), ['low', 'high']);
  });

  test('honours a custom parameter name', () => {
    assert.deepEqual(
      parseAcceptedEffortValues('thinking_level must be one of [minimal, low, high]', 'thinking_level'),
      ['minimal', 'low', 'high']
    );
  });

  test('ignores errors that are not about the thinking effort', () => {
    assert.equal(parseAcceptedEffortValues('400 Bad Request - temperature must be between 0 and 2'), undefined);
    assert.equal(parseAcceptedEffortValues('400 Bad Request - context length exceeded'), undefined);
  });

  test('ignores a list that is nowhere near the effort mention', () => {
    const filler = 'x'.repeat(200);
    assert.equal(
      parseAcceptedEffortValues(`reasoning_effort was medium ${filler} role must be user, assistant or system`),
      undefined
    );
  });

  test('handles pathological input in linear time', () => {
    const quotes = `'"\``.repeat(200_000);
    const started = Date.now();
    assert.deepEqual(parseAcceptedEffortValues(`reasoning_effort must be low, ${quotes}x${quotes}`), ['low']);
    assert.equal(parseAcceptedEffortValues(`reasoning_effort ${'must be '.repeat(100_000)}`), undefined);
    assert.ok(Date.now() - started < 1000, 'parser should not backtrack on long runs');
  });

  test('strips mixed quotes and brackets around values', () => {
    assert.deepEqual(parseAcceptedEffortValues("reasoning_effort must be one of ['low', `high`, (max)]"), ['low', 'high', 'max']);
  });

  test('returns undefined when only a numeric range is accepted', () => {
    assert.equal(parseAcceptedEffortValues('reasoning_effort must be an integer within [1, 100]'), undefined);
  });
});

describe('buildThinkingEffortSchema with accepted values (issue #146)', () => {
  test('offers only the server-accepted values, with friendly labels', () => {
    const property = buildThinkingEffortSchema(undefined, ['low', 'high', 'xhigh', 'max']).properties[
      MODEL_CONFIG_EFFORT_KEY
    ];
    assert.deepEqual(property.enum, [SERVER_DEFAULT_EFFORT, 'low', 'high', 'xhigh', 'max']);
    assert.deepEqual(property.enumItemLabels, ['Server Default', 'Low', 'High', 'Extra High', 'Max']);
    assert.equal(property.enum.includes('medium'), false);
  });

  test('keeps a configured custom value selectable', () => {
    const property = buildThinkingEffortSchema('42', ['low', 'high']).properties[MODEL_CONFIG_EFFORT_KEY];
    assert.deepEqual(property.enum, [SERVER_DEFAULT_EFFORT, 'low', 'high', '42']);
    assert.equal(property.default, '42');
  });

  test('an empty list falls back to the standard presets', () => {
    const property = buildThinkingEffortSchema(undefined, []).properties[MODEL_CONFIG_EFFORT_KEY];
    assert.deepEqual(property.enum, [SERVER_DEFAULT_EFFORT, 'low', 'medium', 'high']);
  });
});
