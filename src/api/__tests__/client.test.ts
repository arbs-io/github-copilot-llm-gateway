import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompletionHttpError,
  GatewayClient,
  normalizeBaseUrl,
  normalizeApiKey,
  buildHeaders,
  extractUsage,
  RequestCancelledError,
  RequestTimeoutError,
} from '../client';

// Shared stream-test fixtures: a full GatewayConfig literal, a no-op
// cancellation token, and an SSE response factory. Used by the
// streamChatCompletion test blocks below.
const streamTestConfig = {
  serverUrl: 'http://localhost:11434',
  requestTimeout: 5000,
  defaultMaxTokens: 4096,
  defaultMaxOutputTokens: 4096,
  enableImageInput: false,
  enableToolCalling: true,
  parallelToolCalling: false,
  agentTemperature: 0,
  verboseLogging: false,
  customHeaders: {},
  extraModelOptions: {},
  perModelOptions: {},
  modelContextWindows: {},
  enableInlineCompletion: false,
  inlineCompletionModel: '',
  inlineCompletionMaxTokens: 128,
  inlineCompletionDebounce: 300,
  inlineCompletionTimeout: 5000,
  inlineCompletionMaxPrefixChars: 4000,
  inlineCompletionMaxSuffixChars: 2000,
  showReplyTokenUsage: false,
  sessionAffinityHeader: '',
  usageEndpoint: '/v1/usage/current',
  usageRefreshInterval: 300,
  usageWarningPercent: 20,
  usageCriticalPercent: 0,
  thinkingEffortParameter: 'reasoning_effort',
  thinkingEffortPicker: 'auto',
  loopGuardRepetition: true,
  loopGuardToolCalls: true,
  loopGuardToolNudgeAfter: 3,
  loopGuardToolBlockAfter: 5,
  replayReasoning: false,
} as unknown as import('../../config/gatewayConfig').GatewayConfig;

const streamTestToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as import('vscode').CancellationToken;

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join('\n\n') + '\n\n'));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('normalizeBaseUrl', () => {
  test('returns the URL unchanged when no normalization is needed', () => {
    assert.equal(normalizeBaseUrl('http://localhost:8000'), 'http://localhost:8000');
  });

  test('strips trailing slashes', () => {
    assert.equal(normalizeBaseUrl('http://localhost:8000/'), 'http://localhost:8000');
    assert.equal(normalizeBaseUrl('http://localhost:8000///'), 'http://localhost:8000');
  });

  test('strips a trailing /v1 (the most common user mistake)', () => {
    assert.equal(normalizeBaseUrl('http://localhost:8000/v1'), 'http://localhost:8000');
    assert.equal(normalizeBaseUrl('http://localhost:8000/v1/'), 'http://localhost:8000');
  });

  test('strips a trailing /openai/v1 (Azure-style endpoints)', () => {
    assert.equal(normalizeBaseUrl('https://x/openai/v1'), 'https://x');
    assert.equal(normalizeBaseUrl('https://x/openai/v1/'), 'https://x');
  });

  test('preserves other path segments', () => {
    assert.equal(normalizeBaseUrl('http://host/proxy'), 'http://host/proxy');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(normalizeBaseUrl('  http://localhost:8000  '), 'http://localhost:8000');
  });
});

describe('normalizeApiKey', () => {
  test('returns empty string for undefined / empty input', () => {
    assert.equal(normalizeApiKey(undefined), '');
    assert.equal(normalizeApiKey(''), '');
    assert.equal(normalizeApiKey('   '), '');
  });

  test('returns the key unchanged when no Bearer prefix', () => {
    assert.equal(normalizeApiKey('sk-abc'), 'sk-abc');
  });

  test('strips a leading "Bearer " prefix', () => {
    assert.equal(normalizeApiKey('Bearer sk-abc'), 'sk-abc');
    assert.equal(normalizeApiKey('bearer sk-abc'), 'sk-abc');
    assert.equal(normalizeApiKey('BEARER  sk-abc'), 'sk-abc');
  });

  test('trims surrounding whitespace before stripping', () => {
    assert.equal(normalizeApiKey('   Bearer sk-abc   '), 'sk-abc');
  });
});

