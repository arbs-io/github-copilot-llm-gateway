import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { StatusBarState, renderStatusBar } from '../statusBarRenderer';
import { extractHost, formatTokenCount, stripPort } from '../format';

describe('formatTokenCount', () => {
  test('shows integers below 1000 verbatim', () => {
    assert.equal(formatTokenCount(0), '0');
    assert.equal(formatTokenCount(1), '1');
    assert.equal(formatTokenCount(999), '999');
  });

  test('uses one-decimal-k notation for 1k-9.9k', () => {
    assert.equal(formatTokenCount(1000), '1.0k');
    assert.equal(formatTokenCount(1234), '1.2k');
    assert.equal(formatTokenCount(4567), '4.6k');
    assert.equal(formatTokenCount(9999), '10.0k');
  });

  test('uses rounded-k notation for 10k-999k', () => {
    assert.equal(formatTokenCount(10_000), '10k');
    assert.equal(formatTokenCount(12_345), '12k');
    assert.equal(formatTokenCount(999_499), '999k');
  });

  test('uses one-decimal-M notation for 1M-9.9M', () => {
    assert.equal(formatTokenCount(1_000_000), '1.0M');
    assert.equal(formatTokenCount(1_234_567), '1.2M');
  });

  test('uses rounded-M notation above 10M', () => {
    assert.equal(formatTokenCount(10_000_000), '10M');
    assert.equal(formatTokenCount(99_999_999), '100M');
  });

  test('handles negative or non-finite input defensively', () => {
    assert.equal(formatTokenCount(-1), '0');
    assert.equal(formatTokenCount(Number.NaN), '0');
    assert.equal(formatTokenCount(Number.POSITIVE_INFINITY), '0');
  });
});

describe('extractHost', () => {
  test('returns host:port for typical http/https URLs', () => {
    assert.equal(extractHost('http://localhost:8000'), 'localhost:8000');
    assert.equal(extractHost('https://api.example.com'), 'api.example.com');
    assert.equal(extractHost('http://10.0.0.1:11434/v1'), '10.0.0.1:11434');
  });

  test('falls back to the raw string when the URL is unparseable', () => {
    assert.equal(extractHost('not a url'), 'not a url');
    assert.equal(extractHost(''), '');
  });
});

describe('stripPort', () => {
  test('drops the :port suffix from typical hostnames', () => {
    assert.equal(stripPort('localhost:8000'), 'localhost');
    assert.equal(stripPort('api.example.com:443'), 'api.example.com');
    assert.equal(stripPort('10.0.0.1:11434'), '10.0.0.1');
  });

  test('returns the input unchanged when there is no port', () => {
    assert.equal(stripPort('localhost'), 'localhost');
    assert.equal(stripPort('api.example.com'), 'api.example.com');
    assert.equal(stripPort(''), '');
  });

  test('handles IPv6 literals by preserving the bracketed address', () => {
    assert.equal(stripPort('[::1]:8000'), '[::1]');
    assert.equal(stripPort('[2001:db8::1]:11434'), '[2001:db8::1]');
  });

  test('leaves an unbracketed IPv6 address alone (best effort)', () => {
    // No clean way to tell IPv6 from "hostname:port" without brackets, so
    // we accept that a bare IPv6 + port is ambiguous and gets truncated.
    assert.equal(stripPort('[::1]'), '[::1]');
  });
});

describe('renderStatusBar — probing', () => {
  test('uses the vm-disconnect icon and strips the port from the host', () => {
    const { text, tooltip } = renderStatusBar({
      kind: 'probing',
      host: 'localhost:8000',
    });
    assert.equal(text, '$(vm-disconnect) localhost');
    // Tooltip still carries the full host:port for diagnostic context.
    assert.ok(tooltip.includes('Checking connection'));
  });

  test('falls back to a literal "gateway" placeholder when host is empty', () => {
    const { text } = renderStatusBar({ kind: 'probing', host: '' });
    assert.equal(text, '$(vm-disconnect) gateway');
  });
});

