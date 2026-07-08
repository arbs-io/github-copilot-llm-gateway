import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CancellationToken, LanguageModelChatInformation } from 'vscode';
import { ModelCatalog } from '../modelCatalog';
import { GatewayClient } from '../../api/client';
import { GatewayConfig } from '../../config/gatewayConfig';
import { OpenAIModelsResponse } from '../../api/types';
import { TOKEN_CONSTANTS } from '../../chat/tokenBudget';

function fakeToken(cancelled = false): CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  } as unknown as CancellationToken;
}

function fakeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    serverUrl: 'http://localhost:8000',
    apiKey: '',
    requestTimeout: 60000,
    defaultMaxTokens: 128000,
    defaultMaxOutputTokens: 4096,
    enableImageInput: true,
    enableToolCalling: true,
    parallelToolCalling: true,
    agentTemperature: 0,
    verboseLogging: false,
    customHeaders: {},
    extraModelOptions: {},
    perModelOptions: {},
    modelContextWindows: {},
    enableInlineCompletion: false,
    inlineCompletionModel: '',
    inlineCompletionMaxTokens: 256,
    inlineCompletionDebounce: 300,
    inlineCompletionTimeout: 3000,
    inlineCompletionMaxPrefixChars: 4000,
    inlineCompletionMaxSuffixChars: 1000,
    ...overrides,
  };
}

function modelsResponse(...ids: Array<{ id: string; contextLen?: number }>): OpenAIModelsResponse {
  return {
    object: 'list',
    data: ids.map(({ id, contextLen }) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'test',
      ...(contextLen !== undefined ? { max_model_len: contextLen } : {}),
    })),
  };
}

interface Harness {
  catalog: ModelCatalog;
  fetchCalls: number;
  statusChanges: number;
}

function makeCatalog(options: {
  fetchModels: () => Promise<OpenAIModelsResponse>;
  config?: GatewayConfig;
}): Harness {
  const harness = { fetchCalls: 0, statusChanges: 0 } as Harness;
  const client = {
    fetchModels: () => {
      harness.fetchCalls++;
      return options.fetchModels();
    },
  } as unknown as GatewayClient;
  harness.catalog = new ModelCatalog({
    client,
    getConfig: () => options.config ?? fakeConfig(),
    log: () => undefined,
    onStatusChanged: () => {
      harness.statusChanges++;
    },
  });
  return harness;
}

function chatInfo(id: string, maxInputTokens = 0): LanguageModelChatInformation {
  return { id, maxInputTokens } as unknown as LanguageModelChatInformation;
}

describe('ModelCatalog.getOrFetchModels', () => {
  test('fetches, exposes models, and records a successful connection', async () => {
    const h = makeCatalog({
      fetchModels: () => Promise.resolve(modelsResponse({ id: 'a' }, { id: 'b' })),
    });
    const { models, error } = await h.catalog.getOrFetchModels(fakeToken());
    assert.equal(error, undefined);
    assert.deepEqual(models.map((m) => m.id), ['a', 'b']);
    assert.deepEqual(h.catalog.getCachedModels().map((m) => m.id), ['a', 'b']);
    assert.notEqual(h.catalog.getLastSuccessfulFetchAt(), undefined);
    assert.equal(h.catalog.getLastConnectionError(), undefined);
    assert.equal(h.statusChanges, 1);
  });

  test('serves the short-lived cache instead of re-fetching', async () => {
    const h = makeCatalog({
      fetchModels: () => Promise.resolve(modelsResponse({ id: 'a' })),
    });
    await h.catalog.getOrFetchModels(fakeToken());
    await h.catalog.getOrFetchModels(fakeToken());
    assert.equal(h.fetchCalls, 1);
  });

  test('re-fetches after invalidateCache', async () => {
    const h = makeCatalog({
      fetchModels: () => Promise.resolve(modelsResponse({ id: 'a' })),
    });
    await h.catalog.getOrFetchModels(fakeToken());
    h.catalog.invalidateCache();
    await h.catalog.getOrFetchModels(fakeToken());
    assert.equal(h.fetchCalls, 2);
  });

  test('concurrent callers share a single in-flight request', async () => {
    let release: (r: OpenAIModelsResponse) => void = () => undefined;
    const h = makeCatalog({
      fetchModels: () => new Promise((resolve) => { release = resolve; }),
    });
    const first = h.catalog.getOrFetchModels(fakeToken());
    const second = h.catalog.getOrFetchModels(fakeToken());
    release(modelsResponse({ id: 'a' }));
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(h.fetchCalls, 1);
    assert.deepEqual(r1.models.map((m) => m.id), ['a']);
    assert.deepEqual(r2.models.map((m) => m.id), ['a']);
  });

  test('surfaces fetch failures as an error result and records the connection error', async () => {
    const h = makeCatalog({
      fetchModels: () => Promise.reject(new Error('boom')),
    });
    const { models, error } = await h.catalog.getOrFetchModels(fakeToken());
    assert.deepEqual(models, []);
    assert.equal(error, 'boom');
    assert.equal(h.catalog.getLastConnectionError(), 'boom');
    assert.equal(h.statusChanges, 1);
  });

  test('a later success clears the recorded connection error', async () => {
    let fail = true;
    const h = makeCatalog({
      fetchModels: () =>
        fail ? Promise.reject(new Error('boom')) : Promise.resolve(modelsResponse({ id: 'a' })),
    });
    await h.catalog.getOrFetchModels(fakeToken());
    fail = false;
    await h.catalog.getOrFetchModels(fakeToken());
    assert.equal(h.catalog.getLastConnectionError(), undefined);
  });

  test('does not cache results from a cancelled fetch', async () => {
    const h = makeCatalog({
      fetchModels: () => Promise.resolve(modelsResponse({ id: 'a' })),
    });
    const { models } = await h.catalog.getOrFetchModels(fakeToken(true));
    assert.deepEqual(models, []);
    assert.equal(h.catalog.getLastSuccessfulFetchAt(), undefined);
    // Next (uncancelled) call must re-probe rather than see a stale empty list.
    await h.catalog.getOrFetchModels(fakeToken());
    assert.equal(h.fetchCalls, 2);
    assert.equal(h.catalog.getCachedModels().length, 1);
  });
});

