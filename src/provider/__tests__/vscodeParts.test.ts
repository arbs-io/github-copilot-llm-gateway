import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import nodeModule from 'node:module';

/**
 * vscodeParts imports `vscode` at runtime, which only exists inside the
 * extension host. Serve a minimal stand-in with just the part classes and
 * role enum it touches, then load the module under test.
 */
class LanguageModelTextPart {
  constructor(public value: string) {}
}
class LanguageModelToolCallPart {
  constructor(public callId: string, public name: string, public input: object) {}
}
class LanguageModelToolResultPart {
  constructor(public callId: string, public content: unknown[]) {}
}
class LanguageModelDataPart {
  constructor(public data: Uint8Array, public mimeType: string) {}
}
class LanguageModelThinkingPart {
  constructor(
    public value: string | string[],
    public id?: string,
    public metadata?: Record<string, unknown>
  ) {}
}

const fakeVscode = {
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelDataPart,
  LanguageModelThinkingPart,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
};

type ModuleLoad = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = nodeModule as unknown as { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  return request === 'vscode' ? fakeVscode : originalLoad.call(this, request, parent, isMain);
};
// node:test runs each test file in its own process, so the stub can't leak
// into other files; restoring the loader keeps it scoped to this import.
let parts: typeof import('../vscodeParts');
try {
  parts = require('../vscodeParts') as typeof import('../vscodeParts');
} finally {
  moduleWithLoad._load = originalLoad;
}

const noLog = (): void => {
  /* no-op */
};

type ChatMessage = Parameters<typeof parts.countMessageTokens>[0];
function message(role: number, content: unknown[]): ChatMessage {
  return { role, content, name: undefined } as unknown as ChatMessage;
}

describe('classifyPart thinking parts', () => {
  test('classifies a string thinking part', () => {
    assert.deepEqual(parts.classifyPart(new LanguageModelThinkingPart('plan', 'r1'), noLog), {
      kind: 'thinking',
      value: 'plan',
    });
  });

  test('joins a string[] thinking value', () => {
    assert.deepEqual(parts.classifyPart(new LanguageModelThinkingPart(['a', 'b'], ''), noLog), {
      kind: 'thinking',
      value: 'ab',
    });
  });

  test('classifies the empty done marker as empty thinking', () => {
    const done = new LanguageModelThinkingPart('', '', { vscode_reasoning_done: true });
    assert.deepEqual(parts.classifyPart(done, noLog), { kind: 'thinking', value: '' });
  });

  test('recognises a thinking part by shape when the class does not match', () => {
    assert.deepEqual(parts.classifyPart({ value: 'plan', id: 'r1', metadata: undefined }, noLog), {
      kind: 'thinking',
      value: 'plan',
    });
  });

  test('still classifies text parts as text', () => {
    assert.deepEqual(parts.classifyPart(new LanguageModelTextPart('hi'), noLog), {
      kind: 'text',
      value: 'hi',
    });
  });
});

describe('convertAllMessages reasoning replay', () => {
  const history = [
    message(2, [
      new LanguageModelThinkingPart('look it up'),
      new LanguageModelToolCallPart('c1', 'search', { q: 'x' }),
      new LanguageModelThinkingPart('', '', { vscode_reasoning_done: true }),
    ]),
  ];

  test('sends reasoning_content when enabled', () => {
    const [msg] = parts.convertAllMessages(
      history,
      { enableImageInput: false, replayReasoning: true },
      noLog
    );
    assert.equal(msg.reasoning_content, 'look it up');
  });

  test('omits it when disabled', () => {
    const [msg] = parts.convertAllMessages(
      history,
      { enableImageInput: false, replayReasoning: false },
      noLog
    );
    assert.equal('reasoning_content' in msg, false);
  });
});

describe('countMessageTokens', () => {
  const msg = message(2, [
    new LanguageModelTextPart('abcd'),
    new LanguageModelThinkingPart('t'.repeat(40)),
  ]);

  test('ignores thinking parts when replay is off', () => {
    assert.equal(parts.countMessageTokens(msg), 1);
    assert.equal(parts.countMessageTokens(msg, false), 1);
  });

  test('counts thinking parts when replay is on', () => {
    assert.equal(parts.countMessageTokens(msg, true), 11);
  });

  test('ignores thinking parts on user messages even when replay is on', () => {
    const userMsg = message(1, [
      new LanguageModelTextPart('abcd'),
      new LanguageModelThinkingPart('t'.repeat(40)),
    ]);
    assert.equal(parts.countMessageTokens(userMsg, true), 1);
  });
});
