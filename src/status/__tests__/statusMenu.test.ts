import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFRESH_USAGE_COMMAND,
  STATUS_MENU_COMMANDS,
  STATUS_MENU_MODEL_LIST_MAX,
  StatusMenuItem,
  buildStatusMenu,
  renderTextMeter,
} from '../statusMenu';
import { StatusSnapshot } from '../statusSnapshot';
import { makeStatusSnapshot } from './snapshotFixture';
import { DEFAULT_USAGE_THRESHOLDS, DailyUsageState } from '../dailyUsage';

const FIXED_NOW = 1_700_000_000_000;

function makeSnapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return makeStatusSnapshot(FIXED_NOW, overrides);
}

function rows(items: readonly StatusMenuItem[]): StatusMenuItem[] {
  return items.filter((item) => !item.separator);
}

function find(items: readonly StatusMenuItem[], labelPart: string): StatusMenuItem {
  const item = items.find((candidate) => candidate.label.includes(labelPart));
  assert.ok(item, `expected a menu item containing "${labelPart}"`);
  return item;
}

describe('buildStatusMenu sections', () => {
  test('lays out the sections in the same order as the hover popup', () => {
    const headers = buildStatusMenu(makeSnapshot())
      .filter((item) => item.separator)
      .map((item) => item.label);
    assert.deepEqual(headers, ['localhost:8000', 'Session', 'Models (1)', 'Features', 'Actions']);
  });

  test('omits the models section when no models are known', () => {
    const headers = buildStatusMenu(makeSnapshot({ models: [] }))
      .filter((item) => item.separator)
      .map((item) => item.label);
    assert.ok(!headers.some((h) => h.startsWith('Models')));
  });

  test('falls back to a generic header when the host is empty', () => {
    const first = buildStatusMenu(makeSnapshot({ host: '' }))[0];
    assert.equal(first.label, 'LLM Gateway');
  });
});

describe('buildStatusMenu connection row', () => {
  test('connected state refreshes on select and shows the last refresh', () => {
    const item = find(buildStatusMenu(makeSnapshot()), 'Connected');
    assert.equal(item.description, 'Last refresh 2m ago');
    assert.deepEqual(item.action, { kind: 'command', command: STATUS_MENU_COMMANDS.Refresh });
  });

  test('error state shows the message and tests the connection on select', () => {
    const item = find(
      buildStatusMenu(
        makeSnapshot({ connection: { state: 'error', errorMessage: 'ECONNREFUSED' } })
      ),
      'Disconnected'
    );
    assert.equal(item.detail, 'ECONNREFUSED');
    assert.equal(item.description, 'Last success 2m ago');
    assert.deepEqual(item.action, { kind: 'command', command: STATUS_MENU_COMMANDS.TestConnection });
  });

  test('empty model list is called out', () => {
    const item = find(buildStatusMenu(makeSnapshot({ connection: { state: 'noModels' } })), 'no models');
    assert.equal(item.description, 'Server returned an empty list');
  });
});

