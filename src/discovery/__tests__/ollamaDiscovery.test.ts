import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CancellationToken } from 'vscode';
import {
  OllamaDiscovery,
  OllamaDiscoveryClient,
  parseOllamaParameters,
  parseOllamaShowResponse,
  toDiscoveredModelInfo,
} from '../ollamaDiscovery';

describe('parseOllamaParameters', () => {
  test('parses numeric sampler params, ignores unknown/non-numeric', () => {
    const params = parseOllamaParameters(
      'repeat_penalty                 1.05\n' +
      'temperature                    0.7\n' +
      'top_k                          20\n' +
      'top_p                          0.8\n' +
      'num_ctx                        65536\n' +
      'presence_penalty               0\n' +
      'stop                           "<|im_end|>"'
    );
    assert.equal(params.temperature, 0.7);
    assert.equal(params.top_p, 0.8);
    assert.equal(params.top_k, 20);
    assert.equal(params.num_ctx, 65536);
    assert.equal(params.presence_penalty, 0);
    assert.equal(params.repeat_penalty, 1.05);
    assert.equal(params.stop, undefined);
  });

  test('returns empty object for non-string input', () => {
    assert.deepEqual(parseOllamaParameters(undefined), {});
  });
});

describe('parseOllamaShowResponse', () => {
  test('extracts num_ctx, trained context, params, capabilities', () => {
    const info = parseOllamaShowResponse({
      model_info: { 'qwen3.context_length': 262144, 'qwen3.block_count': 40 },
      parameters: 'temperature 0.7\ntop_p 0.8\nnum_ctx 65536',
      capabilities: ['completion', 'vision', 'tools', 'thinking'],
    });
    assert.ok(info);
    assert.equal(info.numCtx, 65536);
    assert.equal(info.trainedContext, 262144);
    assert.equal(info.params.top_p, 0.8);
    assert.deepEqual([...(info.capabilities ?? [])], ['completion', 'vision', 'tools', 'thinking']);
  });

  test('num_ctx omitted -> undefined, trained context still found', () => {
    const info = parseOllamaShowResponse({
      model_info: { 'gemma3.context_length': 8192 },
      parameters: 'temperature 1',
      capabilities: ['completion'],
    });
    assert.ok(info);
    assert.equal(info.numCtx, undefined);
    assert.equal(info.trainedContext, 8192);
  });

  test('capabilities field absent -> undefined (unknown), not empty', () => {
    // Older Ollama versions don't report capabilities at all; that must not
    // read as "supports nothing".
    const info = parseOllamaShowResponse({
      model_info: { 'llama.context_length': 4096 },
      parameters: 'temperature 0.6',
    });
    assert.ok(info);
    assert.equal(info.capabilities, undefined);
  });

  test('returns undefined for a non-Ollama body (no recognised keys)', () => {
    assert.equal(parseOllamaShowResponse({ id: 'gpt-4', object: 'model' }), undefined);
    assert.equal(parseOllamaShowResponse(null), undefined);
  });
});

describe('toDiscoveredModelInfo', () => {
  test('maps capabilities to booleans and prefers num_ctx for context', () => {
    const discovered = toDiscoveredModelInfo({
      numCtx: 65536,
      trainedContext: 262144,
      params: { top_p: 0.8 },
      capabilities: ['completion', 'tools'],
    });
    assert.equal(discovered.contextLength, 65536);
    assert.match(discovered.contextSource ?? '', /num_ctx/);
    assert.equal(discovered.toolsSupported, true);
    assert.equal(discovered.visionSupported, false);
    assert.equal(discovered.samplerParams.top_p, 0.8);
  });

  test('absent capabilities -> both verdicts unknown', () => {
    const discovered = toDiscoveredModelInfo({ trainedContext: 8192, params: {} });
    assert.equal(discovered.visionSupported, undefined);
    assert.equal(discovered.toolsSupported, undefined);
    assert.match(discovered.contextSource ?? '', /trained context/);
  });
});

interface FakeClientCounters {
  probes: number;
  shows: number;
}

