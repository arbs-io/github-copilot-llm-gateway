import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CancellationToken } from 'vscode';
import {
  CompletionHttpError,
  GatewayClient,
  RequestCancelledError,
  RequestTimeoutError,
} from '../../api/client';
import { OpenAICompletionRequest, OpenAICompletionResponse } from '../../api/types';
import { GatewayConfig } from '../../config/gatewayConfig';
import { InlineCompletionService } from '../inlineCompletionService';

function fakeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  // The service only reads the inline-completion fields and verboseLogging.
  return {
    verboseLogging: false,
    enableInlineCompletion: true,
    inlineCompletionModel: 'azure-gov.gpt-5.6-luna',
    inlineCompletionMaxTokens: 256,
    inlineCompletionDebounce: 300,
    inlineCompletionTimeout: 3000,
    inlineCompletionMaxPrefixChars: 4000,
    inlineCompletionMaxSuffixChars: 1000,
    ...overrides,
  } as unknown as GatewayConfig;
}

function fakeToken(cancelled = false): CancellationToken {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  } as unknown as CancellationToken;
}

type FetchImpl = (request: OpenAICompletionRequest) => Promise<OpenAICompletionResponse>;

function setup(fetchImpl: FetchImpl, config: GatewayConfig = fakeConfig()) {
  const logs: string[] = [];
  const requests: OpenAICompletionRequest[] = [];
  const client = {
    fetchCompletion: (request: OpenAICompletionRequest) => {
      requests.push(request);
      return fetchImpl(request);
    },
  } as unknown as GatewayClient;
  const service = new InlineCompletionService({
    client,
    getConfig: () => config,
    getDefaultModelId: () => undefined,
    log: (message) => logs.push(message),
  });
  return { service, logs, requests };
}

const textResponse = (text: string, finishReason = 'stop'): OpenAICompletionResponse => ({
  choices: [{ text, index: 0, finish_reason: finishReason }],
});

const timeoutError = () =>
  new RequestTimeoutError(
    'The server did not respond within 3000 ms (github.copilot.llm-gateway.inlineCompletionTimeout)'
  );

describe('InlineCompletionService cancellation (issue #127)', () => {
  test('skips the request when the token is already cancelled', async () => {
    const { service, logs, requests } = setup(async () => textResponse('x'));
    const result = await service.provideCompletion('def f(', ')', fakeToken(true));
    assert.equal(result, undefined);
    assert.equal(requests.length, 0);
    assert.deepEqual(logs, []);
  });

  test('a RequestCancelledError yields undefined without logging a failure', async () => {
    const { service, logs } = setup(async () => {
      throw new RequestCancelledError('Request cancelled');
    });
    assert.equal(await service.provideCompletion('def f(', ')', fakeToken()), undefined);
    assert.deepEqual(logs, []);
  });

  test('any error after the token was cancelled is treated as a cancellation', async () => {
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    };
    const { service, logs } = setup(async () => {
      token.isCancellationRequested = true;
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    assert.equal(
      await service.provideCompletion('def f(', ')', token as unknown as CancellationToken),
      undefined
    );
    assert.deepEqual(logs, []);
  });

  test('verbose logging notes the cancellation', async () => {
    const { service, logs } = setup(async () => {
      throw new RequestCancelledError('Request cancelled');
    }, fakeConfig({ verboseLogging: true }));
    await service.provideCompletion('def f(', ')', fakeToken());
    assert.ok(logs.includes('Inline completion cancelled (superseded by newer request)'));
    assert.ok(!logs.some((line) => line.includes('failed')));
  });

  test('verbose cancellation line keeps an unrelated underlying error', async () => {
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    };
    const { service, logs } = setup(async () => {
      token.isCancellationRequested = true;
      throw new Error('socket hang up');
    }, fakeConfig({ verboseLogging: true }));
    await service.provideCompletion('def f(', ')', token as unknown as CancellationToken);
    assert.ok(
      logs.includes('Inline completion cancelled (superseded by newer request): socket hang up')
    );
  });
});