describe('buildStatusMenu session rows', () => {
  test('reports no requests on a fresh session', () => {
    const item = find(buildStatusMenu(makeSnapshot()), 'Session usage');
    assert.equal(item.description, 'No requests yet');
    assert.equal(item.action.kind, 'none');
  });

  test('sums totals once requests have completed', () => {
    const item = find(
      buildStatusMenu(
        makeSnapshot({
          sessionStats: {
            requestCount: 3,
            promptTokens: 12_000,
            completionTokens: 800,
            totalTokens: 12_800,
            cachedTokens: 0,
            requestsWithUsage: 3,
          },
        })
      ),
      'Session usage'
    );
    assert.equal(item.description, '3 requests · 13k tokens (12k in / 800 out)');
  });

  test('last request shows a context meter when the model context is known', () => {
    const item = find(
      buildStatusMenu(
        makeSnapshot({
          lastRequest: {
            modelId: 'qwen/Qwen3-8B',
            modelName: 'Qwen3-8B',
            completedAt: FIXED_NOW - 30_000,
            usage: { prompt: 60_000, completion: 5_536, total: 65_536 },
          },
        })
      ),
      'Last request'
    );
    assert.equal(item.description, 'Qwen3-8B · 30s ago · 66k tokens');
    assert.equal(item.detail, `${renderTextMeter(0.5)}  50% of 131k context`);
  });

  test('last request and session totals mention cached tokens when reported', () => {
    const snapshot = makeSnapshot({
      lastRequest: {
        modelId: 'qwen/Qwen3-8B',
        modelName: 'Qwen3-8B',
        completedAt: FIXED_NOW - 30_000,
        usage: { prompt: 60_000, completion: 5_536, total: 65_536, cached: 48_000 },
      },
      sessionStats: {
        requestCount: 1,
        promptTokens: 60_000,
        completionTokens: 5_536,
        totalTokens: 65_536,
        cachedTokens: 48_000,
        requestsWithUsage: 1,
      },
    });
    const menu = buildStatusMenu(snapshot);
    assert.equal(find(menu, 'Last request').description, 'Qwen3-8B · 30s ago · 66k tokens · 48k cached');
    assert.equal(find(menu, 'Session usage').description, '1 request · 66k tokens (60k in, 48k cached / 5.5k out)');
  });

  test('last request without usage has no meter', () => {
    const item = find(
      buildStatusMenu(
        makeSnapshot({
          lastRequest: { modelId: 'x', modelName: 'x', completedAt: FIXED_NOW - 1000 },
        })
      ),
      'Last request'
    );
    assert.equal(item.detail, undefined);
  });
});

describe('buildStatusMenu model rows', () => {
  test('each model row opens thinking effort for that model', () => {
    const item = find(buildStatusMenu(makeSnapshot()), 'Qwen3-8B');
    assert.equal(item.description, '131k ctx · tools · vision');
    assert.equal(item.detail, 'qwen/Qwen3-8B');
    assert.deepEqual(item.action, { kind: 'thinkingEffort', modelId: 'qwen/Qwen3-8B' });
  });

  test('collapses a long model list', () => {
    const models = Array.from({ length: STATUS_MENU_MODEL_LIST_MAX + 3 }, (_, i) => ({
      id: `m${i}`,
      name: `m${i}`,
      contextLabel: '',
      capabilityLabels: [],
    }));
    const items = buildStatusMenu(makeSnapshot({ models }));
    const modelRows = rows(items).filter((item) => item.action.kind === 'thinkingEffort' && item.action.modelId);
    assert.equal(modelRows.length, STATUS_MENU_MODEL_LIST_MAX);
    assert.ok(find(items, 'and 3 more'));
  });
});

describe('buildStatusMenu feature toggles', () => {
  test('renders a check for enabled features and a blank for disabled ones', () => {
    const items = buildStatusMenu(makeSnapshot());
    const tools = find(items, 'Tool calling');
    assert.ok(tools.label.startsWith('$(check)'));
    assert.equal(tools.description, 'Enabled');
    assert.deepEqual(tools.action, { kind: 'toggle', setting: 'enableToolCalling', enabled: true });

    const inline = find(items, 'Inline suggestions');
    assert.ok(inline.label.startsWith('$(blank)'));
    assert.equal(inline.description, 'Disabled · first model');
    assert.deepEqual(inline.action, { kind: 'toggle', setting: 'enableInlineCompletion', enabled: false });
  });

  test('names the configured inline completion model', () => {
    const snapshot = makeSnapshot();
    const inline = find(
      buildStatusMenu(
        makeSnapshot({
          features: { ...snapshot.features, inlineCompletion: true, inlineCompletionModel: 'coder-1.5b' },
        })
      ),
      'Inline suggestions'
    );
    assert.equal(inline.description, 'Enabled · coder-1.5b');
  });

  test('offers a model-agnostic thinking effort entry', () => {
    const item = find(buildStatusMenu(makeSnapshot()), 'Thinking effort');
    assert.deepEqual(item.action, { kind: 'thinkingEffort' });
  });
});