describe('buildHeaders', () => {
  test('returns empty headers when no apiKey or customHeaders are set', () => {
    assert.deepEqual(buildHeaders(undefined, undefined), {});
    assert.deepEqual(buildHeaders('', {}), {});
  });

  test('sets Bearer Authorization from a normalized apiKey', () => {
    assert.deepEqual(buildHeaders('sk-abc', undefined), { Authorization: 'Bearer sk-abc' });
    assert.deepEqual(buildHeaders('Bearer sk-abc', undefined), { Authorization: 'Bearer sk-abc' });
  });

  test('merges customHeaders alongside Authorization', () => {
    const headers = buildHeaders('sk-abc', {
      'Anthropic-Version': '2024-01-01',
      'OpenAI-Organization': 'org_xyz',
    });
    assert.equal(headers['Authorization'], 'Bearer sk-abc');
    assert.equal(headers['Anthropic-Version'], '2024-01-01');
    assert.equal(headers['OpenAI-Organization'], 'org_xyz');
  });

  test('customHeaders can override Authorization for non-Bearer auth schemes', () => {
    const headers = buildHeaders('sk-abc', { Authorization: 'Token raw-token' });
    assert.equal(headers['Authorization'], 'Token raw-token');
  });

  test('drops headers with non-string values or empty names', () => {
    const headers = buildHeaders(undefined, {
      Valid: 'yes',
      '': 'no-name',
      // Simulate a JSON-loaded value that wasn't a string.
      Bogus: 42 as unknown as string,
    });
    assert.equal(headers['Valid'], 'yes');
    assert.equal(headers[''], undefined);
    assert.equal(headers['Bogus'], undefined);
  });
});

describe('extractUsage', () => {
  test('returns undefined for non-objects', () => {
    assert.equal(extractUsage(undefined), undefined);
    assert.equal(extractUsage(null), undefined);
    assert.equal(extractUsage('foo'), undefined);
    assert.equal(extractUsage(123), undefined);
  });

  test('returns undefined when no token fields are present', () => {
    // A proxy that strips usage entirely (issue #24 scenario) returns
    // either no `usage` object at all or one with all fields missing.
    assert.equal(extractUsage({}), undefined);
    assert.equal(extractUsage({ prompt_tokens_details: { cached_tokens: 0 } }), undefined);
  });

  test('normalizes a typical OpenAI usage payload', () => {
    const result = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 10 },
    });
    assert.deepEqual(result, {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 10 },
    });
  });

  test('passes through cache-write and reasoning token details when reported', () => {
    const result = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 60, cache_creation_input_tokens: 30 },
      completion_tokens_details: { reasoning_tokens: 20, accepted_prediction_tokens: 0 },
    });
    assert.deepEqual(result, {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 60, cache_creation_input_tokens: 30 },
      completion_tokens_details: { reasoning_tokens: 20 },
    });
  });

  test('falls back to top-level Anthropic-style cache fields', () => {
    const result = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cache_read_input_tokens: 70,
      cache_creation_input_tokens: 10,
    });
    assert.deepEqual(result?.prompt_tokens_details, { cached_tokens: 70, cache_creation_input_tokens: 10 });
  });

  test('prefers prompt_tokens_details over top-level cache fields', () => {
    const result = extractUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 40 },
      cache_read_input_tokens: 70,
    });
    assert.equal(result?.prompt_tokens_details?.cached_tokens, 40);
  });

  test('clamps negative cache and reasoning counts to zero', () => {
    const result = extractUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: -1 },
      completion_tokens_details: { reasoning_tokens: -3 },
    });
    assert.equal(result?.prompt_tokens_details?.cached_tokens, 0);
    assert.deepEqual(result?.completion_tokens_details, { reasoning_tokens: 0 });
  });

  test('defaults missing cached_tokens to 0', () => {
    const result = extractUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    assert.deepEqual(result?.prompt_tokens_details, { cached_tokens: 0 });
  });

  test('computes total_tokens from prompt+completion when the server omits it', () => {
    const result = extractUsage({
      prompt_tokens: 20,
      completion_tokens: 8,
    });
    assert.equal(result?.total_tokens, 28);
  });

  test('clamps sentinel negative values to 0', () => {
    // Some BYOK-style backends emit -1 for fields that aren't yet known.
    const result = extractUsage({
      prompt_tokens: -1,
      completion_tokens: -1,
      total_tokens: -1,
      prompt_tokens_details: { cached_tokens: -5 },
    });
    assert.deepEqual(result, {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
    });
  });

  test('drops non-finite numbers', () => {
    const result = extractUsage({
      prompt_tokens: Number.NaN,
      completion_tokens: 5,
      total_tokens: Number.POSITIVE_INFINITY,
    });
    assert.equal(result?.prompt_tokens, 0);
    assert.equal(result?.completion_tokens, 5);
    assert.equal(result?.total_tokens, 5);
  });
});

