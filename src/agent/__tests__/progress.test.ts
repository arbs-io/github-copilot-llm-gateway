import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROGRESS_POLICY,
  evaluateCandidateToolBatchProgress,
  evaluateCandidateToolProgress,
  evaluateTranscriptProgress,
} from '../progress';
import { OpenAIMessage } from '../../api/types';

function callTurn(id: string, start: number, result: string): OpenAIMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id,
        type: 'function',
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ path: 'src/large.ts', start, end: start + 99 }),
        },
      }],
    },
    { role: 'tool', tool_call_id: id, content: result },
  ];
}

describe('semantic progress evaluation', () => {
  test('counts unique useful ranged reads as productive progress', () => {
    const messages = Array.from(
      { length: 7 },
      (_, index) => callTurn(`c${index}`, index * 100, `${index}: ${'useful source text '.repeat(10)}`)
    ).flat();
    const evaluation = evaluateTranscriptProgress(messages);

    assert.equal(evaluation.productiveToolResults, 7);
    assert.equal(evaluation.noProgressToolCallTurns, 0);
    assert.equal(evaluation.stage, 'none');
  });

  test('blocks a candidate after the exact same call repeats past the limit', () => {
    const repeatedResult = `same output ${'detail '.repeat(20)}`;
    const messages = [
      ...callTurn('c1', 0, repeatedResult),
      ...callTurn('c2', 0, repeatedResult),
    ];
    const policy = { ...DEFAULT_PROGRESS_POLICY, exactRepeatedToolCallLimit: 2 };
    const evaluation = evaluateCandidateToolProgress(messages, policy, {
      name: 'read_file',
      arguments: '{"path":"src/large.ts","start":0,"end":99}',
    });

    assert.equal(evaluation.repeatedToolCallCount, 3);
    assert.equal(evaluation.shouldBlock, true);
  });

  test('treats a parallel candidate batch as one tool turn', () => {
    const evaluation = evaluateCandidateToolBatchProgress(
      [],
      DEFAULT_PROGRESS_POLICY,
      [
        { name: 'read_file', arguments: '{"path":"a"}' },
        { name: 'read_file', arguments: '{"path":"b"}' },
      ]
    );
    assert.equal(evaluation.toolCallTurnsSinceGroundedResponse, 1);
  });
});
