import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateSerializedToolTokens,
  limitToolsBySchemaTokenBudget,
  selectToolsForRequest,
} from '../toolSelection';
import { ProgressEvaluation } from '../types';

const progress: ProgressEvaluation = {
  stage: 'none',
  score: 100,
  reasons: [],
  nextPreferredFamilies: ['discovery', 'editing'],
  toolCallTurnsSinceGroundedResponse: 0,
  noProgressToolCallTurns: 0,
  repeatedToolCallCount: 0,
  repeatedToolFamilyCount: 0,
  productiveToolResults: 0,
  shouldBlock: false,
  narrowTools: false,
  injectReplan: false,
  forceSummary: false,
};

describe('tool selection hardening', () => {
  test('keeps pinned, recent, and core repository tools under a count cap', () => {
    const tools = [
      { name: 'custom_recent' },
      { name: 'memory' },
      ...[
        'read_file', 'file_search', 'grep_search', 'list_dir', 'create_file',
        'replace_string_in_file', 'insert_edit_into_file', 'run_in_terminal',
        'get_errors', 'manage_todo_list', 'get_terminal_output',
      ].map((name) => ({ name })),
      ...Array.from({ length: 30 }, (_, index) => ({ name: `optional_${index}` })),
    ];
    const selected = selectToolsForRequest({
      tools,
      maxTools: 12,
      messages: [{
        role: 'assistant',
        tool_calls: [{
          id: 'recent',
          type: 'function',
          function: { name: 'custom_recent', arguments: '{}' },
        }],
      }],
      pinnedToolNames: ['memory'],
      progress,
    });

    assert.equal(selected.items.length, 12);
    assert.ok(selected.prioritizedNames.includes('memory'));
    assert.ok(selected.prioritizedNames.includes('custom_recent'));
    assert.ok(selected.prioritizedNames.includes('read_file'));
    assert.ok(selected.prioritizedNames.includes('replace_string_in_file'));
    assert.ok(selected.prioritizedNames.includes('run_in_terminal'));
    assert.ok(!selected.prioritizedNames.includes('optional_0'));
  });

  test('enforces the exact serialized JSON-array schema budget', () => {
    const tools = Array.from({ length: 97 }, (_, index) => ({
      type: 'function',
      function: {
        name: `tool_${index}`,
        description: 'x'.repeat(80),
        parameters: { type: 'object', properties: { value: { type: 'string' } } },
      },
    }));
    const limited = limitToolsBySchemaTokenBudget(tools, 1024);

    assert.ok(limited.items.length < tools.length);
    assert.equal(limited.serializedTokens, estimateSerializedToolTokens(limited.items));
    assert.ok(limited.serializedTokens <= 1024);
  });

  test('admits pinned and core tools before a large discretionary schema', () => {
    const tools = [
      { name: 'optional_first', description: 'x'.repeat(2000) },
      { name: 'read_file', description: 'Read a repository file.' },
      { name: 'memory', description: 'Recall durable task context.' },
    ];
    const selected = selectToolsForRequest({
      tools,
      maxTools: 10,
      messages: [],
      pinnedToolNames: ['memory'],
      progress,
    });
    const budget = estimateSerializedToolTokens(selected.items.slice(0, 2));
    const limited = limitToolsBySchemaTokenBudget(selected.items, budget);

    assert.deepEqual(selected.prioritizedNames, ['memory', 'read_file', 'optional_first']);
    assert.deepEqual(limited.items.map((tool) => tool.name), ['memory', 'read_file']);
    assert.deepEqual(limited.droppedItems.map((tool) => tool.name), ['optional_first']);
  });

  test('drops a single definition that cannot fit by itself', () => {
    const huge = [{ name: 'huge', description: 'x'.repeat(1000) }];
    const limited = limitToolsBySchemaTokenBudget(huge, 10);
    assert.deepEqual(limited.items, []);
    assert.equal(limited.droppedCount, 1);
  });
});
