import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPLETION_TEMPERATURE,
  DEFAULT_MAX_PREFIX_CHARS,
  DEFAULT_MAX_SUFFIX_CHARS,
  buildCompletionRequestBody,
  cleanCompletionText,
  extractCompletionText,
  extractFimContext,
  isSuffixUnsupportedError,
  shouldRequestCompletion,
} from '../inlineCompletion';

describe('extractFimContext', () => {
  test('passes through text under the budget unchanged', () => {
    const ctx = extractFimContext('abc', 'def');
    assert.deepEqual(ctx, { prefix: 'abc', suffix: 'def' });
  });

  test('keeps the tail of an over-long prefix (code nearest the cursor)', () => {
    const before = 'x'.repeat(DEFAULT_MAX_PREFIX_CHARS) + 'TAIL';
    const ctx = extractFimContext(before, '');
    assert.equal(ctx.prefix.length, DEFAULT_MAX_PREFIX_CHARS);
    assert.ok(ctx.prefix.endsWith('TAIL'));
  });

  test('keeps the head of an over-long suffix (code nearest the cursor)', () => {
    const after = 'HEAD' + 'y'.repeat(DEFAULT_MAX_SUFFIX_CHARS);
    const ctx = extractFimContext('', after);
    assert.equal(ctx.suffix.length, DEFAULT_MAX_SUFFIX_CHARS);
    assert.ok(ctx.suffix.startsWith('HEAD'));
  });
});

describe('shouldRequestCompletion', () => {
  test('false for a fully empty context', () => {
    assert.equal(shouldRequestCompletion({ prefix: '', suffix: '' }), false);
  });

  test('false when only whitespace surrounds the cursor', () => {
    assert.equal(shouldRequestCompletion({ prefix: '', suffix: '   \n' }), false);
  });

  test('true when there is a prefix', () => {
    assert.equal(shouldRequestCompletion({ prefix: 'const x =', suffix: '' }), true);
  });

  test('true when there is a meaningful suffix', () => {
    assert.equal(shouldRequestCompletion({ prefix: '', suffix: 'return x;' }), true);
  });
});

describe('buildCompletionRequestBody', () => {
  test('builds a FIM request with prompt + suffix', () => {
    const req = buildCompletionRequestBody({
      model: 'code-model',
      context: { prefix: 'def add(a, b):\n    return ', suffix: '\n\nprint(add(1, 2))' },
      maxTokens: 128,
    });
    assert.equal(req.model, 'code-model');
    assert.equal(req.prompt, 'def add(a, b):\n    return ');
    assert.equal(req.suffix, '\n\nprint(add(1, 2))');
    assert.equal(req.max_tokens, 128);
    assert.equal(req.temperature, COMPLETION_TEMPERATURE);
    assert.equal(req.stream, false);
  });

  test('omits suffix when empty so end-of-file completions still work', () => {
    const req = buildCompletionRequestBody({
      model: 'm',
      context: { prefix: 'tail', suffix: '' },
      maxTokens: 64,
    });
    assert.equal('suffix' in req, false);
  });

  test('omits suffix when includeSuffix is false (server rejects the parameter)', () => {
    const req = buildCompletionRequestBody({
      model: 'm',
      context: { prefix: 'tail', suffix: 'rest of file' },
      maxTokens: 64,
      includeSuffix: false,
    });
    assert.equal('suffix' in req, false);
    assert.equal(req.prompt, 'tail');
  });

  test('keeps suffix when includeSuffix is explicitly true', () => {
    const req = buildCompletionRequestBody({
      model: 'm',
      context: { prefix: 'tail', suffix: 'rest' },
      maxTokens: 64,
      includeSuffix: true,
    });
    assert.equal(req.suffix, 'rest');
  });
});

describe('isSuffixUnsupportedError', () => {
  test('matches the vLLM 400 response verbatim (issue #51)', () => {
    const body =
      '{"error":{"message":"suffix is not currently supported","type":"BadRequestError","param":null,"code":400}}';
    assert.equal(isSuffixUnsupportedError(400, body), true);
  });

  test('matches wording variations that still name suffix as unsupported', () => {
    assert.equal(
      isSuffixUnsupportedError(400, '{"error":"the suffix parameter is not supported"}'),
      true
    );
  });

  test('ignores unrelated 400s', () => {
    assert.equal(
      isSuffixUnsupportedError(400, '{"error":{"message":"model not found"}}'),
      false
    );
    assert.equal(
      isSuffixUnsupportedError(400, '{"error":{"message":"context length exceeded"}}'),
      false
    );
  });

  test('ignores non-400 statuses even if the body mentions suffix', () => {
    assert.equal(
      isSuffixUnsupportedError(500, 'suffix is not currently supported'),
      false
    );
  });
});

describe('extractCompletionText', () => {
  test('pulls text from the first choice', () => {
    assert.equal(extractCompletionText({ choices: [{ text: 'a + b' }] }), 'a + b');
  });

  test('returns empty string when choices is missing', () => {
    assert.equal(extractCompletionText({}), '');
    assert.equal(extractCompletionText(undefined), '');
  });

  test('returns empty string when text is missing or non-string', () => {
    assert.equal(extractCompletionText({ choices: [{}] }), '');
    assert.equal(
      extractCompletionText({ choices: [{ text: 42 as unknown as string }] }),
      ''
    );
  });
});

describe('cleanCompletionText', () => {
  test('drops whitespace-only completions', () => {
    assert.equal(cleanCompletionText('   \n\t'), '');
    assert.equal(cleanCompletionText(''), '');
  });

  test('trims trailing newlines but keeps interior structure', () => {
    assert.equal(cleanCompletionText('foo()\n\n'), 'foo()');
    assert.equal(cleanCompletionText('if (x) {\n  y();\n}'), 'if (x) {\n  y();\n}');
  });

  test('preserves leading whitespace (indentation)', () => {
    assert.equal(cleanCompletionText('    return x'), '    return x');
  });
});
