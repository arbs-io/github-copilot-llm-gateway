import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateToolResultContent } from '../toolResults';

test('tool-result truncation preserves head and tail within the cap', () => {
  const content = `HEAD-${'x'.repeat(500)}-TAIL`;
  const result = truncateToolResultContent(content, 160);
  assert.equal(result.wasTruncated, true);
  assert.ok(result.content.startsWith('HEAD-'));
  assert.ok(result.content.endsWith('-TAIL'));
  assert.ok(result.content.includes('LLM Gateway omitted'));
  assert.ok(result.content.length <= 160);
  assert.equal(result.omittedCharacters, content.length - (
    result.content.indexOf('\n\n[LLM Gateway') +
    (result.content.length - result.content.lastIndexOf('\n\n') - 2)
  ));
});