describe('ModelCatalog.resolveModelMaxContext', () => {
  test('prefers the server-reported context recorded during the fetch', async () => {
    const h = makeCatalog({
      fetchModels: () => Promise.resolve(modelsResponse({ id: 'a', contextLen: 2048 })),
    });
    await h.catalog.getOrFetchModels(fakeToken());
    assert.equal(h.catalog.getContextForModel('a'), 2048);
    assert.equal(h.catalog.resolveModelMaxContext(chatInfo('a', 999999)), 2048);
  });

  test('falls back to the picker-facing maxInputTokens before any fetch', () => {
    const h = makeCatalog({ fetchModels: () => Promise.resolve(modelsResponse()) });
    assert.equal(h.catalog.resolveModelMaxContext(chatInfo('a', 4096)), 4096);
  });

  test('falls back to the default context when nothing is known', () => {
    const h = makeCatalog({ fetchModels: () => Promise.resolve(modelsResponse()) });
    assert.equal(
      h.catalog.resolveModelMaxContext(chatInfo('a')),
      TOKEN_CONSTANTS.DEFAULT_CONTEXT_TOKENS
    );
  });
});

describe('ModelCatalog.learnContextSizeFromError', () => {
  test('learns a smaller context from an overflow error and applies it', () => {
    const h = makeCatalog({ fetchModels: () => Promise.resolve(modelsResponse()) });
    const model = chatInfo('a', 8192);
    const learned = h.catalog.learnContextSizeFromError(
      model,
      new Error("This model's maximum context length is 4096 tokens. However, you requested 5000 tokens.")
    );
    assert.equal(learned, true);
    assert.equal(h.catalog.resolveModelMaxContext(model), 4096);
  });

  test('ignores unrelated errors', () => {
    const h = makeCatalog({ fetchModels: () => Promise.resolve(modelsResponse()) });
    assert.equal(
      h.catalog.learnContextSizeFromError(chatInfo('a', 8192), new Error('connection refused')),
      false
    );
  });

  test('returns false when the reported context is not smaller than the current budget', () => {
    const h = makeCatalog({ fetchModels: () => Promise.resolve(modelsResponse()) });
    const model = chatInfo('a', 4096);
    const learned = h.catalog.learnContextSizeFromError(
      model,
      new Error('maximum context length is 8192 tokens')
    );
    assert.equal(learned, false);
    assert.equal(h.catalog.resolveModelMaxContext(model), 4096);
  });

  test('clearLearnedContexts reverts to the advertised size', () => {
    const h = makeCatalog({ fetchModels: () => Promise.resolve(modelsResponse()) });
    const model = chatInfo('a', 8192);
    h.catalog.learnContextSizeFromError(model, new Error('maximum context length is 4096 tokens'));
    assert.equal(h.catalog.resolveModelMaxContext(model), 4096);
    h.catalog.clearLearnedContexts();
    assert.equal(h.catalog.resolveModelMaxContext(model), 8192);
  });
});
