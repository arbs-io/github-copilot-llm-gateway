import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TOOL_ARGUMENT_DEPTH,
  MAX_TOOL_ARGUMENT_NODES,
  prepareToolArguments,
  prepareToolCallBatch,
} from '../toolArguments';

const schema = {
  type: 'object',
  required: ['path', 'options'],
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    mode: { type: 'string', default: 'read' },
    options: {
      type: 'object',
      required: ['recursive'],
      properties: { recursive: { type: 'boolean' } },
    },
  },
};

describe('strict tool argument preparation', () => {
  test('rejects malformed JSON and missing required arguments', () => {
    assert.match(prepareToolArguments('{"path":', schema).error ?? '', /valid JSON object/);
    assert.match(prepareToolArguments('{"path":"a"}', schema).error ?? '', /options/);
  });

  test('validates nested types and applies only explicit defaults', () => {
    const wrong = prepareToolArguments(
      '{"path":"a","options":{"recursive":"yes"}}',
      schema
    );
    assert.match(wrong.error ?? '', /recursive.*boolean/);

    const valid = prepareToolArguments(
      '{"path":"a","options":{"recursive":true}}',
      schema
    );
    assert.deepEqual(valid.value, {
      path: 'a',
      options: { recursive: true },
    });
  });

  test('rejects an unknown call transactionally before returning any calls', () => {
    const schemas = new Map<string, Record<string, unknown> | undefined>([
      ['known', { type: 'object' }],
    ]);
    const prepared = prepareToolCallBatch([
      { id: '1', name: 'known', arguments: '{}' },
      { id: '2', name: 'not_selected', arguments: '{}' },
    ], schemas);

    assert.ok(prepared.error);
    assert.equal(prepared.calls, undefined);
    assert.match(prepared.error?.reason ?? '', /not selected/);
  });

  test('rejects prototype-polluting schema property names and nested defaults', () => {
    const unsafeRequired = JSON.parse(
      '{"type":"object","required":["__proto__"],"properties":{"__proto__":{"default":{"polluted":true}}}}'
    ) as Record<string, unknown>;
    assert.match(
      prepareToolArguments('{}', unsafeRequired).error ?? '',
      /unsafe object key|unsafe schema property/
    );

    const unsafeDefault = JSON.parse(
      '{"type":"object","required":["options"],"properties":{"options":{"type":"object","default":{"constructor":{"prototype":{"polluted":true}}}}}}'
    ) as Record<string, unknown>;
    assert.match(
      prepareToolArguments('{}', unsafeDefault).error ?? '',
      /unsafe object key/
    );
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  });

  test('rejects altered prototypes and accessors without invoking getters or toJSON', () => {
    const alteredPrototype = {
      type: 'object',
      properties: { path: { type: 'string' } },
    };
    Object.setPrototypeOf(alteredPrototype, { malicious: true });
    assert.match(
      prepareToolArguments('{"path":"safe"}', alteredPrototype).error ?? '',
      /non-plain object/
    );

    let invoked = false;
    const properties: Record<string, unknown> = {};
    Object.defineProperty(properties, 'path', {
      enumerable: true,
      get: () => {
        invoked = true;
        throw new Error('must not run');
      },
    });
    const accessorSchema = { type: 'object', properties };
    assert.match(
      prepareToolArguments('{"path":"safe"}', accessorSchema).error ?? '',
      /accessor/
    );
    assert.equal(invoked, false);

    const defaultWithHook = {
      toJSON: () => {
        invoked = true;
        return { secret: true };
      },
    };
    const hookSchema = {
      type: 'object',
      required: ['options'],
      properties: {
        options: { type: 'object', default: defaultWithHook },
      },
    };
    assert.match(
      prepareToolArguments('{}', hookSchema).error ?? '',
      /unsafe object key/
    );
    assert.equal(invoked, false);
  });

  test('rejects excessively deep arguments and oversized node graphs without overflowing', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < MAX_TOOL_ARGUMENT_DEPTH + 2; index++) {
      deep = { child: deep };
    }
    assert.match(
      prepareToolArguments(JSON.stringify(deep)).error ?? '',
      /maximum nesting depth/
    );

    const wide = {
      values: Array.from({ length: MAX_TOOL_ARGUMENT_NODES + 1 }, () => 0),
    };
    assert.match(
      prepareToolArguments(JSON.stringify(wide)).error ?? '',
      /maximum node count/
    );
  });
});
