import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfigurationTarget,
  LegacyConfigAccessor,
  SECRET_KEYS,
  SecretAccessor,
  formatMigrationToast,
  migrateLegacySecrets,
  parseCustomHeadersJson,
} from '../secretMigration';

/** Plain-object stand-in for vscode.WorkspaceConfiguration. */
class FakeConfig implements LegacyConfigAccessor {
  private workspace: Record<string, unknown> = {};
  private global: Record<string, unknown> = {};

  setWorkspace(section: string, value: unknown): void {
    this.workspace[section] = value;
  }

  setGlobal(section: string, value: unknown): void {
    this.global[section] = value;
  }

  get<T>(section: string, defaultValue: T): T {
    if (Object.prototype.hasOwnProperty.call(this.workspace, section)) {
      return this.workspace[section] as T;
    }
    if (Object.prototype.hasOwnProperty.call(this.global, section)) {
      return this.global[section] as T;
    }
    return defaultValue;
  }

  inspect<T>(section: string): { workspaceValue?: T; globalValue?: T } | undefined {
    return {
      workspaceValue: Object.prototype.hasOwnProperty.call(this.workspace, section)
        ? (this.workspace[section] as T)
        : undefined,
      globalValue: Object.prototype.hasOwnProperty.call(this.global, section)
        ? (this.global[section] as T)
        : undefined,
    };
  }

  async update(section: string, value: unknown, target: ConfigurationTarget): Promise<void> {
    const bag = target === ConfigurationTarget.Workspace ? this.workspace : this.global;
    if (value === undefined) {
      delete bag[section];
    } else {
      bag[section] = value;
    }
  }

  /** Inspect the underlying state from a test (escape hatch). */
  rawWorkspace(section: string): unknown {
    return this.workspace[section];
  }

  rawGlobal(section: string): unknown {
    return this.global[section];
  }
}

class FakeSecrets implements SecretAccessor {
  private readonly store_: Map<string, string> = new Map();

  async get(key: string): Promise<string | undefined> {
    return this.store_.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.store_.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store_.delete(key);
  }

  /** Inspect the underlying state from a test (escape hatch). */
  raw(key: string): string | undefined {
    return this.store_.get(key);
  }
}

describe('parseCustomHeadersJson', () => {
  test('returns empty object for undefined or empty input', () => {
    assert.deepEqual(parseCustomHeadersJson(undefined), {});
    assert.deepEqual(parseCustomHeadersJson(''), {});
  });

  test('parses a JSON object of string headers', () => {
    const result = parseCustomHeadersJson('{"Authorization":"Bearer x","HTTP-Referer":"https://a"}');
    assert.deepEqual(result, { Authorization: 'Bearer x', 'HTTP-Referer': 'https://a' });
  });

  test('drops entries with non-string values', () => {
    const result = parseCustomHeadersJson('{"A":"x","B":42,"C":null,"D":true}');
    assert.deepEqual(result, { A: 'x' });
  });

  test('drops entries with empty names', () => {
    const result = parseCustomHeadersJson('{"":"x","B":"y"}');
    assert.deepEqual(result, { B: 'y' });
  });

  test('returns empty object for malformed JSON without throwing', () => {
    let logged = '';
    const result = parseCustomHeadersJson('not json', (msg) => { logged = msg; });
    assert.deepEqual(result, {});
    assert.ok(logged.includes('Failed to parse'));
  });

  test('returns empty object when JSON is not an object', () => {
    assert.deepEqual(parseCustomHeadersJson('"a string"'), {});
    assert.deepEqual(parseCustomHeadersJson('[1,2]'), {});
    assert.deepEqual(parseCustomHeadersJson('null'), {});
  });
});

