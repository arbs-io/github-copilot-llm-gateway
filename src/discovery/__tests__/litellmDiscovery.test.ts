import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CancellationToken } from 'vscode';
import type { LiteLLMModelInfoProbe } from '../../api/client';
import {
  LiteLLMDiscovery,
  LiteLLMDiscoveryClient,
  describeProbeOutcome,
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

  test('skips wildcard deployments', () => {
    const parsed = parseLiteLLMModelInfoResponse({
      data: [entry('*'), entry('openai/*'), entry('gpt', { max_input_tokens: 100 })],
    });
    assert.ok(parsed);
    assert.deepEqual([...parsed.keys()], ['gpt']);
  });

  test('load-balanced deployments sharing a name fold to the smallest limits', () => {
    const parsed = parseLiteLLMModelInfoResponse({
      data: [
        entry('gpt', { max_input_tokens: 200, max_output_tokens: 50, supports_vision: true }),
        entry('gpt', { max_input_tokens: 100, supports_vision: false, supports_function_calling: true }),
        entry('gpt', { max_output_tokens: 80 }),
      ],
    });
    const gpt = parsed?.get('gpt');
    assert.equal(gpt?.maxInputTokens, 100);
    assert.equal(gpt?.maxOutputTokens, 50);
    assert.equal(gpt?.supportsVision, false);
    assert.equal(gpt?.supportsFunctionCalling, true);
  });

  test('ignores null, non-positive or non-numeric limits', () => {
    const parsed = parseLiteLLMModelInfoResponse({
      data: [entry('m', { max_input_tokens: null, max_output_tokens: '4096' }), entry('n', { max_input_tokens: 0 })],
    });
    assert.equal(parsed?.get('m')?.maxInputTokens, undefined);
    assert.equal(parsed?.get('m')?.maxOutputTokens, undefined);
    assert.equal(parsed?.get('n')?.maxInputTokens, undefined);
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
    // `litellm --model X` mode answers a single dict, not a list.
    assert.equal(parseLiteLLMModelInfoResponse({ data: entry('*') }), undefined);
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

function fakeClient(
  probe: LiteLLMModelInfoProbe
): { client: LiteLLMDiscoveryClient; counters: { fetches: number } } {
  const counters = { fetches: 0 };
  const client: LiteLLMDiscoveryClient = {
    fetchLiteLLMModelInfo: () => {
      counters.fetches += 1;
      return Promise.resolve(probe);
    },
  };
  return { client, counters };
}

const NOT_FOUND: LiteLLMModelInfoProbe = { kind: 'http', status: 404 };

const LITELLM_BODY: LiteLLMModelInfoProbe = {
  kind: 'ok',
  body: {
    data: [
      entry('claude-sonnet', { max_input_tokens: 200000, max_output_tokens: 64000 }),
      entry('gpt-4o', { max_input_tokens: 128000, max_output_tokens: 16384 }),
    ],
  },
};

describe('describeProbeOutcome', () => {
  test('names the model count on success', () => {
    const parsed = new Map([['a', { modelName: 'a' }]]);
    assert.match(describeProbeOutcome(LITELLM_BODY, parsed), /1 model\(s\)/);
  });

  test('a 404 reads as a different backend', () => {
    assert.match(describeProbeOutcome(NOT_FOUND, undefined), /not LiteLLM .*404/);
  });

  test('a 401/403 tells the user to check the key and refresh', () => {
    const line = describeProbeOutcome({ kind: 'http', status: 401 }, undefined);
    assert.match(line, /401/);
    assert.match(line, /API key/);
    assert.match(line, /Refresh Models/);
  });

  test('a timeout says the verdict is cached until refresh', () => {
    const line = describeProbeOutcome({ kind: 'unreachable', reason: 'timed out' }, undefined);
    assert.match(line, /timed out/);
    assert.match(line, /Refresh Models/);
  });

  test('a 200 in the wrong shape is reported as such', () => {
    assert.match(describeProbeOutcome({ kind: 'ok', body: {} }, undefined), /not in LiteLLM's shape/);
  });
});

describe('LiteLLMDiscovery', () => {
  test('non-LiteLLM server: one fetch, no results for any model', async () => {
    const { client, counters } = fakeClient(NOT_FOUND);
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
    const { client, counters } = fakeClient(NOT_FOUND);
    const discovery = new LiteLLMDiscovery({ client, log: () => undefined });
    await discovery.enrichModel('a', cancelledToken());
    await discovery.enrichModel('a');
    assert.equal(counters.fetches, 2);
  });

  test('a successful fetch under a cancelled token is still cached (it is a real answer)', async () => {
    const { client, counters } = fakeClient(LITELLM_BODY);
    const discovery = new LiteLLMDiscovery({ client, log: () => undefined });
    assert.equal((await discovery.enrichModel('gpt-4o', cancelledToken()))?.contextLength, 128000);
    await discovery.enrichModel('gpt-4o');
    assert.equal(counters.fetches, 1);
  });

  test('reset() during an in-flight cancelled load does not clobber the new generation', async () => {
    let resolveFirst: (probe: LiteLLMModelInfoProbe) => void = () => undefined;
    let calls = 0;
    const client: LiteLLMDiscoveryClient = {
      fetchLiteLLMModelInfo: () => {
        calls += 1;
        return calls === 1
          ? new Promise<LiteLLMModelInfoProbe>((resolve) => { resolveFirst = resolve; })
          : Promise.resolve(LITELLM_BODY);
      },
    };
    const discovery = new LiteLLMDiscovery({ client, log: () => undefined });
    const first = discovery.enrichModel('gpt-4o', cancelledToken());
    discovery.reset();
    const second = discovery.enrichModel('gpt-4o');
    resolveFirst(NOT_FOUND);
    assert.equal(await first, undefined);
    assert.equal((await second)?.contextLength, 128000);
    // The second generation's verdict survived the first one's late abort.
    await discovery.enrichModel('claude-sonnet');
    assert.equal(calls, 2);
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
