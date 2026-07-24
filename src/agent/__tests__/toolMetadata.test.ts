import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolResult } from '../toolMetadata';

test('tool-result summaries extract paths without treating URLs as workspace files', () => {
  const digest = summarizeToolResult(
    'read_file',
    'Read /workspace/src/main.ts and ignored https://example.test/private/data.json successfully.',
    500
  );

  assert.equal(digest.path, '/workspace/src/main.ts');
  assert.match(digest.summary, /^read_file: paths=\/workspace\/src\/main\.ts preview=/);
});
