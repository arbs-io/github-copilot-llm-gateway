import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOLTIP_COMMANDS,
  esc,
  renderStatusTooltipHtml,
} from '../statusTooltip';
import { StatusSnapshot } from '../statusSnapshot';
import { emptySessionStats } from '../sessionStats';

const FIXED_NOW = 2_000_000_000_000;

function makeSnapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    host: 'localhost:8000',
    connection: { state: 'ok' },
    lastSuccessfulFetchAt: FIXED_NOW - 120_000,
    models: [
      {
        id: 'qwen/Qwen3-8B',
        name: 'Qwen3-8B',
        contextLabel: '131k ctx',
        totalContext: 131_072,
        capabilityLabels: ['tools', 'vision'],
      },
    ],
    sessionStats: emptySessionStats(),
    features: {
      toolCalling: true,
      imageInput: true,
      parallelToolCalling: true,
      agentTemperature: 0,
    },
    now: FIXED_NOW,
    ...overrides,
  };
}

/**
 * Sanitizer-conformance regex: every `style="..."` attribute in our HTML must
 * match this so the VS Code MarkdownString renderer keeps it intact. Mirrors
 * the regex in microsoft/vscode `markdownRenderer.ts`.
 */
const ALLOWED_STYLE_REGEX =
  /^(color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(background-color:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(border-radius:[0-9]+px;)?$/;

function collectStyleAttrs(html: string): string[] {
  const out: string[] = [];
  const re = /<([a-z]+)\s[^>]*style="([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(`${m[1]}|${m[2]}`);
  }
  return out;
}

describe('esc', () => {
  test('escapes the five HTML metacharacters', () => {
    assert.equal(
      esc('<script>alert("x")</script>'),
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
    );
    assert.equal(esc("it's & that"), 'it&#39;s &amp; that');
  });

  test('passes through normal text untouched', () => {
    assert.equal(esc('Qwen3-8B'), 'Qwen3-8B');
    assert.equal(esc('localhost:8000'), 'localhost:8000');
  });

  test('handles non-string inputs', () => {
    assert.equal(esc(42), '42');
    assert.equal(esc(undefined), '');
    assert.equal(esc(null), '');
  });
});

describe('renderStatusTooltipHtml — sanitizer conformance', () => {
  test('every style="..." is on a <span> and matches the allowed-style regex', () => {
    const html = renderStatusTooltipHtml(
      makeSnapshot({
        sessionStats: {
          requestCount: 5,
          promptTokens: 1000,
          completionTokens: 2000,
          totalTokens: 3000,
          requestsWithUsage: 5,
        },
        lastRequest: {
          modelId: 'qwen/Qwen3-8B',
          modelName: 'Qwen3-8B',
          completedAt: FIXED_NOW - 10_000,
          usage: { prompt: 100, completion: 200, total: 300 },
        },
        features: {
          toolCalling: true,
          imageInput: false,
          parallelToolCalling: false,
          agentTemperature: 0.7,
        },
      })
    );
    const styles = collectStyleAttrs(html);
    assert.ok(styles.length > 0, 'expected the tooltip to contain styled spans');
    for (const entry of styles) {
      const [tag, style] = entry.split('|');
      assert.equal(tag.toLowerCase(), 'span', `style on disallowed tag <${tag}>: ${style}`);
      assert.match(
        style,
        ALLOWED_STYLE_REGEX,
        `style attribute is not sanitizer-safe: ${style}`
      );
    }
  });

  test('only uses HTML tags that pass the markdown renderer allow-list', () => {
    const html = renderStatusTooltipHtml(makeSnapshot());
    const allowedTags = new Set([
      'a', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'q', 'span', 'strong', 'sub',
      'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
      'details',
    ]);
    const tagRe = /<\/?([a-z][a-z0-9]*)(?:\s|>|\/)/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(html)) !== null) {
      assert.ok(
        allowedTags.has(m[1].toLowerCase()),
        `tag <${m[1]}> is not in the markdown renderer allow-list`
      );
    }
  });
});

