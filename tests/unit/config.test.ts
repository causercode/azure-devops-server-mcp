import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { PatAuthProvider, createSecretRedactor } from '../../src/ado/auth.js';

const env = {
  ADO_SERVER_URL: 'https://devops.example.test/tfs/',
  ADO_COLLECTION: 'Default Collection',
  ADO_TOKEN: 'a-test-secret',
};

describe('configuration and authentication', () => {
  it('normalizes the server URL, defaults to REST 7.0 and leaves project optional', () => {
    expect(loadConfig(env)).toEqual({
      serverUrl: 'https://devops.example.test/tfs',
      collection: 'Default Collection',
      authType: 'pat',
      token: 'a-test-secret',
      apiVersion: '7.0',
      timeoutMs: 30000,
    });
  });

  it('accepts an explicit project, API version and timeout', () => {
    expect(
      loadConfig({
        ...env,
        ADO_PROJECT: ' Website ',
        ADO_API_VERSION: '6.0',
        ADO_TIMEOUT_MS: '1500',
      }),
    ).toMatchObject({ project: 'Website', apiVersion: '6.0', timeoutMs: 1500 });
  });

  it.each([
    ['ADO_SERVER_URL', ''],
    ['ADO_SERVER_URL', 'not-a-url'],
    ['ADO_SERVER_URL', 'ftp://server/tfs'],
    ['ADO_SERVER_URL', 'https://user:secret@server/tfs'],
    ['ADO_SERVER_URL', 'https://server/tfs?secret=yes'],
    ['ADO_SERVER_URL', 'https://server/tfs#secret'],
    ['ADO_COLLECTION', ''],
    ['ADO_COLLECTION', '..'],
    ['ADO_COLLECTION', 'one/two'],
    ['ADO_COLLECTION', 'one\\two'],
    ['ADO_TOKEN', ''],
    ['ADO_TOKEN', 'bad\r\ntoken'],
    ['ADO_AUTH_TYPE', 'ntlm'],
    ['ADO_API_VERSION', '8.0'],
    ['ADO_TIMEOUT_MS', '0'],
    ['ADO_TIMEOUT_MS', 'Infinity'],
    ['ADO_TIMEOUT_MS', '120001'],
    ['ADO_TIMEOUT_MS', '1e3'],
  ])(
    'rejects invalid %s without echoing configuration values',
    (key, value) => {
      expect(() => loadConfig({ ...env, [key]: value })).toThrow();
      try {
        loadConfig({ ...env, [key]: value });
      } catch (error) {
        expect(String(error)).not.toContain(env.ADO_TOKEN);
        expect(String(error)).not.toContain('user:secret');
      }
    },
  );

  it('uses Basic PAT authentication with an empty username', async () => {
    const auth = new PatAuthProvider(env.ADO_TOKEN);
    expect(await auth.getHeaders()).toEqual({
      Authorization: `Basic ${Buffer.from(`:${env.ADO_TOKEN}`).toString('base64')}`,
    });
    expect(JSON.stringify(auth)).not.toContain(env.ADO_TOKEN);
  });

  it('parses explicit repository scope and preserves an empty deny-all list', () => {
    expect(
      loadConfig({
        ...env,
        ADO_ALLOWED_REPOSITORIES:
          '[{"project":" Website ","repository":" intranet "}]',
      }).allowedRepositories,
    ).toEqual([{ project: 'Website', repository: 'intranet' }]);
    expect(
      loadConfig({ ...env, ADO_ALLOWED_REPOSITORIES: '[]' })
        .allowedRepositories,
    ).toEqual([]);
    expect(loadConfig(env).allowedRepositories).toBeUndefined();
  });

  it.each([
    '',
    'not JSON',
    '{}',
    'null',
    '["intranet"]',
    '[{"repository":"intranet"}]',
    '[{"project":"Website","repository":"*"}]',
    '[{"project":"..","repository":"intranet"}]',
    '[{"project":"Website","repository":"intranet","allowAll":true}]',
    JSON.stringify(
      Array.from({ length: 101 }, () => ({
        project: 'Website',
        repository: 'intranet',
      })),
    ),
  ])('rejects invalid scope %s without echoing its value', (scope) => {
    expect(() =>
      loadConfig({ ...env, ADO_ALLOWED_REPOSITORIES: scope }),
    ).toThrow('ADO_ALLOWED_REPOSITORIES must be a JSON array');
  });

  it('redacts raw, URL-encoded, JSON-escaped, and Basic-encoded secrets', () => {
    const secret = 'secret"\\+with-characters';
    const redact = createSecretRedactor(secret);
    for (const value of [
      secret,
      encodeURIComponent(secret),
      Buffer.from(`:${secret}`).toString('base64'),
      JSON.stringify(secret),
    ]) {
      expect(redact(value)).toContain('[REDACTED]');
      expect(redact(value)).not.toContain(secret);
    }
  });
});
