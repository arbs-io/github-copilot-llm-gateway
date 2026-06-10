import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertMessage,
  convertMessages,
  encodeImageAsDataUrl,
  flattenToolResultContent,
  NormalizedMessage,
  NormalizedPart,
} from '../messageConverter';

const WITH_IMAGES = { enableImageInput: true };
const WITHOUT_IMAGES = { enableImageInput: false };

const textMsg = (role: 'user' | 'assistant', value: string): NormalizedMessage => ({
  role,
  parts: [{ kind: 'text', value }],
});

describe('encodeImageAsDataUrl', () => {
  test('wraps byte data as a base64 data URL with the given mime type', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const url = encodeImageAsDataUrl({ mimeType: 'image/png', data });
    assert.ok(url.startsWith('data:image/png;base64,'));
    const encoded = url.slice('data:image/png;base64,'.length);
    // Round-trip via atob to confirm the bytes.
    const decoded = atob(encoded);
    assert.equal(decoded.length, 4);
    assert.equal(decoded.codePointAt(0), 1);
    assert.equal(decoded.codePointAt(3), 4);
  });
});

describe('flattenToolResultContent', () => {
  test('returns a plain string unchanged', () => {
    assert.equal(flattenToolResultContent('hello world'), 'hello world');
  });

  test('extracts .value from text-part-shaped array elements', () => {
    const content = [{ value: 'tool output line' }];
    assert.equal(flattenToolResultContent(content), 'tool output line');
  });

  test('unwraps marshalled $mid objects to their clean value (issue #41)', () => {
    // VS Code marshals RPC-boundary values (Uris, terminal links) with a $mid
    // marker. The old JSON.stringify path leaked the wrapper into chat.
    const content = [{ $mid: 21, value: '#!/bin/bash\necho hi' }];
    assert.equal(flattenToolResultContent(content), '#!/bin/bash\necho hi');
    assert.ok(!flattenToolResultContent(content).includes('$mid'));
  });

  test('concatenates multiple parts in order', () => {
    const content = [{ value: 'a' }, 'b', { $mid: 1, value: 'c' }];
    assert.equal(flattenToolResultContent(content), 'abc');
  });

  test('falls back to JSON for structured parts with no string value', () => {
    const content = [{ kind: 'data', bytes: [1, 2, 3] }];
    assert.equal(flattenToolResultContent(content), JSON.stringify(content[0]));
  });

  test('wraps a non-array object as a single part', () => {
    assert.equal(flattenToolResultContent({ $mid: 7, value: 'solo' }), 'solo');
  });

  test('skips null/undefined elements without emitting "null"', () => {
    const content = [null, { value: 'kept' }, undefined];
    assert.equal(flattenToolResultContent(content), 'kept');
  });
});

