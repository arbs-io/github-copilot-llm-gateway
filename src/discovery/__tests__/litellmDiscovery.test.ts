import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CancellationToken } from 'vscode';
import {
  LiteLLMDiscovery,
  LiteLLMDiscoveryClient,
  parseLiteLLMModelInfoResponse,
  toDiscoveredModelInfo,
} from '../litellmDiscovery';

function entry(
  modelName: string,
  modelInfo: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    model_name: modelName,
    litellm_params: { model: `openai/${modelName}` },
    model_info: { id: `${modelName}-id`, db_model: false, mode: 'chat', ...modelInfo },
  };
}

describe('parseLiteLLMModelInfoResponse', () => {
  test('extracts limits and capability flags per public model name', () => {
    const parsed = parseLiteLLMModelInfoResponse({
      data: [
        entry('claude-sonnet', {
          max_input_tokens: 200000,
          max_output_tokens: 64000,
          supports_vision: true,
          supports_function_calling: true,
        }),
        entry('local-qwen', { max_input_tokens: 32768, max_output_tokens: 32768 }),
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed.size, 2);
    const sonnet = parsed.get('claude-sonnet');
    assert.deepEqual(sonnet, {
      modelName: 'claude-sonnet',
      maxInputTokens: 200000,
      maxOutputTokens: 64000,
      supportsVision: true,
      supportsFunctionCalling: true,
    });
    const qwen = parsed.get('local-qwen');
    assert.equal(qwen?.supportsVision, undefined);
    assert.equal(qwen?.supportsFunctionCalling, undefined);
  });

  test('skips wildcard deployments and keeps the first of duplicate names', () => {
    const parsed = parseLiteLLMModelInfoResponse({
      data: [
        entry('*'),
        entry('openai/*'),
        entry('gpt', { max_input_tokens: 100 }),
        entry('gpt', { max_input_tokens: 200 }),
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed.size, 1);
    assert.equal(parsed.get('gpt')?.maxInputTokens, 100);
  });

  test('ignores non-positive or non-numeric limits', () => {
    const parsed = parseLiteLLMModelInfoResponse({
      data: [entry('m', { max_input_tokens: 0, max_output_tokens: '4096' })],
    });
    assert.equal(parsed?.get('m')?.maxInputTokens, undefined);
    assert.equal(parsed?.get('m')?.maxOutputTokens, undefined);
  });

  test('tolerates a missing model_info block', () => {
    const parsed = parseLiteLLMModelInfoResponse({ data: [{ model_name: 'bare' }] });
    assert.equal(parsed?.get('bare')?.modelName, 'bare');
  });

  test('returns undefined for bodies that do not look like LiteLLM', () => {
    assert.equal(parseLiteLLMModelInfoResponse(undefined), undefined);
    assert.equal(parseLiteLLMModelInfoResponse('nope'), undefined);
    assert.equal(parseLiteLLMModelInfoResponse({ data: [] }), undefined);
    assert.equal(parseLiteLLMModelInfoResponse({ data: 'x' }), undefined);
    // An OpenAI `/v1/models` shape answered on the wrong path.
    assert.equal(
      parseLiteLLMModelInfoResponse({ object: 'list', data: [{ id: 'm', object: 'model' }] }),
      undefined
    );
  });
});

describe('toDiscoveredModelInfo (LiteLLM)', () => {
  test('a smaller output ceiling is a separate window', () => {
    const info = toDiscoveredModelInfo({
      modelName: 'm', maxInputTokens: 200000, maxOutputTokens: 64000,
      supportsVision: true, supportsFunctionCalling: false,
    });
    assert.equal(info.contextLength, 200000);
    assert.equal(info.maxOutputTokens, 64000);
    assert.equal(info.separateOutputWindow, true);
    assert.equal(info.contextSource, 'LiteLLM max_input_tokens (/model/info)');
    assert.equal(info.visionSupported, true);
    assert.equal(info.toolsSupported, false);
    assert.deepEqual(info.samplerParams, {});
  });

  test('equal ceilings describe one shared window', () => {
    const info = toDiscoveredModelInfo({ modelName: 'm', maxInputTokens: 32768, maxOutputTokens: 32768 });
    assert.equal(info.separateOutputWindow, false);
  });

  test('no limits reported: no context, no source, not separate', () => {
    const info = toDiscoveredModelInfo({ modelName: 'm' });
    assert.equal(info.contextLength, undefined);
    assert.equal(info.contextSource, undefined);
    assert.equal(info.separateOutputWindow, false);
  });
});

function cancelledToken(): CancellationToken {
  return {
    isCancellationRequested: true,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  } as unknown as CancellationToken;
}

function fakeClient(body: unknown): { client: LiteLLMDiscoveryClient; counters: { fetches: number } } {
  const counters = { fetches: 0 };
  const client: LiteLLMDiscoveryClient = {
    fetchLiteLLMModelInfo: () => {
      counters.fetches += 1;
      return Promise.resolve(body);
    },
  };
  return { client, counters };
}

const LITELLM_BODY = {
  data: [
    entry('claude-sonnet', { max_input_tokens: 200000, max_output_tokens: 64000 }),
    entry('gpt-4o', { max_input_tokens: 128000, max_output_tokens: 16384 }),
  ],
};

describe('LiteLLMDiscovery', () => {
  test('non-LiteLLM server: one fetch, no results for any model', async () => {
    const { client, counters } = fakeClient(undefined);
    const discovery = new LiteLLMDiscovery({ client, log: () => undefined });
    assert.equal(await discovery.enrichModel('a'), undefined);
    assert.equal(await discovery.enrichModel('b'), undefined);
    assert.equal(counters.fetches, 1);
  });

  test('LiteLLM server: one fetch serves every model', async () => {
    const { client, counters } = fakeClient(LITELLM_BODY);
    const discovery = new LiteLLMDiscovery({ client, log: () => undefined });
    const [sonnet, gpt, unknown] = await Promise.all([
      discovery.enrichModel('claude-sonnet'),
      discovery.enrichModel('gpt-4o'),
      discovery.enrichModel('not-listed'),
    ]);
    assert.equal(sonnet?.contextLength, 200000);
    assert.equal(sonnet?.separateOutputWindow, true);
    assert.equal(gpt?.maxOutputTokens, 16384);
    assert.equal(unknown, undefined);
    assert.equal(counters.fetches, 1);
  });

  test('a thrown fetch reads as not-LiteLLM instead of rejecting', async () => {
    const client: LiteLLMDiscoveryClient = {
      fetchLiteLLMModelInfo: () => Promise.reject(new Error('boom')),
    };
    const discovery = new LiteLLMDiscovery({ client, log: () => undefined });
    assert.equal(await discovery.enrichModel('a'), undefined);
  });

  test('reset() forgets the cached metadata and fetches again', async () => {
    const { client, counters } = fakeClient(LITELLM_BODY);
    const discovery = new LiteLLMDiscovery({ client, log: () => undefined });
    await discovery.enrichModel('gpt-4o');
    discovery.reset();
    await discovery.enrichModel('gpt-4o');
    assert.equal(counters.fetches, 2);
  });

  test('a cancelled negative fetch is not cached as a verdict', async () => {
    const { client, counters } = fakeClient(undefined);
    const discovery = new LiteLLMDiscovery({ client, log: () => undefined });
    await discovery.enrichModel('a', cancelledToken());
    await discovery.enrichModel('a');
    assert.equal(counters.fetches, 2);
  });

  test('logs detection once per generation', async () => {
    const lines: string[] = [];
    const { client } = fakeClient(LITELLM_BODY);
    const discovery = new LiteLLMDiscovery({ client, log: (m) => lines.push(m) });
    await Promise.all([discovery.enrichModel('gpt-4o'), discovery.enrichModel('claude-sonnet')]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /LiteLLM proxy detected/);
    assert.match(lines[0], /2 model\(s\)/);
  });
});
