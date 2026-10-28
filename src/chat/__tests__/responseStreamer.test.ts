import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  StreamChunk,
  StreamReporter,
  isEmptyStreamResult,
  streamResponse,
} from '../responseStreamer';

interface ReporterEvent {
  kind: 'text' | 'thinking' | 'thinkingDone' | 'toolCall' | 'usage';
  value?: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function makeReporter(): { reporter: StreamReporter; events: ReporterEvent[] } {
  const events: ReporterEvent[] = [];
  const reporter: StreamReporter = {
    reportText: (text) => events.push({ kind: 'text', value: text }),
    reportThinking: (text) => events.push({ kind: 'thinking', value: text }),
    reportThinkingDone: () => events.push({ kind: 'thinkingDone' }),
    reportToolCall: (id, name, args) => events.push({ kind: 'toolCall', id, name, args }),
    reportUsage: (usage) => events.push({
      kind: 'usage',
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      },
    }),
  };
  return { reporter, events };
}

async function* iter(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

const identityArgs = (tc: { arguments: string }): Record<string, unknown> => {
  try {
    return JSON.parse(tc.arguments) as Record<string, unknown>;
  } catch {
    return {};
  }
};

describe('streamResponse repetition guard', () => {
  const LOOP = 'I need to re-read the file before I can answer this. ';

  test('stops a repeating response, closes the upstream stream, and explains', async () => {
    const { reporter, events } = makeReporter();
    let produced = 0;
    let closed = false;
    async function* looping(): AsyncIterable<StreamChunk> {
      try {
        for (; produced < 500; produced++) {
          yield { content: LOOP };
        }
      } finally {
        closed = true;
      }
    }
    const stats = await streamResponse({
      chunks: looping(),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
      detectRepetition: true,
    });
    assert.equal(stats.repetitionStopped, true);
    assert.ok(produced < 500, `consumed all ${produced} chunks`);
    assert.equal(closed, true);
    const last = events[events.length - 1];
    assert.equal(last.kind, 'text');
    assert.match(last.value ?? '', /repeating/);
    assert.equal(isEmptyStreamResult(stats), false);
  });

  test('closes a looping reasoning block before the note, with no budget fallback', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter(Array.from({ length: 200 }, () => ({ reasoning_content: LOOP }))),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
      detectRepetition: true,
      maxOutputTokens: 1000,
    });
    assert.equal(stats.repetitionStopped, true);
    const texts = events.filter((e) => e.kind === 'text');
    assert.equal(texts.length, 1);
    assert.match(texts[0].value ?? '', /repeating/);
    const doneIndex = events.findIndex((e) => e.kind === 'thinkingDone');
    assert.ok(doneIndex >= 0 && doneIndex < events.indexOf(texts[0]));
    assert.equal(isEmptyStreamResult(stats), false);
  });

  test('stopping inside a <think> block does not add the budget fallback', async () => {
    const { reporter, events } = makeReporter();
    const chunks: StreamChunk[] = [{ content: '<think>' }, ...Array.from({ length: 200 }, () => ({ content: LOOP }))];
    const stats = await streamResponse({
      chunks: iter(chunks),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
      detectRepetition: true,
    });
    assert.equal(stats.repetitionStopped, true);
    const texts = events.filter((e) => e.kind === 'text');
    assert.equal(texts.length, 1);
    assert.doesNotMatch(texts[0].value ?? '', /budget/);
  });

  test('does not stop when detection is off', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter(Array.from({ length: 100 }, () => ({ content: LOOP }))),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.ok(!stats.repetitionStopped);
    assert.equal(events.filter((e) => e.kind === 'text').length, 100);
  });
});

