import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THINKING_EFFORT_PARAMETER,
  THINKING_EFFORT_PRESETS,
  applyThinkingEffort,
  resolveThinkingEffort,
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
