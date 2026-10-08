import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIMessage } from '../../api/types';
import {
  appendToolLoopNudge,
  buildToolLoopNote,
  countRepeatedToolRounds,
  guardToolLoop,
  isRepeatedToolCall,
  resolveToolLoopAction,
} from '../toolLoop';

function call(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function round(id: string, name: string, args: Record<string, unknown>, result: string): OpenAIMessage[] {
  return [
    { role: 'assistant', content: null, tool_calls: [call(id, name, args)] },
    { role: 'tool', tool_call_id: id, content: result },
  ];
}

const PROMPT: OpenAIMessage[] = [
  { role: 'system', content: 'You are a coding agent.' },
  { role: 'user', content: 'Fix the failing test.' },
];

const READ_ARGS = { filePath: '/repo/src/a.ts', startLine: 1, endLine: 50 };

describe('countRepeatedToolRounds', () => {
  test('counts identical trailing rounds', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'file body'),
      ...round('c2', 'read_file', READ_ARGS, 'file body'),
      ...round('c3', 'read_file', READ_ARGS, 'file body'),
    ];
    assert.deepEqual(countRepeatedToolRounds(messages), {
      count: 3,
      period: 1,
      toolNames: ['read_file'],
      calls: [{ name: 'read_file', arguments: JSON.stringify(READ_ARGS) }],
    });
  });

  test('a different result breaks the chain', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'get_terminal_output', { id: 't1' }, 'building...'),
      ...round('c2', 'get_terminal_output', { id: 't1' }, 'building... 50%'),
      ...round('c3', 'get_terminal_output', { id: 't1' }, 'building... done'),
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 1);
  });

  test('different arguments break the chain', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'same'),
      ...round('c2', 'read_file', { ...READ_ARGS, endLine: 100 }, 'same'),
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 1);
  });

  test('compares arguments sent as objects by value', () => {
    const objectRound = (id: string, filePath: string): OpenAIMessage[] => [
      { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: { filePath } } }] },
      { role: 'tool', tool_call_id: id, content: 'same' },
    ];
    const messages = [...PROMPT, ...objectRound('c1', 'a.ts'), ...objectRound('c2', 'b.ts'), ...objectRound('c3', 'b.ts')];
    assert.equal(countRepeatedToolRounds(messages).count, 2);
  });

  test('stops at a plain assistant answer from an earlier turn', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'file body'),
      ...round('c2', 'read_file', READ_ARGS, 'file body'),
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Check again.' },
      ...round('c3', 'read_file', READ_ARGS, 'file body'),
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 1);
  });

  test('skips user messages between rounds', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'file body'),
      { role: 'user', content: 'Context update.' },
      ...round('c2', 'read_file', READ_ARGS, 'file body'),
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 2);
  });

  test('matches parallel calls regardless of order', () => {
    const messages: OpenAIMessage[] = [
      ...PROMPT,
      { role: 'assistant', content: null, tool_calls: [call('a1', 'read_file', READ_ARGS), call('b1', 'grep', { q: 'x' })] },
      { role: 'tool', tool_call_id: 'a1', content: 'file body' },
      { role: 'tool', tool_call_id: 'b1', content: 'no matches' },
      { role: 'assistant', content: null, tool_calls: [call('b2', 'grep', { q: 'x' }), call('a2', 'read_file', READ_ARGS)] },
      { role: 'tool', tool_call_id: 'b2', content: 'no matches' },
      { role: 'tool', tool_call_id: 'a2', content: 'file body' },
    ];
    const status = countRepeatedToolRounds(messages);
    assert.equal(status.count, 2);
    assert.deepEqual(status.toolNames, ['grep', 'read_file']);
    assert.deepEqual(status.calls.map((c) => c.name), ['grep', 'read_file']);
  });

  test('returns 0 when the latest assistant message made no tool calls', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'file body'),
      { role: 'assistant', content: 'Here is the fix.' },
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 0);
    assert.equal(countRepeatedToolRounds([]).count, 0);
  });

  describe('cycles', () => {
    const A = (id: string): OpenAIMessage[] => round(id, 'read_file', READ_ARGS, 'file body');
    const B = (id: string): OpenAIMessage[] => round(id, 'grep_search', { query: 'plan' }, 'no matches');
    const C = (id: string): OpenAIMessage[] => round(id, 'list_dir', { path: '/repo' }, 'src/');

    test('detects two rounds alternating, counting every round of the stretch', () => {
      const status = countRepeatedToolRounds([...PROMPT, ...A('1'), ...B('2'), ...A('3'), ...B('4')]);
      assert.equal(status.period, 2);
      assert.equal(status.count, 4);
      assert.deepEqual(status.toolNames, ['read_file', 'grep_search']);
      assert.deepEqual(status.calls.map((c) => c.name), ['read_file', 'grep_search']);
    });

    test('keeps counting through a partial repetition', () => {
      const status = countRepeatedToolRounds([...PROMPT, ...A('1'), ...B('2'), ...A('3'), ...B('4'), ...A('5')]);
      assert.equal(status.period, 2);
      assert.equal(status.count, 5);
      // Call order within the cycle follows the history: B then the latest A.
      assert.deepEqual(status.toolNames, ['grep_search', 'read_file']);
    });

    test('needs the cycle to come round twice', () => {
      assert.equal(countRepeatedToolRounds([...PROMPT, ...A('1'), ...B('2'), ...A('3')]).count, 1);
      assert.equal(countRepeatedToolRounds([...PROMPT, ...A('1'), ...B('2'), ...C('3')]).count, 1);
    });

    test('a changed result inside the cycle breaks it', () => {
      const changed = round('3', 'read_file', READ_ARGS, 'file body (edited)');
      assert.equal(countRepeatedToolRounds([...PROMPT, ...A('1'), ...B('2'), ...changed, ...B('4')]).count, 1);
    });

    test('finds three-round cycles and prefers the shorter period on a tie', () => {
      const three = countRepeatedToolRounds([...PROMPT, ...A('1'), ...B('2'), ...C('3'), ...A('4'), ...B('5'), ...C('6')]);
      assert.equal(three.period, 3);
      assert.equal(three.count, 6);
      const same = countRepeatedToolRounds([...PROMPT, ...A('1'), ...A('2'), ...A('3'), ...A('4')]);
      assert.equal(same.period, 1);
      assert.equal(same.count, 4);
    });

    test('finds four-round cycles, including a partial pass, and blocks all four calls', () => {
      const D = (id: string): OpenAIMessage[] => round(id, 'file_search', { query: '*.md' }, 'plan.md');
      const four = [...A('1'), ...B('2'), ...C('3'), ...D('4')];
      const status = countRepeatedToolRounds([...PROMPT, ...four, ...four, ...A('9')]);
      assert.equal(status.period, 4);
      assert.equal(status.count, 9);
      assert.deepEqual(status.toolNames, ['grep_search', 'list_dir', 'file_search', 'read_file']);
      const blocked = isRepeatedToolCall(status);
      assert.equal(blocked('list_dir', { path: '/repo' }), true);
      assert.equal(blocked('file_search', { query: '*.md' }), true);
      assert.equal(blocked('file_search', { query: '*.ts' }), false);
    });

    test('a round that recurs inside a longer cycle still gives the longer period', () => {
      const status = countRepeatedToolRounds([...PROMPT, ...A('1'), ...A('2'), ...B('3'), ...A('4'), ...A('5'), ...B('6')]);
      assert.equal(status.period, 3);
      assert.equal(status.count, 6);
    });

    test('keeps the longer cycle when the latest rounds also repeat on their own', () => {
      // The two latest rounds match, but the three-round cycle covers the whole stretch.
      const status = countRepeatedToolRounds([
        ...PROMPT, ...A('1'), ...A('2'), ...B('3'), ...A('4'), ...A('5'), ...B('6'), ...A('7'), ...A('8'),
      ]);
      assert.equal(status.period, 3);
      assert.equal(status.count, 8);
    });

    test('a longer cycle that has not come round twice does not outrank a shorter one', () => {
      const status = countRepeatedToolRounds([...PROMPT, ...A('1'), ...A('2'), ...B('3'), ...A('4'), ...A('5')]);
      assert.equal(status.period, 1);
      assert.equal(status.count, 2);
    });

    test('ignores cycles longer than four rounds', () => {
      const D = (id: string): OpenAIMessage[] => round(id, 'file_search', { query: '*.md' }, 'plan.md');
      const E = (id: string): OpenAIMessage[] => round(id, 'get_errors', {}, 'none');
      const five = [...A('1'), ...B('2'), ...C('3'), ...D('4'), ...E('5')];
      const status = countRepeatedToolRounds([...PROMPT, ...five, ...five]);
      assert.equal(status.count, 1);
    });
  });

  test('returns 0 for a fresh user prompt after an unfinished looping turn', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'file body'),
      ...round('c2', 'read_file', READ_ARGS, 'file body'),
      ...round('c3', 'read_file', READ_ARGS, 'file body'),
      { role: 'user', content: 'Try something else.' },
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 0);
  });

  test('compares each round with its own results when servers reuse call ids', () => {
    const messages = [
      ...PROMPT,
      ...round('call_0', 'get_terminal_output', { id: 't1' }, 'building...'),
      ...round('call_0', 'get_terminal_output', { id: 't1' }, 'building... done'),
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 1);
  });
});