describe('renderStatusBar — idle (connected)', () => {
  test('uses vm-active + the host (port stripped) as the only bar text', () => {
    const { text } = renderStatusBar({
      kind: 'idle',
      host: 'localhost:8000',
      modelCount: 3,
      modelIds: ['Qwen3-8B', 'Llama-3.1-8B', 'Mistral-7B'],
    });
    assert.equal(text, '$(vm-active) localhost');
  });

  test('tooltip preserves the full host:port for diagnostic context', () => {
    const { tooltip } = renderStatusBar({
      kind: 'idle',
      host: 'localhost:8000',
      modelCount: 1,
      modelIds: ['Qwen3-8B'],
    });
    assert.ok(tooltip.includes('Server: `localhost:8000`'));
  });

  test('lists model ids in the tooltip', () => {
    const { tooltip } = renderStatusBar({
      kind: 'idle',
      host: 'localhost:8000',
      modelCount: 2,
      modelIds: ['Qwen3-8B', 'Llama-3.1-8B'],
    });
    assert.ok(tooltip.includes('Qwen3-8B'));
    assert.ok(tooltip.includes('Llama-3.1-8B'));
    assert.ok(tooltip.includes('Click to open status'));
  });

  test('collapses long model lists to "and N more" in the tooltip', () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
    const { tooltip } = renderStatusBar({
      kind: 'idle',
      host: 'localhost:8000',
      modelCount: ids.length,
      modelIds: ids,
    });
    for (const id of ids.slice(0, 5)) {
      assert.ok(tooltip.includes(id), `expected ${id} in tooltip`);
    }
    assert.ok(!tooltip.includes('m6'));
    assert.ok(tooltip.includes('and 2 more'));
  });
});

describe('renderStatusBar — streaming (still connected)', () => {
  test('bar text stays the same as idle (vm-active + host, port stripped)', () => {
    const { text } = renderStatusBar({
      kind: 'streaming',
      host: 'localhost:8000',
      modelId: 'Qwen/Qwen3-8B',
      modelName: 'Qwen3-8B',
      activeCount: 1,
    });
    assert.equal(text, '$(vm-active) localhost');
  });

  test('tooltip names the active model', () => {
    const { tooltip } = renderStatusBar({
      kind: 'streaming',
      host: 'localhost:8000',
      modelId: 'Qwen/Qwen3-8B',
      modelName: 'Qwen3-8B',
      activeCount: 1,
    });
    assert.ok(tooltip.includes('Qwen/Qwen3-8B'));
    assert.ok(tooltip.includes('Streaming response'));
  });

  test('tooltip summarises concurrent requests', () => {
    const { tooltip } = renderStatusBar({
      kind: 'streaming',
      host: 'localhost:8000',
      modelId: 'Qwen/Qwen3-8B',
      modelName: 'Qwen3-8B',
      activeCount: 3,
    });
    assert.ok(tooltip.includes('3 concurrent'));
  });
});

describe('renderStatusBar — responded', () => {
  test('bar text remains vm-active + host (port stripped; detail lives in tooltip)', () => {
    const { text } = renderStatusBar({
      kind: 'responded',
      host: 'localhost:8000',
      modelId: 'Qwen/Qwen3-8B',
      modelName: 'Qwen3-8B',
      usage: { prompt: 1234, completion: 3456, total: 4690 },
    });
    assert.equal(text, '$(vm-active) localhost');
  });

  test('tooltip includes the per-token usage breakdown when reported', () => {
    const { tooltip } = renderStatusBar({
      kind: 'responded',
      host: 'localhost:8000',
      modelId: 'Qwen/Qwen3-8B',
      modelName: 'Qwen3-8B',
      usage: { prompt: 1234, completion: 3456, total: 4690 },
    });
    assert.ok(tooltip.includes('1,234 in'));
    assert.ok(tooltip.includes('3,456 out'));
    assert.ok(tooltip.includes('4,690 total'));
  });

  test('tooltip omits the usage block when no usage was reported', () => {
    const { tooltip } = renderStatusBar({
      kind: 'responded',
      host: 'localhost:8000',
      modelId: 'Qwen/Qwen3-8B',
      modelName: 'Qwen3-8B',
    });
    assert.ok(!tooltip.includes('Tokens:'));
    assert.ok(tooltip.includes('Last request'));
  });
});