describe('streamResponse tool-call withholding', () => {
  const repeat = { id: 'c1', name: 'read_file', arguments: '{"filePath":"a.ts"}' };
  const other = { id: 'c2', name: 'grep_search', arguments: '{"query":"plan"}' };
  const blockRepeat = (name: string, args: Record<string, unknown>): boolean => name === 'read_file' && args.filePath === 'a.ts';

  test('withholds the blocked repeat and explains when it was all the model did', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ finished_tool_calls: [repeat] }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
      withholdToolCall: blockRepeat,
    });
    assert.equal(stats.totalToolCalls, 0);
    assert.equal(stats.droppedToolCalls, 1);
    assert.equal(events.some((e) => e.kind === 'toolCall'), false);
    const texts = events.filter((e) => e.kind === 'text').map((e) => e.value ?? '');
    assert.equal(texts.length, 1);
    assert.match(texts[0], /^\*\(Loop guard: the model made the blocked tool call again/);
    assert.equal(isEmptyStreamResult(stats), false);
  });

  test('lets a different call through alongside the withheld repeat, with no note', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ content: 'Let me look at the plan instead.' }, { finished_tool_calls: [repeat, other] }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
      withholdToolCall: blockRepeat,
    });
    assert.equal(stats.totalToolCalls, 1);
    assert.equal(stats.droppedToolCalls, 1);
    assert.deepEqual(events.filter((e) => e.kind === 'toolCall').map((e) => e.name), ['grep_search']);
    assert.deepEqual(events.filter((e) => e.kind === 'text').map((e) => e.value), ['Let me look at the plan instead.']);
  });

  test('passes the same tool with different arguments', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ finished_tool_calls: [{ id: 'c3', name: 'read_file', arguments: '{"filePath":"b.ts"}' }] }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
      withholdToolCall: blockRepeat,
    });
    assert.equal(stats.totalToolCalls, 1);
    assert.equal(stats.droppedToolCalls, undefined);
    assert.equal(events.filter((e) => e.kind === 'toolCall').length, 1);
  });

  test('adds the note after text when the only call was the withheld repeat', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ content: 'Reading the file once more.' }, { finished_tool_calls: [repeat] }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
      withholdToolCall: blockRepeat,
    });
    assert.equal(stats.droppedToolCalls, 1);
    const texts = events.filter((e) => e.kind === 'text').map((e) => e.value ?? '');
    assert.equal(texts[0], 'Reading the file once more.');
    assert.match(texts[1], /^\n\n\*\(Loop guard: the model made the blocked tool call again/);
  });

  test('matches on the repaired arguments', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ finished_tool_calls: [{ id: 'c4', name: 'read_file', arguments: '{"filePath":"a.ts"' }] }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: () => ({ filePath: 'a.ts' }),
      withholdToolCall: blockRepeat,
    });
    assert.equal(stats.droppedToolCalls, 1);
    assert.equal(events.some((e) => e.kind === 'toolCall'), false);
  });
});