describe('resolveToolLoopAction', () => {
  test('escalates from nudge to block', () => {
    assert.equal(resolveToolLoopAction(2, 3, 5), 'none');
    assert.equal(resolveToolLoopAction(3, 3, 5), 'nudge');
    assert.equal(resolveToolLoopAction(5, 3, 5), 'block');
  });

  test('a threshold below 2 disables that level', () => {
    assert.equal(resolveToolLoopAction(7, 0, 5), 'block');
    assert.equal(resolveToolLoopAction(9, 3, 0), 'nudge');
    assert.equal(resolveToolLoopAction(10, 0, 0), 'none');
    assert.equal(resolveToolLoopAction(1, 1, 1), 'none');
  });
});

describe('appendToolLoopNudge', () => {
  test('appends to the last tool message only, without mutating the input', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'first'),
      ...round('c2', 'read_file', READ_ARGS, 'second'),
    ];
    const snapshot = structuredClone(messages);
    const result = appendToolLoopNudge(messages, 'NOTE');
    assert.deepEqual(messages, snapshot);
    assert.equal(result.length, messages.length);
    assert.equal(result[3].content, 'first');
    assert.equal(result[5].content, 'second\n\nNOTE');
  });

  test('leaves a history without tool results unchanged', () => {
    assert.deepEqual(appendToolLoopNudge(PROMPT, 'NOTE'), PROMPT);
  });
});

