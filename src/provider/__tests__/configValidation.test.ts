import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  FALLBACK_SERVER_URL,
  MAX_REQUEST_TIMEOUT_MS,
  validateGatewayConfig,
} from '../configValidation';
import { GatewayConfig } from '../../config/gatewayConfig';
import { TOKEN_CONSTANTS } from '../../chat/tokenBudget';

function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    serverUrl: 'http://localhost:8000',
    apiKey: '',
    requestTimeout: 60000,
    defaultMaxTokens: 128000,
    defaultMaxOutputTokens: 4096,
    enableImageInput: true,
    enableToolCalling: true,
    parallelToolCalling: true,
    agentTemperature: 0,
    verboseLogging: false,
    customHeaders: {},
    extraModelOptions: {},
    perModelOptions: {},
    modelContextWindows: {},
    enableInlineCompletion: false,
    inlineCompletionModel: '',
    inlineCompletionMaxTokens: 256,
    inlineCompletionDebounce: 300,
    inlineCompletionTimeout: 3000,
    inlineCompletionMaxPrefixChars: 4000,
    inlineCompletionMaxSuffixChars: 1000,
    ...overrides,
  };
}

describe('validateGatewayConfig', () => {
  test('passes a valid config through unchanged with no issues', () => {
    const raw = baseConfig();
    const { config, issues } = validateGatewayConfig(raw);
    assert.deepEqual(config, raw);
    assert.deepEqual(issues, []);
  });

  test('does not mutate the input config', () => {
    const raw = baseConfig({ requestTimeout: -5 });
    validateGatewayConfig(raw);
    assert.equal(raw.requestTimeout, -5);
  });

  test('replaces a non-positive requestTimeout with the default', () => {
    const { config, issues } = validateGatewayConfig(baseConfig({ requestTimeout: 0 }));
    assert.equal(config.requestTimeout, DEFAULT_REQUEST_TIMEOUT_MS);
    assert.deepEqual(issues, [{ kind: 'invalidRequestTimeout', value: 0 }]);
  });

  test('clamps requestTimeout above the int32 setTimeout limit', () => {
    const huge = MAX_REQUEST_TIMEOUT_MS + 1;
    const { config, issues } = validateGatewayConfig(baseConfig({ requestTimeout: huge }));
    assert.equal(config.requestTimeout, MAX_REQUEST_TIMEOUT_MS);
    assert.deepEqual(issues, [{ kind: 'requestTimeoutClamped', value: huge }]);
  });

  test('falls back to localhost on an unparseable server URL', () => {
    const { config, issues } = validateGatewayConfig(baseConfig({ serverUrl: 'not a url' }));
    assert.equal(config.serverUrl, FALLBACK_SERVER_URL);
    assert.deepEqual(issues, [{ kind: 'invalidServerUrl', url: 'not a url' }]);
  });

  test('adjusts defaultMaxOutputTokens when it meets or exceeds defaultMaxTokens', () => {
    const { config, issues } = validateGatewayConfig(
      baseConfig({ defaultMaxTokens: 8000, defaultMaxOutputTokens: 8000 })
    );
    const expected = Math.max(
      TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS,
      8000 - TOKEN_CONSTANTS.ADJUST_TOKEN_BUFFER
    );
    assert.equal(config.defaultMaxOutputTokens, expected);
    assert.deepEqual(issues, [
      { kind: 'outputTokensAdjusted', output: 8000, total: 8000, adjusted: expected },
    ]);
  });

  test('never adjusts output tokens below the minimum', () => {
    const { config } = validateGatewayConfig(
      baseConfig({ defaultMaxTokens: 10, defaultMaxOutputTokens: 10 })
    );
    assert.equal(config.defaultMaxOutputTokens, TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS);
  });

  test('collects multiple issues in one pass', () => {
    const { issues } = validateGatewayConfig(
      baseConfig({
        serverUrl: '::bad::',
        requestTimeout: -1,
        defaultMaxTokens: 4096,
        defaultMaxOutputTokens: 5000,
      })
    );
    assert.deepEqual(
      issues.map((i) => i.kind).sort(),
      ['invalidRequestTimeout', 'invalidServerUrl', 'outputTokensAdjusted']
    );
  });
});