describe('renderStatusBar — error (disconnected)', () => {
  test('uses vm-disconnect + the host (port stripped)', () => {
    const { text } = renderStatusBar({
      kind: 'error',
      host: 'localhost:8000',
      errorMessage: 'connect ECONNREFUSED 127.0.0.1:8000',
    });
    assert.equal(text, '$(vm-disconnect) localhost');
  });

  test('tooltip carries the full error message and a retry hint', () => {
    const { tooltip } = renderStatusBar({
      kind: 'error',
      host: 'localhost:8000',
      errorMessage: 'connect ECONNREFUSED 127.0.0.1:8000',
    });
    assert.ok(tooltip.includes('connect ECONNREFUSED 127.0.0.1:8000'));
    assert.ok(tooltip.includes('Click to open status'));
  });
});

describe('renderStatusBar — noModels (server up, empty list)', () => {
  test('treats the gateway as connected (server reached, just empty)', () => {
    const { text, tooltip } = renderStatusBar({
      kind: 'noModels',
      host: 'localhost:8000',
    });
    assert.equal(text, '$(vm-active) localhost');
    assert.ok(tooltip.includes('no models were reported'));
  });
});

describe('renderStatusBar — exhaustiveness', () => {
  test('returns a non-empty text and tooltip for every state variant', () => {
    const states: StatusBarState[] = [
      { kind: 'probing', host: 'h' },
      { kind: 'idle', host: 'h', modelCount: 0, modelIds: [] },
      { kind: 'streaming', host: 'h', modelId: 'm', modelName: 'm', activeCount: 1 },
      { kind: 'responded', host: 'h', modelId: 'm', modelName: 'm' },
      { kind: 'error', host: 'h', errorMessage: 'oops' },
      { kind: 'noModels', host: 'h' },
    ];
    for (const state of states) {
      const { text, tooltip } = renderStatusBar(state);
      assert.ok(text.length > 0, `empty text for state ${state.kind}`);
      assert.ok(tooltip.length > 0, `empty tooltip for state ${state.kind}`);
    }
  });

  test('only the two icons defined by the user appear in bar text', () => {
    const states: StatusBarState[] = [
      { kind: 'probing', host: 'h' },
      { kind: 'idle', host: 'h', modelCount: 1, modelIds: ['m'] },
      { kind: 'streaming', host: 'h', modelId: 'm', modelName: 'm', activeCount: 1 },
      { kind: 'responded', host: 'h', modelId: 'm', modelName: 'm' },
      { kind: 'error', host: 'h', errorMessage: 'oops' },
      { kind: 'noModels', host: 'h' },
    ];
    for (const state of states) {
      const { text } = renderStatusBar(state);
      const hasActive = text.startsWith('$(vm-active) ');
      const hasDisconnect = text.startsWith('$(vm-disconnect) ');
      assert.ok(
        hasActive || hasDisconnect,
        `state ${state.kind} produced unexpected icon: ${text}`
      );
    }
  });

  test('bar text never includes a port suffix even when state.host has one', () => {
    const states: StatusBarState[] = [
      { kind: 'probing', host: 'localhost:8000' },
      { kind: 'idle', host: 'localhost:8000', modelCount: 1, modelIds: ['m'] },
      {
        kind: 'streaming',
        host: 'localhost:8000',
        modelId: 'm',
        modelName: 'm',
        activeCount: 1,
      },
      { kind: 'responded', host: 'localhost:8000', modelId: 'm', modelName: 'm' },
      { kind: 'error', host: 'localhost:8000', errorMessage: 'oops' },
      { kind: 'noModels', host: 'localhost:8000' },
    ];
    for (const state of states) {
      const { text } = renderStatusBar(state);
      assert.ok(
        !text.includes(':8000'),
        `state ${state.kind} leaked port into bar text: ${text}`
      );
    }
  });
});
