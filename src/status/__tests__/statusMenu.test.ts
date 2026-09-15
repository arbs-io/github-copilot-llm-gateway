import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_MENU_COMMANDS,
  STATUS_MENU_MODEL_LIST_MAX,
  StatusMenuItem,
  buildStatusMenu,
  renderTextMeter,
} from '../statusMenu';
import { StatusSnapshot } from '../statusSnapshot';
import { makeStatusSnapshot } from './snapshotFixture';

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