function fakeClient(options: {
  isOllama: boolean;
  showBody?: unknown;
}): { client: OllamaDiscoveryClient; counters: FakeClientCounters } {
  const counters: FakeClientCounters = { probes: 0, shows: 0 };
  const client: OllamaDiscoveryClient = {
    probeOllama: () => {
      counters.probes++;
      return Promise.resolve(options.isOllama);
    },
    showModel: () => {
      counters.shows++;
      return Promise.resolve(options.showBody);
    },
  };
  return { client, counters };
}

function cancelledToken(): CancellationToken {
  return {
    isCancellationRequested: true,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  } as unknown as CancellationToken;
}

describe('OllamaDiscovery', () => {
  test('non-Ollama server: one probe, zero /api/show calls, no results', async () => {
    const { client, counters } = fakeClient({ isOllama: false });
    const discovery = new OllamaDiscovery({ client, log: () => undefined });
    assert.equal(await discovery.enrichModel('a'), undefined);
    assert.equal(await discovery.enrichModel('b'), undefined);
    assert.equal(counters.probes, 1);
    assert.equal(counters.shows, 0);
  });

  test('concurrent enrich calls share a single in-flight probe', async () => {
    const { client, counters } = fakeClient({ isOllama: false });
    const discovery = new OllamaDiscovery({ client, log: () => undefined });
    await Promise.all([discovery.enrichModel('a'), discovery.enrichModel('b')]);
    assert.equal(counters.probes, 1);
  });

  test('Ollama server: enriches each model via /api/show', async () => {
    const { client, counters } = fakeClient({
      isOllama: true,
      showBody: { parameters: 'num_ctx 65536\ntop_p 0.8', capabilities: ['tools'] },
    });
    const discovery = new OllamaDiscovery({ client, log: () => undefined });
    const discovered = await discovery.enrichModel('a');
    assert.ok(discovered);
    assert.equal(discovered.contextLength, 65536);
    assert.equal(discovered.samplerParams.top_p, 0.8);
    assert.equal(discovered.toolsSupported, true);
    assert.equal(counters.probes, 1);
    assert.equal(counters.shows, 1);
  });

  test('a thrown probe reads as not-Ollama instead of rejecting', async () => {
    const client: OllamaDiscoveryClient = {
      probeOllama: () => Promise.reject(new Error('boom')),
      showModel: () => Promise.resolve(undefined),
    };
    const discovery = new OllamaDiscovery({ client, log: () => undefined });
    assert.equal(await discovery.enrichModel('a'), undefined);
  });

  test('caches /api/show per model until reset()', async () => {
    const { client, counters } = fakeClient({
      isOllama: true,
      showBody: { parameters: 'top_p 0.9' },
    });
    const discovery = new OllamaDiscovery({ client, log: () => undefined });
    await discovery.enrichModel('a');
    await discovery.enrichModel('a');
    assert.equal(counters.shows, 1);
    discovery.reset();
    await discovery.enrichModel('a');
    assert.equal(counters.shows, 2);
  });

  test('a show result fetched under a cancelled token is not cached', async () => {
    const { client, counters } = fakeClient({
      isOllama: true,
      showBody: { parameters: 'top_p 0.9' },
    });
    const discovery = new OllamaDiscovery({ client, log: () => undefined });
    await discovery.enrichModel('a', cancelledToken());
    await discovery.enrichModel('a');
    assert.equal(counters.shows, 2);
  });

  test('reset() forgets the detection and probes again', async () => {
    const { client, counters } = fakeClient({ isOllama: false });
    const discovery = new OllamaDiscovery({ client, log: () => undefined });
    await discovery.enrichModel('a');
    discovery.reset();
    await discovery.enrichModel('a');
    assert.equal(counters.probes, 2);
  });

  test('a cancelled negative probe is not cached as a verdict', async () => {
    const { client, counters } = fakeClient({ isOllama: false });
    const discovery = new OllamaDiscovery({ client, log: () => undefined });
    await discovery.enrichModel('a', cancelledToken());
    // Next (uncancelled) call must re-probe rather than trust the aborted one.
    await discovery.enrichModel('a');
    assert.equal(counters.probes, 2);
  });
});