describe('CompletionHttpError', () => {
  test('exposes status and raw body for capability-specific handling', () => {
    const body = '{"error":{"message":"suffix is not currently supported"}}';
    const err = new CompletionHttpError('Completion failed: 400 Bad Request', 400, body);
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'CompletionHttpError');
    assert.equal(err.status, 400);
    assert.equal(err.body, body);
    assert.equal(err.message, 'Completion failed: 400 Bad Request');
  });
});

describe('streamChatCompletion reasoning field handling (issue #59)', () => {
  async function collectReasoning(lines: string[]): Promise<string[]> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => sseResponse(lines);
    try {
      const client = new GatewayClient(streamTestConfig);
      const reasoning: string[] = [];
      for await (const chunk of client.streamChatCompletion(
        { model: 'qwen3:14b', messages: [] },
        streamTestToken
      )) {
        if (chunk.reasoning_content) { reasoning.push(chunk.reasoning_content); }
      }
      return reasoning;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test('surfaces Ollama-style `reasoning` deltas as reasoning_content', async () => {
    const reasoning = await collectReasoning([
      'data: {"choices":[{"delta":{"role":"assistant","content":"","reasoning":"Okay"}}]}',
      'data: {"choices":[{"delta":{"content":"","reasoning":", thinking"}}]}',
      'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]);
    assert.deepEqual(reasoning, ['Okay', ', thinking']);
  });

  test('prefers `reasoning_content` when both fields are present', async () => {
    const reasoning = await collectReasoning([
      'data: {"choices":[{"delta":{"reasoning_content":"canonical","reasoning":"alias"}}]}',
      'data: [DONE]',
    ]);
    assert.deepEqual(reasoning, ['canonical']);
  });

  test('surfaces `reasoning` from non-streaming message payloads', async () => {
    const reasoning = await collectReasoning([
      'data: {"choices":[{"message":{"content":"done","reasoning":"thought"}}]}',
      'data: [DONE]',
    ]);
    assert.deepEqual(reasoning, ['thought']);
  });

  test('aborts the HTTP request when the consumer stops reading early', async () => {
    const originalFetch = globalThis.fetch;
    let signal: AbortSignal | undefined;
    globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"one"}}]}',
        'data: {"choices":[{"delta":{"content":"two"}}]}',
        'data: [DONE]',
      ]);
    };
    try {
      const client = new GatewayClient(streamTestConfig);
      for await (const chunk of client.streamChatCompletion({ model: 'm', messages: [] }, streamTestToken)) {
        if (chunk.content) { break; }
      }
      assert.equal(signal?.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('names the timeout that fired instead of a bare "operation was aborted"', async () => {
    const originalFetch = globalThis.fetch;
    // A real abort rejects with `signal.reason`; mirror that so the test
    // exercises the message the user actually sees.
    globalThis.fetch = (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    try {
      const client = new GatewayClient({ ...streamTestConfig, requestTimeout: 20 });
      await assert.rejects(
        async () => {
          for await (const _chunk of client.streamChatCompletion({ model: 'm', messages: [] }, streamTestToken)) {
            // unreachable
          }
        },
        /did not start responding within 20 ms \(github\.copilot\.llm-gateway\.requestTimeout\)/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('streamChatCompletion extraHeaders (session affinity)', () => {
  async function captureRequestHeaders(
    extraHeaders?: Record<string, string>
  ): Promise<Headers | undefined> {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return sseResponse(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}', 'data: [DONE]']);
    }) as typeof fetch;
    try {
      const client = new GatewayClient(streamTestConfig);
      for await (const _chunk of client.streamChatCompletion(
        { model: 'm', messages: [] },
        streamTestToken,
        extraHeaders
      )) {
        break;
      }
      return capturedHeaders;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test('merges extraHeaders into the request headers', async () => {
    const headers = await captureRequestHeaders({ 'x-litellm-session-id': 'conv-123' });
    assert.equal(headers?.get('x-litellm-session-id'), 'conv-123');
    assert.equal(headers?.get('Content-Type'), 'application/json');
  });

  test('sends no affinity header when extraHeaders is omitted', async () => {
    const headers = await captureRequestHeaders();
    assert.equal(headers?.get('x-litellm-session-id'), null);
  });
});

describe('fetchCurrentUsage', () => {
  // The client only reads connection fields; the rest of GatewayConfig is irrelevant here.
  const config = {
    serverUrl: 'http://gateway:8000/v1/',
    apiKey: 'secret',
    requestTimeout: 60000,
    customHeaders: { 'X-Team': 'core' },
  } as unknown as import('../../config/gatewayConfig').GatewayConfig;

  async function withFetch<T>(
    impl: (url: string, init: RequestInit) => Promise<Response>,
    run: () => Promise<T>
  ): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((url: string, init: RequestInit) => impl(url, init)) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test('GETs the path on the normalized base URL with auth and custom headers', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const result = await withFetch(
      async (url, init) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ remaining_tokens: 5 }), { status: 200 });
      },
      () => new GatewayClient(config).fetchCurrentUsage('/v1/usage/current')
    );
    assert.deepEqual(result, { kind: 'ok', body: { remaining_tokens: 5 } });
    assert.equal(seen[0].url, 'http://gateway:8000/v1/usage/current');
    assert.equal(seen[0].init.method, 'GET');
    const headers = seen[0].init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer secret');
    assert.equal(headers['X-Team'], 'core');
  });

  test('reports non-2xx responses by status', async () => {
    const result = await withFetch(
      async () => new Response('not found', { status: 404 }),
      () => new GatewayClient(config).fetchCurrentUsage('/v1/usage/current')
    );
    assert.deepEqual(result, { kind: 'http', status: 404 });
  });

  test('reports network failures with the underlying cause', async () => {
    const result = await withFetch(
      async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') });
      },
      () => new GatewayClient(config).fetchCurrentUsage('/v1/usage/current')
    );
    assert.deepEqual(result, { kind: 'unreachable', reason: 'fetch failed: connect ECONNREFUSED' });
  });

  test('reports a non-JSON body as unreachable rather than throwing', async () => {
    const result = await withFetch(
      async () => new Response('<html>', { status: 200 }),
      () => new GatewayClient(config).fetchCurrentUsage('/v1/usage/current')
    );
    assert.equal(result.kind, 'unreachable');
  });
});

describe('non-streaming abort reasons (issue #127)', () => {
  const config = {
    serverUrl: 'http://gateway:8000',
    apiKey: '',
    requestTimeout: 60000,
    customHeaders: {},
  } as unknown as import('../../config/gatewayConfig').GatewayConfig;

  const completionRequest = { model: 'm', prompt: 'def f(', max_tokens: 16 };

  /** A fetch that never answers and rejects the way the given impl does once aborted. */
  function hangingFetch(rejectWith: (signal: AbortSignal) => unknown): typeof fetch {
    return ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(rejectWith(signal)));
    })) as typeof fetch;
  }

  /** Cancellation token whose listeners fire when `cancel()` is called. */
  /** Cancellation token whose listeners fire on `cancel()`; counts live subscriptions. */
  function fakeToken(): {
    token: import('vscode').CancellationToken;
    cancel: () => void;
    liveSubscriptions: () => number;
  } {
    const listeners: Array<() => void> = [];
    let live = 0;
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        listeners.push(listener);
        live++;
        return { dispose: () => { live--; } };
      },
    };
    return {
      token: token as unknown as import('vscode').CancellationToken,
      cancel: () => {
        token.isCancellationRequested = true;
        listeners.forEach((listener) => listener());
      },
      liveSubscriptions: () => live,
    };
  }

  async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const undiciStyle = (signal: AbortSignal) => signal.reason;
  const plainAbortError = () => new DOMException('This operation was aborted', 'AbortError');

  for (const [label, rejectWith] of [['signal.reason', undiciStyle], ['a plain AbortError', plainAbortError]] as const) {
    test(`fetchCompletion timeout rejects with RequestTimeoutError naming the setting (fetch rejects with ${label})`, async () => {
      await withFetch(hangingFetch(rejectWith), () => assert.rejects(
        new GatewayClient(config).fetchCompletion(completionRequest, streamTestToken, 20),
        (error: unknown) => {
          assert.ok(error instanceof RequestTimeoutError);
          assert.equal(error.name, 'RequestTimeoutError');
          assert.match(error.message, /20 ms/);
          assert.match(error.message, /github\.copilot\.llm-gateway\.inlineCompletionTimeout/);
          return true;
        }
      ));
    });

    test(`fetchCompletion cancellation rejects with RequestCancelledError (fetch rejects with ${label})`, async () => {
      const { token, cancel, liveSubscriptions } = fakeToken();
      await withFetch(hangingFetch(rejectWith), async () => {
        const pending = new GatewayClient(config).fetchCompletion(completionRequest, token, 60000);
        assert.equal(liveSubscriptions(), 1);
        cancel();
        await assert.rejects(pending, (error: unknown) => {
          assert.ok(error instanceof RequestCancelledError);
          assert.equal(error.name, 'RequestCancelledError');
          return true;
        });
      });
      assert.equal(liveSubscriptions(), 0);
    });

    test(`usage probe still reports an aborted request as timed out/cancelled (fetch rejects with ${label})`, async () => {
      const { token, cancel, liveSubscriptions } = fakeToken();
      const result = await withFetch(hangingFetch(rejectWith), async () => {
        const pending = new GatewayClient(config).fetchCurrentUsage('/v1/usage/current', token);
        cancel();
        return pending;
      });
      assert.equal(liveSubscriptions(), 0);
      assert.deepEqual(result, { kind: 'unreachable', reason: 'timed out after 10000ms or cancelled' });
    });
  }

  test('real fetch surfaces RequestTimeoutError against a server that never answers', async () => {
    const http = await import('node:http');
    const server = http.createServer(() => { /* never respond */ });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as import('node:net').AddressInfo;
    try {
      await assert.rejects(
        new GatewayClient({ ...config, serverUrl: `http://127.0.0.1:${port}` })
          .fetchCompletion(completionRequest, streamTestToken, 50),
        RequestTimeoutError
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('a hard-coded budget names no setting in the timeout message', async () => {
    type FetchWithTimeout = (
      url: string,
      options: RequestInit,
      cancellationToken?: import('vscode').CancellationToken,
      timeoutMs?: number
    ) => Promise<Response>;
    const client = new GatewayClient(config);
    const fetchWithTimeout = (client as unknown as { fetchWithTimeout: FetchWithTimeout })
      .fetchWithTimeout.bind(client);
    await withFetch(hangingFetch(undiciStyle), () => assert.rejects(
      fetchWithTimeout('http://gateway:8000/api/version', { method: 'GET' }, undefined, 20),
      (error: unknown) => {
        assert.ok(error instanceof RequestTimeoutError);
        assert.equal(error.message, 'The server did not respond within 20 ms');
        return true;
      }
    ));
  });

  test('model list timeout names requestTimeout', async () => {
    await withFetch(hangingFetch(undiciStyle), () => assert.rejects(
      new GatewayClient({ ...config, requestTimeout: 20 }).fetchModels(),
      /did not respond within 20 ms \(github\.copilot\.llm-gateway\.requestTimeout\)/
    ));
  });
});
