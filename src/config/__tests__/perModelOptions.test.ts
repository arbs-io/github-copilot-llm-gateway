import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePerModelOptions } from '../perModelOptions';

describe('resolvePerModelOptions', () => {
  test('returns an empty object when the map is undefined or empty', () => {
    assert.deepEqual(resolvePerModelOptions('m', undefined), {});
    assert.deepEqual(resolvePerModelOptions('m', {}), {});
  });

  test('returns an empty object when nothing matches', () => {
    const map = { 'gpt-4': { temperature: 0.2 } };
    assert.deepEqual(resolvePerModelOptions('llama-3', map), {});
  });

  test('matches an exact model id', () => {
    const map = { 'Qwen3-32B': { temperature: 0.7, top_p: 0.8 } };
    assert.deepEqual(resolvePerModelOptions('Qwen3-32B', map), {
      temperature: 0.7,
      top_p: 0.8,
    });
  });

  test('matches a trailing wildcard family pattern (case-insensitive)', () => {
    const map = { 'qwen*': { temperature: 0.7, top_k: 20 } };
    assert.deepEqual(resolvePerModelOptions('Qwen3-32B-Instruct', map), {
      temperature: 0.7,
      top_k: 20,
    });
  });

  test('matches a leading wildcard pattern', () => {
    const map = { '*-instruct': { top_p: 0.9 } };
    assert.deepEqual(resolvePerModelOptions('mistral-7b-instruct', map), { top_p: 0.9 });
  });

  test('exact-id entries override wildcard family entries on key collision', () => {
    const map = {
      'qwen*': { temperature: 0.7, top_p: 0.8 },
      'Qwen3-32B': { temperature: 0.0 },
    };
    assert.deepEqual(resolvePerModelOptions('Qwen3-32B', map), {
      temperature: 0.0,
      top_p: 0.8,
    });
  });

  test('merges multiple matching wildcard entries', () => {
    const map = {
      'qwen*': { temperature: 0.7 },
      '*-instruct': { top_p: 0.9 },
    };
    assert.deepEqual(resolvePerModelOptions('qwen-7b-instruct', map), {
      temperature: 0.7,
      top_p: 0.9,
    });
  });

  test('treats `*` literally rather than as regex special characters', () => {
    const map = { 'model.v1+beta': { seed: 1 } };
    // The `.` and `+` must match literally, not as regex metacharacters.
    assert.deepEqual(resolvePerModelOptions('model.v1+beta', map), { seed: 1 });
    assert.deepEqual(resolvePerModelOptions('modelXv1Xbeta', map), {});
  });

  test('ignores entries whose value is not a plain object', () => {
    const map = {
      'm': 'not-an-object',
      'm*': [1, 2, 3],
      'model-x': { temperature: 0.5 },
    } as Record<string, unknown>;
    assert.deepEqual(resolvePerModelOptions('model-x', map), { temperature: 0.5 });
  });

  test('does not return a reference to the stored options object', () => {
    const stored = { temperature: 0.7 };
    const map = { 'model-x': stored };
    const result = resolvePerModelOptions('model-x', map);
    assert.notStrictEqual(result, stored);
    result.temperature = 0.1;
    assert.equal(stored.temperature, 0.7);
  });
});