describe('buildStatusMenu actions', () => {
  test('exposes every command the hover footer offers', () => {
    const commands = rows(buildStatusMenu(makeSnapshot()))
      .map((item) => item.action)
      .filter((action): action is Extract<typeof action, { kind: 'command' }> => action.kind === 'command')
      .map((action) => action.command);
    for (const id of Object.values(STATUS_MENU_COMMANDS)) {
      assert.ok(commands.includes(id), `missing ${id}`);
    }
  });

  test('open settings is scoped to the extension', () => {
    const item = find(buildStatusMenu(makeSnapshot()), 'Open settings');
    assert.deepEqual(item.action, {
      kind: 'command',
      command: STATUS_MENU_COMMANDS.OpenSettings,
      args: ['github.copilot.llm-gateway'],
    });
  });
});

describe('renderTextMeter', () => {
  test('is fixed width and clamps out-of-range ratios', () => {
    assert.equal(renderTextMeter(0, 10), '░░░░░░░░░░');
    assert.equal(renderTextMeter(1, 10), '██████████');
    assert.equal(renderTextMeter(2, 10), '██████████');
    assert.equal(renderTextMeter(-1, 10), '░░░░░░░░░░');
  });

  test('shows at least one cell for tiny usage', () => {
    assert.equal(renderTextMeter(0.001, 10), '█░░░░░░░░░');
  });
});

describe('buildStatusMenu daily usage rows', () => {
  const usage = {
    inputTokens: 401_200,
    outputTokens: 186_500,
    totalTokens: 587_700,
    dailyLimit: 1_000_000,
    remainingTokens: 412_300,
    requestCount: 42,
    resetAt: FIXED_NOW + (9 * 60 + 12) * 60_000,
  };
  const sample = { usage, fetchedAt: FIXED_NOW - 60_000 };

  function menuWith(state: DailyUsageState): StatusMenuItem[] {
    return buildStatusMenu(
      makeSnapshot({ dailyUsage: { state, thresholds: DEFAULT_USAGE_THRESHOLDS } })
    );
  }

  test('adds a Daily usage section right after the connection row', () => {
    const headers = menuWith({ kind: 'ok', ...sample })
      .filter((item) => item.separator)
      .map((item) => item.label);
    assert.deepEqual(headers, ['localhost:8000', 'Daily usage', 'Session', 'Models (1)', 'Features', 'Actions']);
  });

  test('leads with the remaining tokens, limit, reset and a meter', () => {
    const row = find(menuWith({ kind: 'ok', ...sample }), 'tokens left');
    assert.equal(row.label, '$(pulse) 412,300 tokens left');
    assert.equal(row.description, 'of 1.0M · resets in 9h 12m');
    assert.ok(row.detail?.endsWith('59% used'));
    assert.deepEqual(row.action, { kind: 'command', command: REFRESH_USAGE_COMMAND });
  });

  test('breaks down the tokens and requests used today', () => {
    const row = find(menuWith({ kind: 'ok', ...sample }), 'Used today');
    assert.equal(row.description, '588k tokens (401k in / 187k out) · 42 requests');
    assert.equal(row.detail, 'as of 1m ago');
  });

  test('flags a low or exhausted quota', () => {
    const low = menuWith({ kind: 'ok', ...sample, usage: { ...usage, remainingTokens: 50_000 } });
    assert.ok(find(low, 'tokens left').label.startsWith('$(warning)'));
    const out = menuWith({ kind: 'ok', ...sample, usage: { ...usage, remainingTokens: 0 } });
    assert.equal(find(out, 'limit reached').label, '$(error) Daily limit reached');
  });

  test('marks stale numbers after a failed refresh', () => {
    const row = find(menuWith({ kind: 'error', message: 'HTTP 502', last: sample }), 'Used today');
    assert.ok(row.detail?.includes('Refresh failed: HTTP 502'));
  });

  test('offers a retry when nothing was ever fetched', () => {
    const row = find(menuWith({ kind: 'error', message: 'not authorized (HTTP 401)' }), 'Usage unavailable');
    assert.equal(row.detail, 'not authorized (HTTP 401)');
    assert.deepEqual(row.action, { kind: 'command', command: REFRESH_USAGE_COMMAND });
  });

  test('is omitted for servers without the endpoint', () => {
    const headers = menuWith({ kind: 'unsupported', status: 404 })
      .filter((item) => item.separator)
      .map((item) => item.label);
    assert.ok(!headers.includes('Daily usage'));
  });
});
