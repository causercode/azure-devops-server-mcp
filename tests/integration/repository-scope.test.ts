import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import { MockAdoServer, project, repository } from '../fixtures/ado-server.js';

describe('process-configured repository access boundary', () => {
  let ado: MockAdoServer;
  let server: McpServer | undefined;
  let client: Client | undefined;
  beforeEach(async () => {
    ado = await new MockAdoServer().start();
  });
  afterEach(async () => {
    await client?.close();
    await server?.close();
    await ado.close();
  });

  async function connect(scope?: unknown, fetcher?: typeof fetch) {
    server = createServer(
      ado.config(
        scope === undefined
          ? {}
          : { ADO_ALLOWED_REPOSITORIES: JSON.stringify(scope) },
      ),
      fetcher ? { fetch: fetcher } : {},
    );
    client = new Client({ name: 'scope-test', version: '1' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);
  }
  async function call(name: string, args: Record<string, unknown>) {
    return client!.callTool({ name, arguments: args });
  }
  const scope = [{ project: 'Website', repository: 'intranet' }];
  const create = {
    action: 'create',
    project: 'Website',
    repository: 'intranet',
    sourceBranch: 'feature/search',
    targetBranch: 'develop',
    title: 'Allowed PR',
  };
  const otherRepository = {
    ...repository,
    id: '33333333-3333-3333-3333-333333333333',
    name: 'someone-elses-repo',
  };
  const foreignPr = {
    repository: otherRepository,
    pullRequestId: 77,
    title: 'Private other repo title',
    status: 'active',
    sourceRefName: 'refs/heads/feature/search',
    targetRefName: 'refs/heads/develop',
  };

  it('allows default reads but rejects every default write before any HTTP request', async () => {
    await connect();
    for (const args of [
      create,
      {
        action: 'update',
        project: 'Website',
        repository: 'intranet',
        pullRequestId: 77,
        title: 'Edit',
      },
    ]) {
      const result = await call('repo_pull_request_write', args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: 'REPOSITORY_SCOPE_REQUIRED' },
      });
    }
    expect(ado.requests).toHaveLength(0);
    expect(
      (
        await call('repo_repository', {
          action: 'get',
          project: 'Website',
          repository: 'intranet',
        })
      ).isError,
    ).not.toBe(true);
  });

  it('treats an explicit empty list as deny-all, including diagnostics', async () => {
    await connect([]);
    for (const [name, args] of [
      ['repo_repository', { action: 'list', project: 'Website' }],
      [
        'repo_repository',
        { action: 'get', project: 'Website', repository: 'intranet' },
      ],
      [
        'repo_branch',
        { action: 'list', project: 'Website', repository: 'intranet' },
      ],
      [
        'repo_pull_request',
        { action: 'list', project: 'Website', repository: 'intranet' },
      ],
      ['repo_pull_request_write', create],
      [
        'repo_pull_request_write',
        {
          action: 'update',
          project: 'Website',
          repository: 'intranet',
          pullRequestId: 77,
          title: 'Edit',
        },
      ],
      ['server_info', { action: 'get' }],
    ] as const) {
      expect((await call(name, args)).structuredContent).toMatchObject({
        error: { code: 'REPOSITORY_NOT_ALLOWED' },
      });
    }
    expect(
      (await call('server_info', { action: 'list_projects' }))
        .structuredContent,
    ).toEqual({ items: [] });
    expect(ado.requests).toHaveLength(0);
  });

  it.each(['someone-elses-repo', otherRepository.id])(
    'rejects unlisted repository %s across every repository tool without requesting it',
    async (selector) => {
      await connect(scope);
      for (const [name, args] of [
        ['repo_repository', { action: 'get' }],
        ['repo_branch', { action: 'get', branch: 'develop' }],
        ['repo_branch', { action: 'list' }],
        ['repo_pull_request', { action: 'get', pullRequestId: 77 }],
        ['repo_pull_request', { action: 'list' }],
        ['repo_pull_request_write', create],
        [
          'repo_pull_request_write',
          { action: 'update', pullRequestId: 77, title: 'Edit' },
        ],
      ] as const) {
        const result = await call(name, {
          ...args,
          project: 'Website',
          repository: selector,
        });
        expect(result.structuredContent).toMatchObject({
          error: { code: 'REPOSITORY_NOT_ALLOWED' },
        });
      }
      expect(ado.requests).toHaveLength(7);
      expect(
        ado.requests.every(
          (request) =>
            request.method === 'GET' &&
            request.url.pathname.endsWith(
              '/Website/_apis/git/repositories/intranet',
            ),
        ),
      ).toBe(true);
    },
  );

  it('rejects another project even with the allowed repository name', async () => {
    await connect(scope);
    expect(
      (await call('repo_pull_request_write', { ...create, project: 'Other' }))
        .structuredContent,
    ).toMatchObject({ error: { code: 'REPOSITORY_NOT_ALLOWED' } });
    expect(
      (await call('repo_repository', { action: 'list', project: 'Other' }))
        .isError,
    ).toBe(true);
    expect(
      ado.requests.every(
        (request) =>
          request.method === 'GET' && !request.url.pathname.includes('/Other/'),
      ),
    ).toBe(true);
  });

  it('accepts allowed names or IDs while discovering only configured repositories/projects', async () => {
    await connect(scope);
    const repos = await call('repo_repository', {
      action: 'list',
      project: project.id,
    });
    expect(repos.structuredContent).toMatchObject({
      items: [{ id: repository.id }],
    });
    expect(
      (await call('server_info', { action: 'list_projects' }))
        .structuredContent,
    ).toEqual({ items: [project] });
    expect(
      (
        await call('repo_repository', {
          action: 'get',
          project: project.id,
          repository: repository.id.toUpperCase(),
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (
        await call('repo_repository', {
          action: 'get',
          project: 'website',
          repository: 'INTRANET',
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (await call('server_info', { action: 'get' })).structuredContent,
    ).toMatchObject({
      repositoryAccess: 'allowlist',
      pullRequestWritesEnabled: true,
    });
    expect(
      ado.requests.every((request) =>
        request.url.pathname.endsWith(
          '/Website/_apis/git/repositories/intranet',
        ),
      ),
    ).toBe(true);
    const write = await call('repo_pull_request_write', {
      ...create,
      project: project.id,
      repository: repository.id,
    });
    expect(write.structuredContent).toMatchObject({ pullRequestId: 42 });
    expect(
      ado.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
  });

  it('pins project/repository IDs and still allows their current names after a rename', async () => {
    const renamed = {
      ...repository,
      name: 'renamed',
      project: { ...project, name: 'RenamedProject' },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(renamed), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await connect(
      [{ project: project.id, repository: repository.id }],
      fetcher,
    );
    expect(
      (
        await call('repo_repository', {
          action: 'get',
          project: 'RenamedProject',
          repository: 'renamed',
        })
      ).isError,
    ).not.toBe(true);
    expect(new URL(String(fetcher.mock.calls[0]![0])).pathname).toBe(
      `/tfs/DefaultCollection/${project.id}/_apis/git/repositories/${repository.id}`,
    );
  });

  it.each(['project', 'repository'])(
    'rejects a mismatched resolved %s before fetching branches or writing',
    async (field) => {
      const wrong =
        field === 'project'
          ? {
              ...repository,
              project: {
                ...project,
                id: '44444444-4444-4444-4444-444444444444',
              },
            }
          : otherRepository;
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(wrong), {
          headers: { 'content-type': 'application/json' },
        }),
      );
      await connect(
        [{ project: project.id, repository: repository.id }],
        fetcher,
      );
      expect(
        (await call('repo_pull_request_write', create)).structuredContent,
      ).toMatchObject({ error: { code: 'REPOSITORY_NOT_ALLOWED' } });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('deduplicates configured aliases before repository pagination', async () => {
    await connect([
      ...scope,
      { project: project.id, repository: repository.id },
    ]);
    expect(
      (
        await call('repo_repository', {
          action: 'list',
          project: 'Website',
          top: 1,
        })
      ).structuredContent,
    ).toMatchObject({ items: [{ id: repository.id }] });
    expect(
      (
        await call('repo_repository', {
          action: 'list',
          project: 'Website',
          top: 1,
          skip: 1,
        })
      ).structuredContent,
    ).toEqual({ items: [] });
  });

  it('verifies a PR ID belongs to the selected repository before updating and withholds unrelated PR data', async () => {
    await connect(scope);
    ado.pullRequests.push(foreignPr);
    for (const [name, args] of [
      ['repo_pull_request', { action: 'get', pullRequestId: 77 }],
      ['repo_pull_request', { action: 'list' }],
      [
        'repo_pull_request_write',
        { action: 'update', pullRequestId: 77, title: 'Edit' },
      ],
    ] as const) {
      const result = await call(name, {
        ...args,
        project: 'Website',
        repository: 'intranet',
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: 'REPOSITORY_NOT_ALLOWED' },
      });
      expect(JSON.stringify(result)).not.toContain(foreignPr.title);
    }
    expect(ado.requests.every((request) => request.method === 'GET')).toBe(
      true,
    );
  });

  it('does not let tool arguments change the process allowlist', async () => {
    await connect(scope);
    const result = await call('repo_pull_request_write', {
      ...create,
      allowedRepositories: [otherRepository],
      allowAll: true,
    });
    expect(result.isError).toBe(true);
    expect(ado.requests).toHaveLength(0);
  });

  it('supports several repositories across projects and pages only approved results', async () => {
    const library = { ...otherRepository, name: 'library' };
    const otherProject = {
      id: '44444444-4444-4444-4444-444444444444',
      name: 'Other',
    };
    const other = {
      ...repository,
      id: '55555555-5555-5555-5555-555555555555',
      name: 'my-other-app',
      project: otherProject,
    };
    const permitted = new Map([
      ['/Website/_apis/git/repositories/intranet', repository],
      ['/Website/_apis/git/repositories/library', library],
      ['/Other/_apis/git/repositories/my-other-app', other],
    ]);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname.replace(
        '/tfs/DefaultCollection',
        '',
      );
      const repo = permitted.get(path);
      if (!repo) throw new Error('Unexpected broad inventory request');
      return new Response(JSON.stringify(repo), {
        headers: { 'content-type': 'application/json' },
      });
    });
    await connect(
      [
        ...scope,
        { project: 'Website', repository: 'library' },
        { project: 'Other', repository: 'my-other-app' },
      ],
      fetcher,
    );
    expect(
      (
        await call('repo_repository', {
          action: 'list',
          project: 'Website',
          top: 1,
        })
      ).structuredContent,
    ).toMatchObject({ items: [{ id: repository.id }], nextSkip: 1 });
    expect(
      (
        await call('repo_repository', {
          action: 'list',
          project: 'Website',
          top: 1,
          skip: 1,
        })
      ).structuredContent,
    ).toMatchObject({ items: [{ id: library.id }] });
    expect(
      (await call('server_info', { action: 'list_projects', top: 1 }))
        .structuredContent,
    ).toEqual({ items: [project], continuationToken: '1' });
    expect(
      (
        await call('server_info', {
          action: 'list_projects',
          top: 1,
          continuationToken: '1',
        })
      ).structuredContent,
    ).toEqual({ items: [otherProject] });
    expect(
      (
        await call('repo_repository', {
          action: 'get',
          project: otherProject.id,
          repository: other.id,
        })
      ).isError,
    ).not.toBe(true);
    const before = fetcher.mock.calls.length;
    expect(
      (
        await call('server_info', {
          action: 'list_projects',
          continuationToken: 'untrusted',
        })
      ).isError,
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(before);
  });
});
