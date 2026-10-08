import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JsonProbeResult } from '../../api/client';
import { GatewayConfig } from '../../config/gatewayConfig';
import { UsageScheduler, UsageService, refreshIntervalMs } from '../usageService';

const NOW = Date.parse('2026-09-24T12:00:00Z');

function fakeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    serverUrl: 'http://gateway:8000',
    apiKey: 'key-a',
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
    showReplyTokenUsage: false,
    sessionAffinityHeader: '',
    thinkingEffortParameter: 'reasoning_effort',
    thinkingEffortPicker: 'auto',
    usageEndpoint: '/v1/usage/current',
    usageRefreshInterval: 300,
    usageWarningPercent: 20,
    usageCriticalPercent: 0,
    loopGuardRepetition: true,
    loopGuardToolCalls: true,
    loopGuardToolNudgeAfter: 3,
    loopGuardToolBlockAfter: 5,
    replayReasoning: false,
    ...overrides,
  };
}

function payload(remaining: number, resetTime = '2026-09-25T00:00:00Z'): JsonProbeResult {
  return {
    kind: 'ok',
    body: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      daily_limit: 1000,
      remaining_tokens: remaining,
      request_count: 1,
      reset_time: resetTime,
    },
  };
}

/** Manual clock: timers only fire when the test advances time. */
class FakeScheduler implements UsageScheduler {
  current = NOW;
  private nextId = 1;
  readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + ms, callback });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  now(): number {
    return this.current;
  }
  /** Delays (ms from now) of the pending timers, soonest first. */
  pending(): number[] {
    return [...this.timers.values()].map((t) => t.at - this.current).sort((a, b) => a - b);
  }
  advance(ms: number): void {
    this.current += ms;
    for (const [id, timer] of [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.current && this.timers.has(id)) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

function setup(options: { config?: Partial<GatewayConfig>; focused?: boolean } = {}) {
  let config = fakeConfig(options.config);
  const responses: JsonProbeResult[] = [];
  const calls: string[] = [];
  const logs: string[] = [];
  let statusChanges = 0;
  let focused = options.focused ?? true;
  const pendingResolvers: Array<() => void> = [];
  let holdResponses = false;
  const scheduler = new FakeScheduler();

  const service = new UsageService({
    client: {
      fetchCurrentUsage: async (path: string) => {
        calls.push(path);
        if (holdResponses) {
          await new Promise<void>((resolve) => pendingResolvers.push(resolve));
        }
        return responses.shift() ?? payload(900);
      },
    },
    getConfig: () => config,
    log: (m) => logs.push(m),
    onStatusChanged: () => {
      statusChanges++;
    },
    isWindowFocused: () => focused,
    scheduler,
  });

  return {
    service,
    scheduler,
    calls,
    logs,
    respond: (...r: JsonProbeResult[]) => responses.push(...r),
    setConfig: (overrides: Partial<GatewayConfig>) => {
      config = fakeConfig({ ...options.config, ...overrides });
    },
    setFocused: (value: boolean) => {
      focused = value;
    },
    hold: () => {
      holdResponses = true;
    },
    release: () => {
      holdResponses = false;
      pendingResolvers.splice(0).forEach((resolve) => resolve());
    },
    statusChanges: () => statusChanges,
  };
}

/** Let queued promise continuations (the fetch's `await`) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe('refreshIntervalMs', () => {
  test('0 or invalid turns polling off; small values are floored at 30s', () => {
    assert.equal(refreshIntervalMs(0), 0);
    assert.equal(refreshIntervalMs(-5), 0);
    assert.equal(refreshIntervalMs(Number.NaN), 0);
    assert.equal(refreshIntervalMs(1), 30_000);
    assert.equal(refreshIntervalMs(300), 300_000);
    assert.equal(refreshIntervalMs(10_000_000), 86_400_000);
  });
});

describe('UsageService', () => {
  test('starts unknown, or disabled when the endpoint setting is empty', () => {
    assert.equal(setup().service.getState().kind, 'unknown');
    assert.equal(setup({ config: { usageEndpoint: '' } }).service.getState().kind, 'disabled');
  });

  test('a successful fetch stores the parsed sample and notifies', async () => {
    const t = setup();
    t.respond(payload(750));
    await t.service.refresh();
    const state = t.service.getState();
    assert.equal(state.kind, 'ok');
    assert.equal(state.kind === 'ok' && state.usage.remainingTokens, 750);
    assert.equal(state.kind === 'ok' && state.fetchedAt, NOW);
    assert.deepEqual(t.calls, ['/v1/usage/current']);
    assert.ok(t.statusChanges() > 0);
  });

  test('concurrent refreshes share one request', async () => {
    const t = setup();
    t.hold();
    const a = t.service.refresh();
    const b = t.service.refresh();
    t.release();
    await Promise.all([a, b]);
    assert.equal(t.calls.length, 1);
  });

  test('404 marks the endpoint unsupported and stops polling', async () => {
    const t = setup();
    t.respond({ kind: 'http', status: 404 });
    await t.service.refresh();
    assert.deepEqual(t.service.getState(), { kind: 'unsupported', status: 404 });
    assert.deepEqual(t.scheduler.pending(), []);
    t.service.refreshSoon();
    assert.deepEqual(t.scheduler.pending(), []);
    assert.equal(t.logs.length, 1);
  });

  test('an explicit refresh re-checks an unsupported endpoint', async () => {
    const t = setup();
    t.respond({ kind: 'http', status: 404 }, payload(500));
    await t.service.refresh();
    await t.service.refresh();
    assert.equal(t.service.getState().kind, 'ok');
  });

  test('a failure after success keeps the last sample and logs once per message', async () => {
    const t = setup();
    t.respond(
      payload(600),
      { kind: 'unreachable', reason: 'ECONNREFUSED' },
      { kind: 'unreachable', reason: 'ECONNREFUSED' }
    );
    await t.service.refresh();
    await t.service.refresh();
    await t.service.refresh();
    const state = t.service.getState();
    assert.equal(state.kind, 'error');
    if (state.kind === 'error') {
      assert.equal(state.message, 'ECONNREFUSED');
      assert.equal(state.last?.usage.remainingTokens, 600);
    }
    assert.equal(t.logs.filter((l) => l.includes('ECONNREFUSED')).length, 1);
  });

  test('401/403 read as an authorization problem', async () => {
    const t = setup();
    t.respond({ kind: 'http', status: 401 });
    await t.service.refresh();
    assert.deepEqual(t.service.getState(), { kind: 'error', message: 'not authorized (HTTP 401)' });
  });

  test('an unparseable body is an error, not an empty quota', async () => {
    const t = setup();
    t.respond({ kind: 'ok', body: { hello: 'world' } });
    await t.service.refresh();
    assert.equal(t.service.getState().kind, 'error');
  });

  test('a full-URL endpoint is rejected without any request', async () => {
    const t = setup({ config: { usageEndpoint: 'https://elsewhere.example/usage' } });
    await t.service.refresh();
    assert.equal(t.calls.length, 0);
    assert.equal(t.service.getState().kind, 'error');
  });

  test('polls on the configured interval', async () => {
    const t = setup();
    await t.service.refresh();
    assert.deepEqual(t.scheduler.pending(), [300_000]);
    t.scheduler.advance(300_000);
    await flush();
    assert.equal(t.calls.length, 2);
  });

  test('schedules a fetch just after the quota resets when that comes first', async () => {
    const t = setup({ config: { usageRefreshInterval: 0 } });
    t.respond(payload(0, '2026-09-24T12:02:00Z'));
    await t.service.refresh();
    assert.deepEqual(t.scheduler.pending(), [125_000]);
  });

  test('refreshSoon waits for the gateway to book the request and collapses bursts', async () => {
    const t = setup({ config: { usageRefreshInterval: 0 } });
    t.respond(payload(0, 'not-a-date'));
    await t.service.refresh();
    t.service.refreshSoon();
    t.service.refreshSoon();
    t.service.refreshSoon();
    assert.deepEqual(t.scheduler.pending(), [1500]);
    t.scheduler.advance(1500);
    await flush();
    assert.equal(t.calls.length, 2);
  });

  test('refreshSoon does nothing before the first explicit refresh', () => {
    const t = setup();
    t.service.refreshSoon();
    assert.deepEqual(t.scheduler.pending(), []);
  });

  test('skips polls while unfocused and catches up on focus', async () => {
    const t = setup();
    await t.service.refresh();
    t.setFocused(false);
    t.scheduler.advance(300_000);
    await flush();
    assert.equal(t.calls.length, 1);
    t.setFocused(true);
    t.service.onWindowFocusChanged(true);
    await flush();
    assert.equal(t.calls.length, 2);
  });

  test('an unrelated config change keeps the numbers', async () => {
    const t = setup();
    await t.service.refresh();
    t.setConfig({ agentTemperature: 0.7 });
    t.service.onConfigChanged();
    assert.equal(t.service.getState().kind, 'ok');
    assert.equal(t.calls.length, 1);
  });

  test('a new server or key drops the old numbers and re-fetches', async () => {
    const t = setup();
    await t.service.refresh();
    t.setConfig({ apiKey: 'key-b' });
    t.service.onConfigChanged();
    assert.equal(t.service.getState().kind, 'unknown');
    await flush();
    assert.equal(t.calls.length, 2);
    assert.equal(t.service.getState().kind, 'ok');
  });

  test('a result for the previous server is discarded', async () => {
    const t = setup();
    t.hold();
    t.respond(payload(111), payload(222));
    const first = t.service.refresh();
    t.setConfig({ serverUrl: 'http://other:8000' });
    t.service.onConfigChanged();
    t.release();
    await first;
    await flush();
    const state = t.service.getState();
    assert.equal(state.kind === 'ok' && state.usage.remainingTokens, 222);
  });

  test('clearing the endpoint disables the feature and stops timers', async () => {
    const t = setup();
    await t.service.refresh();
    t.setConfig({ usageEndpoint: '' });
    t.service.onConfigChanged();
    await flush();
    assert.equal(t.service.getState().kind, 'disabled');
    assert.deepEqual(t.scheduler.pending(), []);
  });

  test('dispose cancels every timer', async () => {
    const t = setup();
    await t.service.refresh();
    t.service.refreshSoon();
    t.service.dispose();
    assert.deepEqual(t.scheduler.pending(), []);
  });
});