describe('streamResponse', () => {
  test('reports plain text content', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ content: 'hello' }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.totalTextParts, 1);
    assert.equal(stats.totalContentLength, 5);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'text');
    assert.equal(events[0].value, 'hello');
  });

  test('reports reasoning_content as thinking and closes it when text starts', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([
        { reasoning_content: 'I should think' },
        { content: 'then say this' },
      ]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.hadThinking, true);
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ['thinking', 'thinkingDone', 'text']);
    assert.equal(events[0].value, 'I should think');
  });

  test('closes a trailing reasoning_content block at end-of-stream', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ reasoning_content: 'only reasoning' }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.hadThinking, true);
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ['thinking', 'thinkingDone']);
    assert.equal(isEmptyStreamResult(stats), true);
  });

  test('parses inline <thinking> tags in content', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([
        { content: 'prefix <thinking>hidden</thinking> visible' },
      ]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.hadThinking, true);
    const textEvents = events.filter((e) => e.kind === 'text').map((e) => e.value);
    const thinkingEvents = events.filter((e) => e.kind === 'thinking').map((e) => e.value);
    assert.deepEqual(thinkingEvents, ['hidden']);
    // Concatenated visible text should match.
    assert.equal(textEvents.join(''), 'prefix  visible');
    assert.ok(events.some((e) => e.kind === 'thinkingDone'));
  });

  test('handles <thinking> tag split across chunks', async () => {
    const { reporter, events } = makeReporter();
    await streamResponse({
      chunks: iter([
        { content: 'pre<think' },
        { content: 'ing>mid</think' },
        { content: 'ing>post' },
      ]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    const textValue = events
      .filter((e) => e.kind === 'text')
      .map((e) => e.value)
      .join('');
    const thinkingValue = events
      .filter((e) => e.kind === 'thinking')
      .map((e) => e.value)
      .join('');
    assert.equal(textValue, 'prepost');
    assert.equal(thinkingValue, 'mid');
  });

  test('dispatches finished tool calls through resolveToolCallArgs', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([
        {
          finished_tool_calls: [
            { id: 'c1', name: 'search', arguments: '{"q":"hi"}' },
          ],
        },
      ]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: (tc) => JSON.parse(tc.arguments) as Record<string, unknown>,
    });
    assert.equal(stats.totalToolCalls, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'toolCall');
    assert.equal(events[0].id, 'c1');
    assert.equal(events[0].name, 'search');
    assert.deepEqual(events[0].args, { q: 'hi' });
  });

  test('stops early when isCancelled returns true', async () => {
    const { reporter, events } = makeReporter();
    let callCount = 0;
    await streamResponse({
      chunks: iter([{ content: 'first' }, { content: 'second' }, { content: 'third' }]),
      reporter,
      isCancelled: () => {
        callCount++;
        // After two iterations, cancel.
        return callCount > 2;
      },
      resolveToolCallArgs: identityArgs,
    });
    const textEvents = events.filter((e) => e.kind === 'text');
    assert.ok(textEvents.length < 3);
  });

  test('emits fallback text when stream force-closes mid-thinking with no output', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      // Unclosed <thinking> tag — parser.flush() will emit an 'E' piece.
      chunks: iter([{ content: '<thinking>still thinking' }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.thinkingForceClosed, true);
    assert.equal(stats.totalTextParts, 0);
    assert.equal(stats.totalToolCalls, 0);
    // Fallback message should be reported as text.
    const fallback = events.find(
      (e) => e.kind === 'text' && e.value?.includes('used its whole')
    );
    assert.ok(fallback, 'expected fallback text to be emitted');
  });

  test('emits fallback when finish_reason=length ends a reasoning-only stream', async () => {
    // vLLM/llama-server with a reasoning parser stream thinking as
    // `reasoning_content`, so the ThinkingParser never sees a tag to
    // force-close; the only signal that the budget ran out is finish_reason.
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([
        { reasoning_content: 'Let me think about bubble sort in Rust...' },
        { reasoning_content: 'still thinking', finish_reason: 'length' },
      ]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
      maxOutputTokens: 4096,
    });
    assert.equal(stats.finishReason, 'length');
    assert.equal(stats.outputTruncated, true);
    assert.equal(stats.hadThinking, true);
    assert.equal(stats.totalTextParts, 0);
    assert.equal(isEmptyStreamResult(stats), false);
    const fallback = events.find((e) => e.kind === 'text');
    assert.ok(fallback?.value?.includes('4,096-token output budget on thinking'), fallback?.value ?? 'no text');
    assert.ok(fallback?.value?.includes('Set Thinking Effort'));
  });

  test('finish_reason=length fallback without thinking omits the thinking hint', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ content: '', finish_reason: 'length' }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.outputTruncated, true);
    const fallback = events.find((e) => e.kind === 'text');
    assert.ok(fallback?.value?.includes('before producing any answer'), fallback?.value ?? 'no text');
    assert.ok(!fallback?.value?.includes('Set Thinking Effort'));
  });

  test('finish_reason=length with visible text is not treated as truncated-empty', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ content: 'partial answer', finish_reason: 'length' }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.finishReason, 'length');
    assert.notEqual(stats.outputTruncated, true);
    assert.equal(events.filter((e) => e.kind === 'text').length, 1);
  });

  test('finish_reason=stop with nothing visible stays a plain empty result', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ content: '', finish_reason: 'stop' }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.outputTruncated, false);
    assert.equal(isEmptyStreamResult(stats), true);
    assert.equal(events.length, 0);
  });

  test('explains a reply that stopped inside reasoning_content instead of reporting it empty', async () => {
    // Issue #136: llama-server routes Qwen3's closing summary into
    // reasoning_content and ends with finish_reason=stop and no content.
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([
        { reasoning_content: 'I refactored promiseParallel to Promise.all.' },
        { finish_reason: 'stop' },
      ]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.endedInThinking, true);
    assert.equal(stats.outputTruncated, false);
    assert.equal(isEmptyStreamResult(stats), false);
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ['thinking', 'thinkingDone', 'text']);
    assert.ok(events[2].value?.includes('stopped while still thinking'), events[2].value ?? 'no text');
  });

  test('explains a reply that stopped after an inline <think> block', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ content: '<think>All done.</think>', finish_reason: 'stop' }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.endedInThinking, true);
    assert.equal(isEmptyStreamResult(stats), false);
    assert.ok(events[events.length - 1]?.value?.includes('stopped while still thinking'));
  });

  test('no thinking note when the model also called a tool', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([
        { reasoning_content: 'Read the file first.' },
        { finished_tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{}' }], finish_reason: 'tool_calls' },
      ]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.notEqual(stats.endedInThinking, true);
    assert.equal(events.filter((e) => e.kind === 'text').length, 0);
  });

  test('does not emit fallback when force-closed but text parts exist', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ content: 'visible <thinking>incomplete' }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.thinkingForceClosed, true);
    assert.ok(stats.totalTextParts > 0);
    const fallback = events.find(
      (e) => e.kind === 'text' && e.value?.includes('used its whole')
    );
    assert.equal(fallback, undefined);
  });

  test('returns zeroed stats on an empty stream', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.totalContentLength, 0);
    assert.equal(stats.totalTextParts, 0);
    assert.equal(stats.totalToolCalls, 0);
    assert.equal(stats.hadThinking, false);
    assert.equal(stats.thinkingForceClosed, false);
    assert.equal(events.length, 0);
  });

  test('reports a usage frame to the reporter when chunk has usage', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([
        { content: 'hi' },
        {
          usage: {
            prompt_tokens: 42,
            completion_tokens: 7,
            total_tokens: 49,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        },
      ]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.reportedUsage, true);
    const usageEvents = events.filter((e) => e.kind === 'usage');
    assert.equal(usageEvents.length, 1);
    assert.deepEqual(usageEvents[0].usage, {
      prompt_tokens: 42,
      completion_tokens: 7,
      total_tokens: 49,
    });
  });

  test('emits the usage frame only once even when the server repeats totals', async () => {
    const { reporter, events } = makeReporter();
    const usage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 0 },
    };
    await streamResponse({
      chunks: iter([
        { content: 'x', usage },
        { content: 'y', usage },
        { usage },
      ]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    const usageEvents = events.filter((e) => e.kind === 'usage');
    assert.equal(usageEvents.length, 1);
  });

  test('does not emit usage when no chunk carries it', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ content: 'plain content' }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.reportedUsage, false);
    assert.equal(events.filter((e) => e.kind === 'usage').length, 0);
  });
});