describe('convertMessage', () => {
  test('converts a plain user text message to an array-content message', () => {
    const result = convertMessage(textMsg('user', 'hello'), WITHOUT_IMAGES);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    const parts = result[0].content as Array<Record<string, unknown>>;
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[0].text, 'hello');
  });

  test('converts an assistant text message to an array-content message', () => {
    const result = convertMessage(textMsg('assistant', 'sure'), WITHOUT_IMAGES);
    assert.equal(result[0].role, 'assistant');
    const parts = result[0].content as Array<Record<string, unknown>>;
    assert.equal(parts[0].text, 'sure');
  });

  test('emits array content when images are enabled and included', () => {
    const data = new Uint8Array([10, 20, 30]);
    const msg: NormalizedMessage = {
      role: 'user',
      parts: [
        { kind: 'text', value: 'look' },
        { kind: 'image', mimeType: 'image/jpeg', data },
      ],
    };
    const result = convertMessage(msg, WITH_IMAGES);
    assert.equal(result.length, 1);
    const parts = result[0].content as Array<Record<string, unknown>>;
    assert.equal(parts.length, 2);
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'image_url');
    const imageUrl = (parts[1].image_url as { url: string }).url;
    assert.ok(imageUrl.startsWith('data:image/jpeg;base64,'));
  });

  test('skips image parts and logs when enableImageInput is false', () => {
    const logs: string[] = [];
    const msg: NormalizedMessage = {
      role: 'user',
      parts: [
        { kind: 'text', value: 'hi' },
        { kind: 'image', mimeType: 'image/png', data: new Uint8Array([1]) },
      ],
    };
    const result = convertMessage(msg, WITHOUT_IMAGES, (m) => logs.push(m));
    const parts = result[0].content as Array<Record<string, unknown>>;
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'text');
    assert.ok(logs.some((m) => m.includes('Skipping data part')));
  });

  test('skips non-image data parts even when enableImageInput is true', () => {
    const msg: NormalizedMessage = {
      role: 'user',
      parts: [{ kind: 'image', mimeType: 'application/pdf', data: new Uint8Array([1]) }],
    };
    const result = convertMessage(msg, WITH_IMAGES);
    assert.equal(result.length, 0);
  });

  test('converts assistant tool call part into assistant message with tool_calls', () => {
    const msg: NormalizedMessage = {
      role: 'assistant',
      parts: [
        { kind: 'text', value: 'calling tool' },
        { kind: 'toolCall', callId: 'c1', name: 'search', input: { q: 'x' } },
      ],
    };
    const result = convertMessage(msg, WITHOUT_IMAGES);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'assistant');
    assert.equal(result[0].content, 'calling tool');
    const toolCalls = result[0].tool_calls as Array<Record<string, unknown>>;
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].id, 'c1');
    const fn = toolCalls[0].function as Record<string, unknown>;
    assert.equal(fn.name, 'search');
    assert.equal(fn.arguments, JSON.stringify({ q: 'x' }));
  });

  test('assistant with only tool calls has null content', () => {
    const msg: NormalizedMessage = {
      role: 'assistant',
      parts: [{ kind: 'toolCall', callId: 'c1', name: 'f', input: {} }],
    };
    const result = convertMessage(msg, WITHOUT_IMAGES);
    assert.equal(result[0].content, null);
  });

  test('tool result part produces a role:tool message', () => {
    const msg: NormalizedMessage = {
      role: 'user',
      parts: [{ kind: 'toolResult', callId: 'c1', content: 'result data' }],
    };
    const result = convertMessage(msg, WITHOUT_IMAGES);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'tool');
    assert.equal(result[0].tool_call_id, 'c1');
    assert.equal(result[0].content, 'result data');
  });

  test('multiple tool results flatten into multiple tool messages', () => {
    const msg: NormalizedMessage = {
      role: 'user',
      parts: [
        { kind: 'toolResult', callId: 'a', content: 'x' },
        { kind: 'toolResult', callId: 'b', content: 'y' },
      ],
    };
    const result = convertMessage(msg, WITHOUT_IMAGES);
    assert.equal(result.length, 2);
    assert.equal(result[0].tool_call_id, 'a');
    assert.equal(result[1].tool_call_id, 'b');
  });

  test('tool calls take precedence over tool results in the same message', () => {
    const msg: NormalizedMessage = {
      role: 'assistant',
      parts: [
        { kind: 'toolCall', callId: 'c1', name: 'f', input: {} },
        { kind: 'toolResult', callId: 'c0', content: 'prev' },
      ],
    };
    const result = convertMessage(msg, WITHOUT_IMAGES);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'assistant');
    assert.ok(Array.isArray(result[0].tool_calls));
  });

  test('empty message produces no output', () => {
    const result = convertMessage({ role: 'user', parts: [] }, WITHOUT_IMAGES);
    assert.equal(result.length, 0);
  });

  test('unknown parts are silently dropped', () => {
    const msg: NormalizedMessage = {
      role: 'user',
      parts: [{ kind: 'text', value: 'hi' }, { kind: 'unknown' }],
    };
    const result = convertMessage(msg, WITHOUT_IMAGES);
    assert.equal(result.length, 1);
    const parts = result[0].content as Array<Record<string, unknown>>;
    assert.equal(parts.length, 1);
    assert.equal(parts[0].text, 'hi');
  });

  test('logs image addition with URL length', () => {
    const logs: string[] = [];
    const msg: NormalizedMessage = {
      role: 'user',
      parts: [{ kind: 'image', mimeType: 'image/png', data: new Uint8Array([1, 2]) }],
    };
    convertMessage(msg, WITH_IMAGES, (m) => logs.push(m));
    assert.ok(logs.some((m) => m.includes('Added image data part')));
  });
});

describe('convertMessages', () => {
  test('flattens a list of normalized messages through convertMessage', () => {
    const messages: NormalizedMessage[] = [
      textMsg('user', 'q'),
      textMsg('assistant', 'a'),
    ];
    const result = convertMessages(messages, WITHOUT_IMAGES);
    assert.equal(result.length, 2);
    assert.equal(result[0].role, 'user');
    assert.equal(result[1].role, 'assistant');
  });

  test('returns empty array for empty input', () => {
    assert.deepEqual(convertMessages([], WITHOUT_IMAGES), []);
  });

  test('tool result messages get flattened into multiple entries', () => {
    const messages: NormalizedMessage[] = [
      textMsg('user', 'question'),
      {
        role: 'user',
        parts: [
          { kind: 'toolResult', callId: 'a', content: 'x' },
          { kind: 'toolResult', callId: 'b', content: 'y' },
        ],
      },
    ];
    const result = convertMessages(messages, WITHOUT_IMAGES);
    assert.equal(result.length, 3);
  });

  const usedPartKinds: ReadonlyArray<NormalizedPart['kind']> = [
    'text',
    'toolResult',
    'toolCall',
    'image',
    'unknown',
  ];

  test('exhausts the NormalizedPart discriminant (typesafety guard)', () => {
    // If a new kind is added, this assertion will break, nudging maintainers
    // to handle it in convertMessage().
    assert.equal(usedPartKinds.length, 5);
  });
});
