import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeModels,
  describeModel,
  friendlyModelName,
  inferModelFamily,
} from '../modelDisplay';

describe('friendlyModelName', () => {
  test('strips Hugging-Face org prefix', () => {
    assert.equal(friendlyModelName('Qwen/Qwen3-8B'), 'Qwen3-8B');
    assert.equal(friendlyModelName('meta-llama/Llama-3.1-8B-Instruct'), 'Llama-3.1-8B-Instruct');
  });

  test('returns the id unchanged when there is no slash', () => {
    assert.equal(friendlyModelName('gpt-4o-mini'), 'gpt-4o-mini');
  });

  test('handles trailing slash without breaking', () => {
    assert.equal(friendlyModelName('foo/'), 'foo/');
  });
});

describe('inferModelFamily', () => {
  test('detects known families', () => {
    assert.equal(inferModelFamily('Qwen/Qwen3-8B'), 'qwen');
    assert.equal(inferModelFamily('meta-llama/Llama-3.1-8B-Instruct'), 'llama');
    assert.equal(inferModelFamily('mistralai/Mistral-7B'), 'mistral');
    assert.equal(inferModelFamily('deepseek-ai/DeepSeek-V3'), 'deepseek');
  });

  test('falls back to llm-gateway for unknown models', () => {
    assert.equal(inferModelFamily('unknown-vendor/UnknownModel'), 'llm-gateway');
  });
});

describe('describeModel', () => {
  test('uses max_model_len when present', () => {
    const detail = describeModel({
      id: 'x', object: 'model', created: 0, owned_by: 'vllm', max_model_len: 32768,
    });
    assert.ok(detail.includes('33K ctx'));
    assert.ok(detail.includes('vllm'));
  });

  test('falls back to context_length', () => {
    const detail = describeModel({
      id: 'x', object: 'model', created: 0, owned_by: 'ollama', context_length: 8192,
    });
    assert.ok(detail.includes('8K ctx'));
  });

  test('omits context when no size is reported', () => {
    const detail = describeModel({ id: 'x', object: 'model', created: 0, owned_by: 'whoever' });
    assert.ok(!detail.includes('ctx'));
    assert.ok(detail.includes('whoever'));
  });
});

describe('dedupeModels', () => {
  test('removes duplicate ids, preserving first-seen order', () => {
    const models = [
      { id: 'a', object: 'model', created: 0, owned_by: 'x' },
      { id: 'b', object: 'model', created: 0, owned_by: 'x' },
      { id: 'a', object: 'model', created: 0, owned_by: 'y' },
    ];
    const result = dedupeModels(models);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((m) => m.id), ['a', 'b']);
  });

  test('returns the same list when all ids are unique', () => {
    const models = [
      { id: 'a', object: 'model', created: 0, owned_by: 'x' },
      { id: 'b', object: 'model', created: 0, owned_by: 'x' },
    ];
    const result = dedupeModels(models);
    assert.equal(result.length, 2);
  });
});
