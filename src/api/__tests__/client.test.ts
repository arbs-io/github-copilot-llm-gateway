import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompletionHttpError,
  GatewayClient,
  normalizeBaseUrl,
  normalizeApiKey,
  buildHeaders,
  extractUsage,
} from '../client';

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

  test('rejects injected names/values and transport-controlled headers', () => {
    const customHeaders = {
      'X-Safe': 'allowed',
      'Bad Header': 'value',
      'X-Injected': 'value\r\nAuthorization: stolen',
      Host: 'attacker.example',
      'Content-Length': '1',
      'Transfer-Encoding': 'chunked',
      constructor: 'pollute',
      prototype: 'pollute',
    };
    Object.defineProperty(customHeaders, '__proto__', {
      enumerable: true,
      value: 'pollute',
    });
    const headers = buildHeaders(undefined, customHeaders);

    assert.deepEqual(headers, { 'X-Safe': 'allowed' });
    assert.equal(({} as { pollute?: string }).pollute, undefined);
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
  const config = {
    serverUrl: 'http://localhost:11434',
    requestTimeout: 5000,
    streamIdleTimeout: 5000,
    defaultMaxTokens: 4096,
    defaultMaxOutputTokens: 4096,
    maxAgentInputTokens: 4096,
    enableImageInput: false,
    enableToolCalling: true,
    parallelToolCalling: false,
    agentTemperature: 0,
    operatingProfile: 'grounded' as const,
    pinnedTools: [],
    verboseDiagnostics: false,
    maxToolsPerRequest: 32,
    maxToolSchemaTokens: 8192,
    maxToolResultCharacters: 4000,
    maxConsecutiveToolCalls: 16,
    maxRepeatedToolCallCount: 4,
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
  };

  const token = {
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

  async function collectReasoning(lines: string[]): Promise<string[]> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => sseResponse(lines);
    try {
      const client = new GatewayClient(config);
      const reasoning: string[] = [];
      for await (const chunk of client.streamChatCompletion(
        { model: 'qwen3:14b', messages: [] },
        token
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

  test('accepts raw Ollama NDJSON and done=true as a terminal signal', async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    globalThis.fetch = async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"response":"answer","done":true}'));
          controller.close();
        },
      }),
      { status: 200 }
    );

    try {
      const client = new GatewayClient(config);
      const content: string[] = [];
      for await (const chunk of client.streamChatCompletion(
        { model: 'qwen3:14b', messages: [] },
        token
      )) {
        content.push(chunk.content);
      }
      assert.equal(content.join(''), 'answer');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('surfaces semantic errors delivered inside an HTTP 200 stream', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => sseResponse([
      'data: {"error":{"message":"grammar rejected output"}}',
    ]);

    try {
      const client = new GatewayClient(config);
      await assert.rejects(
        async () => {
          for await (const _chunk of client.streamChatCompletion(
            { model: 'qwen3:14b', messages: [] },
            token
          )) {
            // Consume the stream.
          }
        },
        /grammar rejected output/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('sanitizes server-controlled semantic error text', async () => {
    const originalFetch = globalThis.fetch;
    const sentinelValue = 'sentinel-credential-value';
    globalThis.fetch = async () => sseResponse([
      `data: {"error":{"message":"Authorization: Bearer ${sentinelValue}\\nforbidden"}}`,
    ]);

    try {
      const client = new GatewayClient(config);
      await assert.rejects(
        async () => {
          for await (const _chunk of client.streamChatCompletion(
            { model: 'qwen3:14b', messages: [] },
            token
          )) {
            // Consume the stream.
          }
        },
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes('[redacted]') &&
          !error.message.includes(sentinelValue) &&
          !error.message.includes('\n')
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reports visible output followed by EOF without a terminal signal as partial', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"partial"}}]}',
    ]);

    try {
      const client = new GatewayClient(config);
      const content: string[] = [];
      await assert.rejects(
        async () => {
          for await (const chunk of client.streamChatCompletion(
            { model: 'qwen3:14b', messages: [] },
            token
          )) {
            content.push(chunk.content);
          }
        },
        (error: unknown) =>
          error instanceof Error &&
          error.name === 'GatewayPartialStreamError' &&
          error.message.includes('terminal finish signal')
      );
      assert.equal(content.join(''), 'partial');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('discards an incomplete tool call when EOF arrives without a terminal signal', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"partial"}}]}}]}',
    ]);

    try {
      const client = new GatewayClient(config);
      let emittedToolCalls = 0;
      await assert.rejects(
        async () => {
          for await (const chunk of client.streamChatCompletion(
            { model: 'qwen3:14b', messages: [] },
            token
          )) {
            emittedToolCalls += chunk.finished_tool_calls.length;
          }
        },
        /Pending output was discarded/
      );
      assert.equal(emittedToolCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('releases a pending tool call only after the done sentinel', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search","arguments":"{\\"q\\":\\"hi\\"}"}}]}}]}',
      'data: [DONE]',
    ]);

    try {
      const client = new GatewayClient(config);
      const toolCalls = [];
      for await (const chunk of client.streamChatCompletion(
        { model: 'qwen3:14b', messages: [] },
        token
      )) {
        toolCalls.push(...chunk.finished_tool_calls);
      }
      assert.deepEqual(toolCalls, [{
        id: 'c1',
        name: 'search',
        arguments: '{"q":"hi"}',
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fails closed on malformed stream data without logging the payload', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => sseResponse(['data: sentinel-secret-not-json']);
    const logs: string[] = [];

    try {
      const client = new GatewayClient(config, (message) => logs.push(message));
      await assert.rejects(
        async () => {
          for await (const _chunk of client.streamChatCompletion(
            { model: 'qwen3:14b', messages: [] },
            token
          )) {
            // Consume the stream.
          }
        },
        /malformed streamed JSON/
      );
      assert.equal(logs.some((line) => line.includes('sentinel-secret')), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('aborts a stalled response body using the distinct stream idle timeout', async () => {
    const originalFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const idleConfig = { ...config, requestTimeout: 1000, streamIdleTimeout: 20 };
    globalThis.fetch = async (_input, init) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(
              'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            ));
            signal?.addEventListener('abort', () => {
              controller.error(new DOMException('aborted', 'AbortError'));
            });
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    };

    try {
      const client = new GatewayClient(idleConfig);
      await assert.rejects(
        async () => {
          for await (const _chunk of client.streamChatCompletion(
            { model: 'qwen3:14b', messages: [] },
            token
          )) {
            // Consume until the idle timeout aborts the body.
          }
        },
        (error: unknown) => error instanceof Error && error.name === 'GatewayPartialStreamError'
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('keeps the timeout active while consuming a non-stream response body', {
    timeout: 1000,
  }, async () => {
    const originalFetch = globalThis.fetch;
    const timeoutConfig = { ...config, requestTimeout: 20 };
    const encoder = new TextEncoder();
    globalThis.fetch = async (_input, init) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"data":'));
          signal?.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'));
          });
        },
      }), { status: 200 });
    };

    try {
      const client = new GatewayClient(timeoutConfig);
      await assert.rejects(() => client.fetchModels(token));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('bounds and redacts HTTP error bodies retained for completion fallback', async () => {
    const originalFetch = globalThis.fetch;
    const sentinelValue = 'sentinel-http-value';
    globalThis.fetch = async () => new Response(
      `Authorization: Bearer ${sentinelValue}\r\n${'x'.repeat(70_000)}`,
      { status: 400, statusText: 'Bad Request' }
    );

    try {
      const client = new GatewayClient(config);
      await assert.rejects(
        () => client.fetchCompletion(
          { model: 'qwen3:14b', prompt: 'x', max_tokens: 1 },
          token,
          1000
        ),
        (error: unknown) =>
          error instanceof CompletionHttpError &&
          error.body.length <= 1_020 &&
          error.body.includes('[redacted]') &&
          !error.body.includes(sentinelValue) &&
          !error.message.includes(sentinelValue)
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