describe('migrateLegacySecrets', () => {
  test('is a no-op when no legacy values are present', async () => {
    const config = new FakeConfig();
    const secrets = new FakeSecrets();
    const result = await migrateLegacySecrets(config, secrets);
    assert.deepEqual(result, { apiKeyMigrated: false, customHeadersMigrated: false });
    assert.equal(secrets.raw(SECRET_KEYS.apiKey), undefined);
    assert.equal(secrets.raw(SECRET_KEYS.customHeaders), undefined);
  });

  test('moves a legacy apiKey into secrets and clears the setting', async () => {
    const config = new FakeConfig();
    config.setGlobal('apiKey', 'sk-secret');
    const secrets = new FakeSecrets();

    const result = await migrateLegacySecrets(config, secrets);

    assert.equal(result.apiKeyMigrated, true);
    assert.equal(secrets.raw(SECRET_KEYS.apiKey), 'sk-secret');
    assert.equal(config.rawGlobal('apiKey'), undefined);
  });

  test('moves a legacy customHeaders object into secrets and clears the setting', async () => {
    const config = new FakeConfig();
    config.setGlobal('customHeaders', { Authorization: 'Bearer xyz', 'HTTP-Referer': 'https://a' });
    const secrets = new FakeSecrets();

    const result = await migrateLegacySecrets(config, secrets);

    assert.equal(result.customHeadersMigrated, true);
    const stored = secrets.raw(SECRET_KEYS.customHeaders);
    assert.ok(stored);
    assert.deepEqual(JSON.parse(stored ?? ''), {
      Authorization: 'Bearer xyz',
      'HTTP-Referer': 'https://a',
    });
    assert.equal(config.rawGlobal('customHeaders'), undefined);
  });

  test('clears the legacy setting from both workspace and global scopes', async () => {
    const config = new FakeConfig();
    config.setWorkspace('apiKey', 'workspace-key');
    config.setGlobal('apiKey', 'global-key');
    const secrets = new FakeSecrets();

    await migrateLegacySecrets(config, secrets);

    assert.equal(config.rawWorkspace('apiKey'), undefined);
    assert.equal(config.rawGlobal('apiKey'), undefined);
    // Workspace value is what `get` returns when set, so that's the one that got captured.
    assert.equal(secrets.raw(SECRET_KEYS.apiKey), 'workspace-key');
  });

  test('does not overwrite an existing secret', async () => {
    const config = new FakeConfig();
    config.setGlobal('apiKey', 'plain-text-key');
    const secrets = new FakeSecrets();
    await secrets.store(SECRET_KEYS.apiKey, 'already-stored');

    const result = await migrateLegacySecrets(config, secrets);

    assert.equal(result.apiKeyMigrated, false);
    assert.equal(secrets.raw(SECRET_KEYS.apiKey), 'already-stored');
    // Legacy setting is still cleared because the value is safely captured elsewhere.
    assert.equal(config.rawGlobal('apiKey'), undefined);
  });

  test('treats whitespace-only apiKey as empty (does not migrate)', async () => {
    const config = new FakeConfig();
    config.setGlobal('apiKey', '   ');
    const secrets = new FakeSecrets();

    const result = await migrateLegacySecrets(config, secrets);

    assert.equal(result.apiKeyMigrated, false);
    assert.equal(secrets.raw(SECRET_KEYS.apiKey), undefined);
  });

  test('treats empty customHeaders object as empty (does not migrate)', async () => {
    const config = new FakeConfig();
    config.setGlobal('customHeaders', {});
    const secrets = new FakeSecrets();

    const result = await migrateLegacySecrets(config, secrets);

    assert.equal(result.customHeadersMigrated, false);
    assert.equal(secrets.raw(SECRET_KEYS.customHeaders), undefined);
  });

  test('migrates both apiKey and customHeaders in one run', async () => {
    const config = new FakeConfig();
    config.setGlobal('apiKey', 'sk-secret');
    config.setGlobal('customHeaders', { 'X-Org': 'acme' });
    const secrets = new FakeSecrets();

    const result = await migrateLegacySecrets(config, secrets);

    assert.deepEqual(result, { apiKeyMigrated: true, customHeadersMigrated: true });
    assert.equal(secrets.raw(SECRET_KEYS.apiKey), 'sk-secret');
    assert.ok(secrets.raw(SECRET_KEYS.customHeaders));
  });

  test('logs each migration step', async () => {
    const config = new FakeConfig();
    config.setGlobal('apiKey', 'sk-secret');
    config.setGlobal('customHeaders', { X: 'y' });
    const secrets = new FakeSecrets();
    const messages: string[] = [];

    await migrateLegacySecrets(config, secrets, (m) => messages.push(m));

    assert.ok(messages.some((m) => m.includes('apiKey')));
    assert.ok(messages.some((m) => m.includes('customHeaders')));
  });
});

describe('formatMigrationToast', () => {
  test('returns undefined when nothing was migrated', () => {
    assert.equal(
      formatMigrationToast({ apiKeyMigrated: false, customHeadersMigrated: false }),
      undefined
    );
  });

  test('mentions only what was migrated', () => {
    assert.match(
      formatMigrationToast({ apiKeyMigrated: true, customHeadersMigrated: false }) ?? '',
      /API key/
    );
    assert.doesNotMatch(
      formatMigrationToast({ apiKeyMigrated: true, customHeadersMigrated: false }) ?? '',
      /custom headers/
    );
  });

  test('joins both items with "and" when both migrated', () => {
    const message = formatMigrationToast({ apiKeyMigrated: true, customHeadersMigrated: true });
    assert.match(message ?? '', /API key and custom headers/);
  });
});