describe('renderStatusTooltipHtml — header', () => {
  test('contains the gateway name, host, and a Refresh command link', () => {
    const html = renderStatusTooltipHtml(makeSnapshot());
    assert.ok(html.includes('<strong>LLM Gateway</strong>'));
    assert.ok(html.includes('localhost:8000'));
    assert.ok(html.includes(`href="command:${TOOLTIP_COMMANDS.Refresh}"`));
  });

  test('falls back to "not configured" when host is empty', () => {
    const html = renderStatusTooltipHtml(makeSnapshot({ host: '' }));
    assert.ok(html.includes('not configured'));
  });

  test('escapes a malicious host so it cannot inject markup', () => {
    const html = renderStatusTooltipHtml(makeSnapshot({ host: 'evil"<script>x()</script>' }));
    assert.ok(!html.includes('<script>x()</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});

describe('renderStatusTooltipHtml — connection row', () => {
  test('shows "Connected" with last refresh time for ok state', () => {
    const html = renderStatusTooltipHtml(makeSnapshot());
    assert.ok(html.includes('$(check)'));
    assert.ok(html.includes('Connected'));
    assert.ok(html.includes('Last refresh: 2m ago'));
  });

  test('renders "Disconnected" + escaped error in a <pre> block for error state', () => {
    const html = renderStatusTooltipHtml(
      makeSnapshot({
        connection: { state: 'error', errorMessage: 'ECONNREFUSED <bad>' },
        lastSuccessfulFetchAt: undefined,
      })
    );
    assert.ok(html.includes('$(error)'));
    assert.ok(html.includes('Disconnected'));
    assert.ok(html.includes('<pre>ECONNREFUSED &lt;bad&gt;</pre>'));
  });

  test('renders "Connected · empty" with warning for noModels', () => {
    const html = renderStatusTooltipHtml(makeSnapshot({ connection: { state: 'noModels' } }));
    assert.ok(html.includes('$(warning)'));
    assert.ok(html.includes('Connected · empty'));
    assert.ok(html.includes('Server returned no models'));
  });

  test('renders the spinner for unknown state', () => {
    const html = renderStatusTooltipHtml(makeSnapshot({ connection: { state: 'unknown' } }));
    assert.ok(html.includes('$(sync~spin)'));
    assert.ok(html.includes('Checking'));
  });
});

describe('renderStatusTooltipHtml — session usage', () => {
  test('omits the section before any request has run', () => {
    const html = renderStatusTooltipHtml(makeSnapshot());
    assert.ok(!html.includes('Session usage'));
  });

  test('renders the request count, totals, and prompt/completion split', () => {
    const html = renderStatusTooltipHtml(
      makeSnapshot({
        sessionStats: {
          requestCount: 17,
          promptTokens: 123_400,
          completionTokens: 111_100,
          totalTokens: 234_500,
          requestsWithUsage: 17,
        },
      })
    );
    assert.ok(html.includes('Session usage'));
    assert.ok(html.includes('<strong>17</strong>'));
    assert.ok(/234k|235k/.test(html));
    assert.ok(html.includes('123,400 in'));
    assert.ok(html.includes('111,100 out'));
    assert.ok(html.includes('avg'));
  });

  test('singularises "request" when count is 1', () => {
    const html = renderStatusTooltipHtml(
      makeSnapshot({
        sessionStats: {
          requestCount: 1,
          promptTokens: 100,
          completionTokens: 200,
          totalTokens: 300,
          requestsWithUsage: 1,
        },
      })
    );
    assert.ok(html.includes('>request<'));
    assert.ok(!html.includes('>requests<'));
  });
});

describe('renderStatusTooltipHtml — last request and context bar', () => {
  test('omits the section when there is no last request', () => {
    const html = renderStatusTooltipHtml(makeSnapshot());
    assert.ok(!html.includes('Last request'));
  });

  test('renders model, time, usage breakdown, and a context-usage bar', () => {
    const html = renderStatusTooltipHtml(
      makeSnapshot({
        lastRequest: {
          modelId: 'qwen/Qwen3-8B',
          modelName: 'Qwen3-8B',
          completedAt: FIXED_NOW - 34_000,
          usage: { prompt: 1234, completion: 3456, total: 4690 },
        },
      })
    );
    assert.ok(html.includes('Last request'));
    assert.ok(html.includes('<strong>Qwen3-8B</strong>'));
    assert.ok(html.includes('34s ago'));
    assert.ok(html.includes('1,234'));
    assert.ok(html.includes('3,456'));
    assert.ok(html.includes('4,690 total'));
    // Progress bar is drawn as background-coloured <span>s of non-breaking
    // spaces (native VS Code Copilot styling) — no unicode block chars.
    assert.ok(
      html.includes('<span style="background-color:var(--vscode-progressBar-background);">'),
      'expected the filled portion of the bar in progressBar-background'
    );
    assert.ok(
      html.includes('<span style="background-color:var(--vscode-input-background);">'),
      'expected the empty portion of the bar in input-background'
    );
    assert.ok(/&nbsp;/.test(html));
    assert.ok(!/█/.test(html), 'should not use block-character bars anymore');
    assert.ok(html.includes('% of'));
    assert.ok(html.includes('context'));
  });

  test('omits the context-usage bar when the model has no reported context window', () => {
    const html = renderStatusTooltipHtml(
      makeSnapshot({
        models: [
          {
            id: 'unknown-model',
            name: 'unknown-model',
            contextLabel: '',
            capabilityLabels: [],
          },
        ],
        lastRequest: {
          modelId: 'unknown-model',
          modelName: 'unknown-model',
          completedAt: FIXED_NOW - 5_000,
          usage: { prompt: 100, completion: 200, total: 300 },
        },
      })
    );
    assert.ok(html.includes('300 total'));
    assert.ok(!/% of/.test(html));
  });

  test('shows "usage not reported" with no bar when no usage frame is present', () => {
    const html = renderStatusTooltipHtml(
      makeSnapshot({
        lastRequest: {
          modelId: 'm',
          modelName: 'm',
          completedAt: FIXED_NOW - 5_000,
        },
      })
    );
    assert.ok(html.includes('usage not reported'));
    assert.ok(!/% of/.test(html));
  });

  test('clamps the context bar to 100% when usage exceeds the window', () => {
    const html = renderStatusTooltipHtml(
      makeSnapshot({
        models: [
          {
            id: 'qwen/Qwen3-8B',
            name: 'Qwen3-8B',
            contextLabel: '1k ctx',
            totalContext: 1000,
            capabilityLabels: [],
          },
        ],
        lastRequest: {
          modelId: 'qwen/Qwen3-8B',
          modelName: 'Qwen3-8B',
          completedAt: FIXED_NOW - 5_000,
          usage: { prompt: 5000, completion: 0, total: 5000 },
        },
      })
    );
    // 5000 / 1000 = 500% → clamped to 100. Verify "100%" appears.
    assert.ok(html.includes('100% of'));
    // Bar is entirely filled — no track span should be present.
    assert.ok(!html.includes('background-color:var(--vscode-input-background);'));
  });

  test('low percentages still show at least one filled cell so the bar is visible', () => {
    const html = renderStatusTooltipHtml(
      makeSnapshot({
        models: [
          {
            id: 'big-model',
            name: 'big-model',
            contextLabel: '1M ctx',
            totalContext: 1_000_000,
            capabilityLabels: [],
          },
        ],
        lastRequest: {
          modelId: 'big-model',
          modelName: 'big-model',
          completedAt: FIXED_NOW - 5_000,
          // 100 / 1,000,000 = 0.01% — rounds to zero cells without the
          // "always at least one" guard.
          usage: { prompt: 100, completion: 0, total: 100 },
        },
      })
    );
    // Filled span must still be present.
    assert.ok(html.includes('background-color:var(--vscode-progressBar-background);'));
  });
});

describe('renderStatusTooltipHtml — models block', () => {
  test('omits the block when there are no models', () => {
    const html = renderStatusTooltipHtml(makeSnapshot({ models: [] }));
    assert.ok(!html.includes('<strong>Models</strong>'));
  });

  test('lists each model with capability pills using sanitizer-safe spans', () => {
    const html = renderStatusTooltipHtml(
      makeSnapshot({
        models: [
          {
            id: 'qwen/Qwen3-8B',
            name: 'Qwen3-8B',
            contextLabel: '131k ctx',
            totalContext: 131_072,
            capabilityLabels: ['tools', 'vision'],
          },
        ],
      })
    );
    // Capability pill must use the (color;background-color;border-radius;) triplet.
    assert.ok(
      html.includes(
        '<span style="color:var(--vscode-badge-foreground);background-color:var(--vscode-badge-background);border-radius:4px;">&nbsp;tools&nbsp;</span>'
      )
    );
    assert.ok(html.includes('vision'));
  });

  test('collapses to "and N more" when more than 8 models are present', () => {
    const models = Array.from({ length: 11 }, (_, i) => ({
      id: `m${i}`,
      name: `model-${i}`,
      contextLabel: '',
      capabilityLabels: [],
    }));
    const html = renderStatusTooltipHtml(makeSnapshot({ models }));
    assert.ok(html.includes('model-0'));
    assert.ok(html.includes('model-7'));
    assert.ok(!html.includes('model-8'));
    assert.ok(html.includes('and 3 more'));
  });
});

describe('renderStatusTooltipHtml — feature rows', () => {
  test('uses charts-green for enabled status and muted for disabled', () => {
    const html = renderStatusTooltipHtml(
      makeSnapshot({
        features: {
          toolCalling: true,
          imageInput: false,
          parallelToolCalling: false,
          agentTemperature: 0.7,
        },
      })
    );
    assert.ok(html.includes('<span style="color:var(--vscode-charts-green);">Enabled</span>'));
    assert.ok(/<span style="color:var\(--vscode-descriptionForeground\);">Disabled<\/span>/.test(html));
    assert.ok(html.includes('temp 0.7'));
  });
});

describe('renderStatusTooltipHtml — footer', () => {
  test('contains command links for every footer action', () => {
    const html = renderStatusTooltipHtml(makeSnapshot());
    assert.ok(html.includes(`command:${TOOLTIP_COMMANDS.TestConnection}`));
    assert.ok(html.includes(`command:${TOOLTIP_COMMANDS.Configure}`));
    assert.ok(html.includes(`command:${TOOLTIP_COMMANDS.EditHeaders}`));
    assert.ok(html.includes(`command:${TOOLTIP_COMMANDS.Output}`));
  });

  test('URL-encodes the Open settings argument so it targets our scope', () => {
    const html = renderStatusTooltipHtml(makeSnapshot());
    const match = html.match(
      new RegExp(`command:${TOOLTIP_COMMANDS.OpenSettings}\\?([^)]*)\\)`)
    );
    assert.ok(match, 'expected encoded Open settings link');
    const decoded = JSON.parse(decodeURIComponent(match![1]));
    assert.equal(decoded, 'github.copilot.llm-gateway');
  });
});
