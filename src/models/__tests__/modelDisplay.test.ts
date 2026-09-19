import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeModels,
  describeModel,
  friendlyModelName,
  inferModelFamily,
  modelIdPrefix,
  resolveDisplayNames,
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

describe('modelIdPrefix', () => {
  test('returns the Hugging-Face org or aggregator upstream', () => {
    assert.equal(modelIdPrefix('Qwen/Qwen3-8B'), 'Qwen');
    assert.equal(modelIdPrefix('openrouter/deepseek-chat'), 'openrouter');
  });

  test('keeps nested prefixes intact', () => {
    assert.equal(modelIdPrefix('openrouter/deepseek/deepseek-chat'), 'openrouter/deepseek');
  });

  test('is undefined for unprefixed, leading-slash and trailing-slash ids', () => {
    assert.equal(modelIdPrefix('gpt-4o-mini'), undefined);
    assert.equal(modelIdPrefix('/gpt-4o-mini'), undefined);
    assert.equal(modelIdPrefix('foo/'), undefined);
  });
});

describe('resolveDisplayNames', () => {
  test('uses friendly names when they are unique', () => {
    const names = resolveDisplayNames(['Qwen/Qwen3-8B', 'ollama/llama3', 'gpt-4o-mini']);
    assert.equal(names.get('Qwen/Qwen3-8B'), 'Qwen3-8B');
    assert.equal(names.get('ollama/llama3'), 'llama3');
    assert.equal(names.get('gpt-4o-mini'), 'gpt-4o-mini');
  });

  test('keeps the full id for models whose friendly names collide (issue #99)', () => {
    const names = resolveDisplayNames([
      'deepseek/deepseek-chat',
      'openrouter/deepseek-chat',
      'ollama/llama3',
    ]);
    assert.equal(names.get('deepseek/deepseek-chat'), 'deepseek/deepseek-chat');
    assert.equal(names.get('openrouter/deepseek-chat'), 'openrouter/deepseek-chat');
    assert.equal(names.get('ollama/llama3'), 'llama3');
  });

  test('an unprefixed id colliding with a prefixed one keeps both full', () => {
    const names = resolveDisplayNames(['deepseek-chat', 'openrouter/deepseek-chat']);
    assert.equal(names.get('deepseek-chat'), 'deepseek-chat');
    assert.equal(names.get('openrouter/deepseek-chat'), 'openrouter/deepseek-chat');
  });

  test('returns an empty map for an empty list', () => {
    assert.equal(resolveDisplayNames([]).size, 0);
  });
});

describe('inferModelFamily', () => {
  test('detects known families', () => {
    assert.equal(inferModelFamily('Qwen/Qwen3-8B'), 'qwen');
    assert.equal(inferModelFamily('meta-llama/Llama-3.1-8B-Instruct'), 'llama');
    assert.equal(inferModelFamily('mistralai/Mistral-7B'), 'mistral');
    assert.equal(inferModelFamily('deepseek-ai/DeepSeek-V3'), 'deepseek');
  });

  test('matches against the whole id, so an aggregator prefix does not hide the family', () => {
    assert.equal(inferModelFamily('ollama/qwen3:8b'), 'qwen');
    assert.equal(inferModelFamily('openrouter/deepseek-chat'), 'deepseek');
    assert.equal(inferModelFamily('bedrock/mistral-large'), 'mistral');
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