describe('InlineCompletionService timeouts (issue #127)', () => {
  test('logs actionable advice once, then stays quiet without verbose logging', async () => {
    const { service, logs } = setup(async () => {
      throw timeoutError();
    });
    await service.provideCompletion('def f(', ')', fakeToken());
    await service.provideCompletion('def f(', ')', fakeToken());
    assert.equal(logs.length, 1);
    assert.match(logs[0], /timed out after 3000 ms for model "azure-gov\.gpt-5\.6-luna"/);
    assert.match(logs[0], /inlineCompletionTimeout/);
    assert.match(logs[0], /inlineCompletionModel/);
    assert.ok(!logs[0].includes('This operation was aborted'));
  });

  test('re-arms the advice after a config reload', async () => {
    const { service, logs } = setup(async () => {
      throw timeoutError();
    });
    await service.provideCompletion('def f(', ')', fakeToken());
    service.resetServerState();
    await service.provideCompletion('def f(', ')', fakeToken());
    assert.equal(logs.length, 2);
  });

  test('verbose logging reports every further timeout', async () => {
    const { service, logs } = setup(async () => {
      throw timeoutError();
    }, fakeConfig({ verboseLogging: true }));
    await service.provideCompletion('def f(', ')', fakeToken());
    await service.provideCompletion('def f(', ')', fakeToken());
    const timeouts = logs.filter((line) => line.includes('timed out after 3000 ms'));
    assert.equal(timeouts.length, 2);
  });

  test('other errors are still logged as failures', async () => {
    const { service, logs } = setup(async () => {
      throw new Error('fetch failed');
    });
    await service.provideCompletion('def f(', ')', fakeToken());
    assert.deepEqual(logs, ['Inline completion failed: fetch failed']);
  });
});

describe('InlineCompletionService verbose logging (issue #127)', () => {
  test('logs the request envelope and the outcome', async () => {
    const { service, logs } = setup(
      async () => textResponse('return 1'),
      fakeConfig({ verboseLogging: true })
    );
    const result = await service.provideCompletion('def f(', '):\n', fakeToken());
    assert.equal(result, 'return 1');
    assert.equal(logs.length, 2);
    assert.match(logs[0], /model=azure-gov\.gpt-5\.6-luna/);
    assert.match(logs[0], /prompt=6 chars/);
    assert.match(logs[0], /suffix=3 chars/);
    assert.match(logs[0], /max_tokens=256/);
    assert.match(logs[0], /timeout=3000 ms/);
    assert.match(logs[1], /^Inline completion response: 8 chars in \d+ ms$/);
  });

  test('explains an empty completion that ran out of max_tokens', async () => {
    const { service, logs } = setup(
      async () => textResponse('', 'length'),
      fakeConfig({ verboseLogging: true })
    );
    assert.equal(await service.provideCompletion('def f(', ')', fakeToken()), undefined);
    const outcome = logs[logs.length - 1];
    assert.match(outcome, /empty text in \d+ ms \(finish_reason=length\)/);
    assert.match(outcome, /reasoning/);
  });

  test('logs nothing for a successful completion without verbose logging', async () => {
    const { service, logs } = setup(async () => textResponse('return 1'));
    assert.equal(await service.provideCompletion('def f(', ')', fakeToken()), 'return 1');
    assert.deepEqual(logs, []);
  });
});

describe('InlineCompletionService suffix fallback', () => {
  test('retries prefix-only after the server rejects suffix, and stays prefix-only', async () => {
    const { service, logs, requests } = setup(async (request) => {
      if (request.suffix !== undefined) {
        throw new CompletionHttpError(
          'Completion failed: 400',
          400,
          'Unrecognized request argument supplied: suffix'
        );
      }
      return textResponse('x + 1');
    });
    assert.equal(await service.provideCompletion('return ', '\n}', fakeToken()), 'x + 1');
    assert.equal(await service.provideCompletion('return ', '\n}', fakeToken()), 'x + 1');
    assert.deepEqual(requests.map((request) => request.suffix), ['\n}', undefined, undefined]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /Falling back to prefix-only/);
  });
});