describe('buildToolLoopNote', () => {
  const status = { count: 3, period: 1, toolNames: ['read_file'], calls: [{ name: 'read_file', arguments: '{}' }] };

  test('names the repeated tools and the count', () => {
    const note = buildToolLoopNote(status, false);
    assert.match(note, /called read_file 3 times in a row/);
    assert.doesNotMatch(note, /blocked/);
  });

  test('tells the model the call is blocked, not that tools are gone', () => {
    const note = buildToolLoopNote({ ...status, count: 5 }, true);
    assert.match(note, /That exact call is now blocked/);
    assert.match(note, /different tool or use different arguments/);
  });

  test('describes a cycle as a repeated sequence and blocks all of its calls', () => {
    const cycle = {
      count: 6,
      period: 2,
      toolNames: ['read_file', 'grep_search'],
      calls: [{ name: 'read_file', arguments: '{}' }, { name: 'grep_search', arguments: '{}' }],
    };
    assert.match(buildToolLoopNote(cycle, false), /repeated the same sequence of tool calls \(read_file, grep_search\) for 6 rounds/);
    assert.match(buildToolLoopNote(cycle, true), /Those exact calls are now blocked/);
  });
});

describe('isRepeatedToolCall', () => {
  const status = countRepeatedToolRounds([
    ...PROMPT,
    ...round('c1', 'read_file', READ_ARGS, 'file body'),
    ...round('c2', 'read_file', READ_ARGS, 'file body'),
  ]);
  const blocked = isRepeatedToolCall(status);

  test('matches the looping call whatever the argument order', () => {
    assert.equal(blocked('read_file', READ_ARGS), true);
    assert.equal(blocked('read_file', { endLine: 50, startLine: 1, filePath: '/repo/src/a.ts' }), true);
  });

  test('lets a different tool or different arguments through', () => {
    assert.equal(blocked('grep_search', { query: 'a' }), false);
    assert.equal(blocked('read_file', { ...READ_ARGS, endLine: 100 }), false);
    assert.equal(blocked('read_file', { filePath: '/repo/src/b.ts' }), false);
  });

  test('blocks every call of an alternating cycle, not just the latest', () => {
    const alternating = countRepeatedToolRounds([
      ...PROMPT,
      ...round('1', 'read_file', READ_ARGS, 'file body'),
      ...round('2', 'grep_search', { query: 'plan' }, 'no matches'),
      ...round('3', 'read_file', READ_ARGS, 'file body'),
      ...round('4', 'grep_search', { query: 'plan' }, 'no matches'),
    ]);
    const blockedInCycle = isRepeatedToolCall(alternating);
    assert.equal(blockedInCycle('read_file', READ_ARGS), true);
    assert.equal(blockedInCycle('grep_search', { query: 'plan' }), true);
    assert.equal(blockedInCycle('grep_search', { query: 'tests' }), false);
  });
});