describe('isEmptyStreamResult', () => {
  test('true for zeroed stats', () => {
    assert.equal(
      isEmptyStreamResult({
        totalContentLength: 0,
        totalTextParts: 0,
        totalToolCalls: 0,
        hadThinking: false,
        thinkingForceClosed: false,
      }),
      true
    );
  });

  test('false when there is content', () => {
    assert.equal(
      isEmptyStreamResult({
        totalContentLength: 2,
        totalTextParts: 1,
        totalToolCalls: 0,
        hadThinking: false,
        thinkingForceClosed: false,
      }),
      false
    );
  });

  test('false when there are tool calls', () => {
    assert.equal(
      isEmptyStreamResult({
        totalContentLength: 0,
        totalTextParts: 0,
        totalToolCalls: 1,
        hadThinking: false,
        thinkingForceClosed: false,
      }),
      false
    );
  });

  test('true when thinking occurred without visible output', () => {
    assert.equal(
      isEmptyStreamResult({
        totalContentLength: 0,
        totalTextParts: 0,
        totalToolCalls: 0,
        hadThinking: true,
        thinkingForceClosed: false,
      }),
      true
    );
  });

  test('false when the reply ended in thinking', () => {
    assert.equal(
      isEmptyStreamResult({
        totalContentLength: 0,
        totalTextParts: 0,
        totalToolCalls: 0,
        hadThinking: true,
        thinkingForceClosed: false,
        endedInThinking: true,
      }),
      false
    );
  });

  test('false when thinking was force-closed', () => {
    assert.equal(
      isEmptyStreamResult({
        totalContentLength: 0,
        totalTextParts: 0,
        totalToolCalls: 0,
        hadThinking: false,
        thinkingForceClosed: true,
      }),
      false
    );
  });
});
