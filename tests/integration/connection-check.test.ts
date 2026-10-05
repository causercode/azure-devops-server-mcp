import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MockAdoServer,
  project,
  repository,
  token,
} from '../fixtures/ado-server.js';

describe('read-only workplace connection check', () => {
  let ado: MockAdoServer;
  beforeEach(async () => {
    ado = await new MockAdoServer().start();
  });
  afterEach(async () => {
    await ado.close();
  });

  async function run(extra: NodeJS.ProcessEnv = {}) {
    const child = spawn(
      process.execPath,
      [resolve('scripts/check-connection.mjs')],
      {
        env: {
          PATH: process.env.PATH ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          ADO_SERVER_URL: `${ado.baseUrl}/tfs`,
          ADO_COLLECTION: 'DefaultCollection',
          ADO_TOKEN: token,
          ADO_ALLOWED_REPOSITORIES: JSON.stringify([
            { project: project.id, repository: repository.id },
          ]),
          ...extra,
        },
        // Resolve the server relative to the script, independently of the client's cwd.
        cwd: process.env.TEMP ?? process.cwd(),
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('close', done);
    });
    expect(stdout + stderr).not.toContain(token);
    expect(stdout + stderr).not.toContain(
      Buffer.from(`:${token}`).toString('base64'),
    );
    return { code, stdout, stderr };
  }

  it('checks discovery, repository, branches and PR reads without any writes', async () => {
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      passed: true,
      readOnly: true,
      authType: 'pat',
      writePermissionsTested: false,
      repository: {
        id: repository.id,
        project: { id: project.id, name: project.name },
      },
    });
    expect(result.stderr).toBe('');
    expect(ado.requests.length).toBeGreaterThan(0);
    expect(ado.requests.every((request) => request.method === 'GET')).toBe(
      true,
    );
    expect(ado.pullRequests).toHaveLength(0);
  });

  it.each([undefined, '[]'])(
    'rejects missing or empty scope before connecting (%s)',
    async (scope) => {
      const result = await run({ ADO_ALLOWED_REPOSITORIES: scope });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        passed: false,
        error: { code: 'REPOSITORY_SCOPE_REQUIRED' },
      });
      expect(ado.requests).toHaveLength(0);
    },
  );

  it('reports failed PAT authentication without exposing credentials', async () => {
    const rejectedToken = 'rejected-connection-check-pat';
    const result = await run({ ADO_TOKEN: rejectedToken });
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(rejectedToken);
    expect(result.stdout + result.stderr).not.toContain(
      Buffer.from(`:${rejectedToken}`).toString('base64'),
    );
    expect(JSON.parse(result.stderr)).toMatchObject({
      passed: false,
      stage: 'server_info/get',
      error: { code: 'HTTP_401' },
    });
    expect(ado.requests.every((request) => request.method === 'GET')).toBe(
      true,
    );
  });

  it('returns a safe failure when an allowed repository is unavailable', async () => {
    const result = await run({
      ADO_ALLOWED_REPOSITORIES:
        '[{"project":"Website","repository":"missing"}]',
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      passed: false,
      error: { code: 'HTTP_404' },
    });
    expect(ado.requests.every((request) => request.method === 'GET')).toBe(
      true,
    );
  });
});
