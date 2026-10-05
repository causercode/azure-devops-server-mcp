import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runAuthCommand } from '../../src/cli/auth.js';
import type { CredentialStore } from '../../src/ado/credential-store.js';

const target =
  'azure-devops-server-mcp:https://devops.example.test/tfs/DefaultCollection';
const secret = 'pat-never-printed-5d1c';

function harness(input = '', entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  const credentialStore: CredentialStore = {
    get: (name) => store.get(name),
    set: (name, value) => void store.set(name, value),
    delete: (name) => store.delete(name),
  };
  let output = '';
  const io = {
    env: {
      ADO_SERVER_URL: 'https://devops.example.test/tfs',
      ADO_COLLECTION: 'DefaultCollection',
    },
    stdin: Readable.from([Buffer.from(input)]),
    stdout: { write: (text: string) => (output += text) },
    stderr: { write: (text: string) => (output += text) },
    credentialStore: () => credentialStore,
  };
  return { io, store, output: () => output };
}

describe('auth CLI', () => {
  it('stores a piped PAT under the server and collection target without printing it', async () => {
    const { io, store, output } = harness(`${secret}\r\n`);
    expect(await runAuthCommand(['set-token'], io)).toBe(0);
    expect(store.get(target)).toBe(secret);
    expect(output()).toContain(target);
    expect(output()).toContain('ADO_TOKEN_SOURCE=credential-manager');
    expect(output()).not.toContain(secret);
  });

  it('lets flags override the environment', async () => {
    const { io, store } = harness(secret);
    await runAuthCommand(
      [
        'set-token',
        '--server-url',
        'https://other.example.test/',
        '--collection',
        'Team',
      ],
      io,
    );
    expect([...store.keys()]).toEqual([
      'azure-devops-server-mcp:https://other.example.test/Team',
    ]);
    await runAuthCommand(['set-token', '--target', 'custom'], {
      ...io,
      stdin: Readable.from([Buffer.from(secret)]),
    });
    expect(store.get('custom')).toBe(secret);
  });

  it.each(['', 'two words', `line\nbreak`])(
    'rejects an invalid PAT %j without storing or echoing it',
    async (input) => {
      const { io, store, output } = harness(input);
      await expect(runAuthCommand(['set-token'], io)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      expect(store.size).toBe(0);
      if (input) expect(output()).not.toContain(input);
    },
  );

  it('reports presence only, and clears the entry', async () => {
    const { io, store, output } = harness('', { [target]: secret });
    expect(await runAuthCommand(['status'], io)).toBe(0);
    expect(await runAuthCommand(['clear-token'], io)).toBe(0);
    expect(store.size).toBe(0);
    expect(await runAuthCommand(['status'], io)).toBe(1);
    expect(output()).toContain('A PAT is stored');
    expect(output()).toContain('Removed the stored PAT');
    expect(output()).toContain('No PAT is stored');
    expect(output()).not.toContain(secret);
  });

  it.each([
    [['unknown']],
    [['status', '--token', secret]],
    [['status', '--collection']],
  ])('rejects unsupported arguments %j', async (args) => {
    const { io } = harness();
    await expect(runAuthCommand(args, io)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.not.stringContaining(secret),
    });
  });

  it('requires the server location', async () => {
    const { io } = harness(secret);
    await expect(
      runAuthCommand(['set-token'], { ...io, env: {} }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });
});
