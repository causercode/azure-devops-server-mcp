import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config.js';
const env = {
  ADO_SERVER_URL: 'https://example.invalid',
  ADO_COLLECTION: 'Collection',
  ADO_TOKEN: 'offline-secret',
};
describe('process-owned build authorization', () => {
  it('leaves queue scopes denied when absent and allows independently configured selectors', () => {
    expect(loadConfig(env).buildWriteDefinitions).toBeUndefined();
    expect(
      loadConfig({
        ...env,
        ADO_BUILD_WRITE_REPOSITORIES:
          '[{"project":"Project","repository":"Repo"}]',
        ADO_BUILD_WRITE_DEFINITIONS: '[7]',
      }),
    ).toMatchObject({
      buildWriteRepositories: [{ project: 'Project', repository: 'Repo' }],
      buildWriteDefinitions: [7],
    });
  });
  it.each([
    { ADO_BUILD_WRITE_REPOSITORIES: '*' },
    { ADO_BUILD_WRITE_REPOSITORIES: '[{"project":"*","repository":"Repo"}]' },
    {
      ADO_BUILD_WRITE_REPOSITORIES:
        '[{"project":"Project","repository":"Repo","write":true}]',
    },
    { ADO_BUILD_WRITE_DEFINITIONS: '[0]' },
    { ADO_BUILD_WRITE_DEFINITIONS: '[2147483648]' },
    { ADO_BUILD_WRITE_DEFINITIONS: '["7"]' },
    { ADO_BUILD_WRITE_DEFINITIONS: '[7.5]' },
  ])('fails closed for malformed scopes %#', (bad) => {
    expect(() => loadConfig({ ...env, ...bad })).toThrow('ADO_BUILD_WRITE');
    try {
      loadConfig({ ...env, ...bad });
    } catch (e) {
      expect(String(e)).not.toContain(env.ADO_TOKEN);
    }
  });
});
