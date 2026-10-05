import { describe, expect, it, vi } from 'vitest';
import { AdoClient } from '../../src/ado/client.js';
import { PatAuthProvider } from '../../src/ado/auth.js';
import { loadConfig } from '../../src/config.js';
import { BranchService, normalizeBranch } from '../../src/services/branches.js';
import { RepositoryService } from '../../src/services/repositories.js';
import { repository } from '../fixtures/ado-server.js';

describe('branch names and exact lookup', () => {
  it.each(['feature/foo', 'refs/heads/feature/foo', 'develop'])(
    'normalizes %s',
    (name) => {
      expect(normalizeBranch(name)).toBe(
        name.startsWith('refs/') ? name : `refs/heads/${name}`,
      );
    },
  );

  it.each([
    '',
    'refs/tags/v1',
    'refs/remotes/origin/main',
    '../main',
    'feature..foo',
    '-branch',
    'foo bar',
    'foo:bar',
    'foo\\bar',
    'foo?bar',
    'foo*bar',
    'foo[bar',
    'foo@{bar',
    '.foo',
    'foo/.bar',
    'foo.lock',
    'foo/',
    '/foo',
    'foo//bar',
    'foo.',
  ])('rejects invalid branch %j', (name) => {
    expect(() => normalizeBranch(name)).toThrow();
  });

  it('continues through prefix matches until the exact branch appears', async () => {
    const response = (name: string, next?: string) =>
      new Response(
        JSON.stringify({ value: [{ name, objectId: 'a'.repeat(40) }] }),
        {
          headers: {
            'content-type': 'application/json',
            ...(next ? { 'x-ms-continuationtoken': next } : {}),
          },
        },
      );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('refs/heads/feature/foobar', 'page2'))
      .mockResolvedValueOnce(response('refs/heads/feature/foo'));
    const config = loadConfig({
      ADO_SERVER_URL: 'https://server.test/tfs',
      ADO_COLLECTION: 'DefaultCollection',
      ADO_TOKEN: 'fake-pat',
    });
    const client = new AdoClient(
      config,
      new PatAuthProvider(config.token),
      fetcher,
    );
    const service = new BranchService(
      client,
      new RepositoryService(client, config),
    );
    expect(
      await service.getInRepository(repository, 'feature/foo'),
    ).toMatchObject({ name: 'refs/heads/feature/foo' });
    expect(
      new URL(String(fetcher.mock.calls[1]![0])).searchParams.get(
        'continuationToken',
      ),
    ).toBe('page2');
  });

  it('stops a repeated continuation token without claiming the branch was absent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ value: [] }), {
          headers: {
            'content-type': 'application/json',
            'x-ms-continuationtoken': 'same',
          },
        }),
    );
    const config = loadConfig({
      ADO_SERVER_URL: 'https://server.test',
      ADO_COLLECTION: 'DefaultCollection',
      ADO_TOKEN: 'fake-pat',
    });
    const client = new AdoClient(
      config,
      new PatAuthProvider(config.token),
      fetcher,
    );
    const service = new BranchService(
      client,
      new RepositoryService(client, config),
    );
    await expect(
      service.getInRepository(repository, 'missing'),
    ).rejects.toMatchObject({ code: 'PAGINATION_ERROR' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