describe('guardToolLoop', () => {
  const looping = [
    ...PROMPT,
    ...round('c1', 'read_file', READ_ARGS, 'file body'),
    ...round('c2', 'read_file', READ_ARGS, 'file body'),
    ...round('c3', 'read_file', READ_ARGS, 'file body'),
  ];
  const options = { toolsOffered: true, nudgeAfter: 2, blockAfter: 3, canBlock: true };
  const lastContent = (messages: OpenAIMessage[]): string => String(messages[messages.length - 1].content);

  test('blocks the repeated call and tells the model through the latest tool result', () => {
    const guard = guardToolLoop(looping, options);
    assert.equal(guard.action, 'block');
    assert.match(lastContent(guard.messages), /now blocked/);
    assert.deepEqual(guard.status.calls.map((c) => c.name), ['read_file']);
  });

  test('leaves requests that offer no tools alone', () => {
    const guard = guardToolLoop(looping, { ...options, toolsOffered: false });
    assert.equal(guard.action, 'none');
    assert.equal(guard.messages, looping);
  });

  test('only nudges a caller that requires a tool call', () => {
    const guard = guardToolLoop(looping, { ...options, canBlock: false });
    assert.equal(guard.action, 'nudge');
    assert.match(lastContent(guard.messages), /will not produce new information/);
  });

  test('with default thresholds a three-round cycle is blocked as soon as it is detected', () => {
    const defaults = { toolsOffered: true, nudgeAfter: 3, blockAfter: 5, canBlock: true };
    const abc = (ids: [string, string, string]): OpenAIMessage[] => [
      ...round(ids[0], 'read_file', READ_ARGS, 'file body'),
      ...round(ids[1], 'grep_search', { query: 'plan' }, 'no matches'),
      ...round(ids[2], 'list_dir', { path: '/repo' }, 'src/'),
    ];
    // Five rounds hold only one full pass, so nothing fires yet.
    const onePass = guardToolLoop([...PROMPT, ...abc(['1', '2', '3']), ...abc(['4', '5', '6']).slice(0, 4)], defaults);
    assert.equal(onePass.action, 'none');
    // The sixth round completes the second pass: six rounds without new information is past the block threshold.
    const twoPasses = guardToolLoop([...PROMPT, ...abc(['1', '2', '3']), ...abc(['4', '5', '6'])], defaults);
    assert.equal(twoPasses.action, 'block');
    assert.match(lastContent(twoPasses.messages), /sequence of tool calls \(read_file, grep_search, list_dir\) for 6 rounds/);
  });
});
