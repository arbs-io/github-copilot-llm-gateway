import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { IncrementalStreamParser, StreamLimitError } from '../streamParser';

describe('IncrementalStreamParser', () => {
  test('reassembles split SSE records and accepts data fields without a space', () => {
    const parser = new IncrementalStreamParser();

    assert.deepEqual(parser.push('data:{"choices":[{"delta":{"content":"hel'), []);
    assert.deepEqual(
      parser.push('lo"}}]}\r\n\r\n'),
      [{
        data: '{"choices":[{"delta":{"content":"hello"}}]}',
        done: false,
      }]
    );
  });

  test('joins multiline SSE data fields', () => {
    const parser = new IncrementalStreamParser();
    const records = parser.push('event: message\ndata: {"one":1,\ndata: "two":2}\n\n');

    assert.deepEqual(records, [{ data: '{"one":1,\n"two":2}', done: false }]);
  });

  test('accepts raw NDJSON and a raw done sentinel', () => {
    const parser = new IncrementalStreamParser();
    const records = parser.push('{"response":"one","done":false}\n{"response":"two","done":true}\n[DONE]\n');

    assert.deepEqual(records, [
      { data: '{"response":"one","done":false}', done: false },
      { data: '{"response":"two","done":true}', done: false },
      { data: '[DONE]', done: true },
    ]);
  });

  test('flushes a final record without a newline', () => {
    const parser = new IncrementalStreamParser();
    assert.deepEqual(parser.push('data: {"choices":[]}'), []);
    assert.deepEqual(parser.flush(), [{ data: '{"choices":[]}', done: false }]);
  });

  test('ignores SSE comments and metadata fields', () => {
    const parser = new IncrementalStreamParser();
    const records = parser.push(': heartbeat\nid: 7\nretry: 1000\ndata: [DONE]\n\n');

    assert.deepEqual(records, [{ data: '[DONE]', done: true }]);
  });

  test('rejects an oversized unterminated buffer with a typed failure', () => {
    const parser = new IncrementalStreamParser({
      maxBufferCharacters: 8,
      maxLineCharacters: 32,
      maxEventCharacters: 32,
      maxEventDataLines: 4,
      maxRecordCharacters: 32,
      maxRecordsPerPush: 4,
      maxTotalRecords: 8,
      maxTotalCharacters: 64,
    });

    assert.throws(
      () => parser.push('123456789'),
      (error: unknown) =>
        error instanceof StreamLimitError &&
        error.code === 'STREAM_LIMIT_EXCEEDED' &&
        error.kind === 'buffer'
    );
  });

  test('rejects oversized multiline SSE events and total stream input', () => {
    const eventParser = new IncrementalStreamParser({
      maxBufferCharacters: 32,
      maxLineCharacters: 32,
      maxEventCharacters: 7,
      maxEventDataLines: 4,
      maxRecordCharacters: 32,
      maxRecordsPerPush: 4,
      maxTotalRecords: 8,
      maxTotalCharacters: 64,
    });
    assert.throws(
      () => eventParser.push('data: 1234\ndata: 5678\n'),
      (error: unknown) => error instanceof StreamLimitError && error.kind === 'event'
    );

    const totalParser = new IncrementalStreamParser({
      maxBufferCharacters: 32,
      maxLineCharacters: 32,
      maxEventCharacters: 32,
      maxEventDataLines: 4,
      maxRecordCharacters: 32,
      maxRecordsPerPush: 4,
      maxTotalRecords: 8,
      maxTotalCharacters: 7,
    });
    assert.throws(
      () => totalParser.push('{}\n{}\n{}'),
      (error: unknown) => error instanceof StreamLimitError && error.kind === 'total'
    );
  });
});
