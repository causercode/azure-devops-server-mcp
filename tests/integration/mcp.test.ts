import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import { AdoClient } from '../../src/ado/client.js';
import { PatAuthProvider } from '../../src/ado/auth.js';
import { listSchema, projectSchema } from '../../src/ado/types.js';
import {
  MockAdoServer,
  project,
  repository,
  token,
} from '../fixtures/ado-server.js';

describe('MCP to Azure DevOps HTTP integration', () => {
  it('bounds real HTTP request latency with a configured timeout', async () => {
    ado.projectDelayMs = 250;
    const config = ado.config({ ADO_TIMEOUT_MS: '100' });
    const rest = new AdoClient(config, new PatAuthProvider(config.token));
    await expect(
      rest.request(['_apis', 'projects'], listSchema(projectSchema)),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(ado.requests).toHaveLength(1);
  });
  let ado: MockAdoServer;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    ado = await new MockAdoServer().start();
    server = createServer(
      ado.config({
        ADO_ALLOWED_REPOSITORIES: JSON.stringify([
          { project: 'Website', repository: 'intranet' },
        ]),
      }),
    );
    client = new Client({ name: 'integration-test', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await ado.close();
  });

  async function call(name: string, args: Record<string, unknown>) {
    const response = await client.callTool({ name, arguments: args });
    expect(JSON.stringify(response)).not.toContain(token);
    expect(JSON.stringify(response)).not.toContain(
      Buffer.from(`:${token}`).toString('base64'),
    );
    return response;
  }

  async function useUnrestrictedReads() {
    await client.close();
    await server.close();
    server = createServer(ado.config());
    client = new Client({ name: 'integration-test', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }

  const createArgs = {
    action: 'create',
    project: 'Website',
    repository: 'intranet',
    sourceBranch: 'feature/search',
    targetBranch: 'develop',
    title: 'Improve search caching',
  };

  it('advertises the Phase 2 tools with read/write annotations and strict inputs', async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      'core_identity',
      'repo_branch',
      'repo_file',
      'repo_pull_request',
      'repo_pull_request_thread',
      'repo_pull_request_thread_write',
      'repo_pull_request_write',
      'repo_repository',
      'server_info',
      'wit_query',
      'wit_work_item',
      'wit_work_item_comment_write',
      'wit_work_item_link_write',
      'wit_work_item_write',
    ]);
    for (const tool of result.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations?.readOnlyHint).toBe(
        !tool.name.endsWith('_write'),
      );
    }
  });

  it('discovers a project and repo, verifies branches, creates a PR, and returns its number and browser URL', async () => {
    const projects = await call('server_info', { action: 'list_projects' });
    expect(projects.structuredContent).toMatchObject({ items: [project] });
    const repos = await call('repo_repository', {
      action: 'list',
      project: 'Website',
    });
    expect(repos.structuredContent).toMatchObject({
      items: [
        { id: repository.id, name: 'intranet', defaultBranch: 'develop' },
      ],
    });
    const branch = await call('repo_branch', {
      action: 'get',
      project: 'Website',
      repository: 'intranet',
      branch: 'feature/search',
    });
    expect(branch.structuredContent).toMatchObject({
      name: 'feature/search',
      commitId: 'a'.repeat(40),
    });
    const result = await call('repo_pull_request_write', {
      ...createArgs,
      sourceBranch: 'refs/heads/feature/search',
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      pullRequestId: 42,
      sourceBranch: 'feature/search',
      targetBranch: 'develop',
      url: `${ado.baseUrl}/tfs/DefaultCollection/${project.id}/_git/${repository.id}/pullrequest/42`,
    });
    const writes = ado.requests.filter((request) => request.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({
      sourceRefName: 'refs/heads/feature/search',
      targetRefName: 'refs/heads/develop',
      title: 'Improve search caching',
      isDraft: false,
    });
    expect(
      ado.requests.filter((request) => request.url.pathname.endsWith('/refs'))
        .length,
    ).toBe(3);
    const get = await call('repo_pull_request', {
      action: 'get',
      project: 'Website',
      repository: 'intranet',
      pullRequestId: 42,
    });
    expect(get.structuredContent).toMatchObject({
      pullRequestId: 42,
      title: 'Improve search caching',
    });
    const list = await call('repo_pull_request', {
      action: 'list',
      project: 'Website',
      repository: 'intranet',
      sourceBranch: 'feature/search',
      targetBranch: 'refs/heads/develop',
      top: 1,
    });
    expect(list.structuredContent).toMatchObject({
      items: [{ pullRequestId: 42 }],
      nextSkip: 1,
    });
    const next = await call('repo_pull_request', {
      action: 'list',
      project: 'Website',
      repository: 'intranet',
      skip: 1,
      top: 1,
    });
    expect(next.structuredContent).toEqual({ items: [] });
  });

  it('requires a project when none is configured, with a discovery hint', async () => {
    const result = await call('repo_repository', { action: 'list' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'PROJECT_REQUIRED',
        message: expect.stringContaining('list_projects'),
      },
    });
    expect(ado.requests).toHaveLength(0);
  });

  it('never mistakes a prefix-matching branch for the requested branch or writes a PR', async () => {
    ado.branches.delete('refs/heads/feature/search');
    const result = await call('repo_pull_request_write', createArgs);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: 'BRANCH_NOT_FOUND' },
    });
    expect(ado.requests.every((request) => request.method === 'GET')).toBe(
      true,
    );
  });

  it('rejects identical normalized source and target branches before connecting', async () => {
    const result = await call('repo_pull_request_write', {
      ...createArgs,
      sourceBranch: 'refs/heads/develop',
    });
    expect(result.isError).toBe(true);
    expect(ado.requests).toHaveLength(0);
  });

  it.each([
    { action: 'complete', pullRequestId: 42 },
    { action: 'update', pullRequestId: 42, status: 'completed' },
    {
      action: 'update',
      pullRequestId: 42,
      completionOptions: { bypassPolicy: true },
    },
    { action: 'update', pullRequestId: 42, autoCompleteSetBy: { id: 'user' } },
  ])(
    'rejects unsupported or dangerous PR operations %j',
    async (arguments_) => {
      const result = await call('repo_pull_request_write', {
        project: 'Website',
        repository: 'intranet',
        ...arguments_,
      });
      expect(result.isError).toBe(true);
      expect(ado.requests).toHaveLength(0);
    },
  );

  it('validates action-specific requirements before HTTP requests', async () => {
    for (const args of [
      {
        action: 'create',
        project: 'Website',
        repository: 'intranet',
        title: 'Missing branches',
      },
      {
        action: 'update',
        project: 'Website',
        repository: 'intranet',
        title: 'Missing ID',
      },
      {
        action: 'update',
        project: 'Website',
        repository: 'intranet',
        pullRequestId: 42,
      },
      { ...createArgs, pullRequestId: 42 },
    ]) {
      const result = await call('repo_pull_request_write', args);
      expect(result.isError).toBe(true);
    }
    expect(ado.requests).toHaveLength(0);
  });

  it('only updates allowlisted metadata, preserving empty strings and false', async () => {
    await call('repo_pull_request_write', {
      ...createArgs,
      description: 'Old description',
      isDraft: true,
    });
    const result = await call('repo_pull_request_write', {
      action: 'update',
      project: 'Website',
      repository: 'intranet',
      pullRequestId: 42,
      description: '',
      isDraft: false,
    });
    expect(result.structuredContent).toMatchObject({
      pullRequestId: 42,
      title: 'Improve search caching',
      description: '',
      isDraft: false,
      status: 'active',
    });
    expect(
      ado.requests.find((request) => request.method === 'PATCH')?.body,
    ).toEqual({ description: '', isDraft: false });
  });

  it('preserves project and branch continuation tokens', async () => {
    await useUnrestrictedReads();
    const projects = await call('server_info', {
      action: 'list_projects',
      top: 1,
    });
    expect(projects.structuredContent).toMatchObject({
      continuationToken: '1',
    });
    const projectNext = await call('server_info', {
      action: 'list_projects',
      top: 1,
      continuationToken: '1',
    });
    expect(projectNext.structuredContent).toMatchObject({
      items: [{ name: 'Other' }],
    });
    const branches = await call('repo_branch', {
      action: 'list',
      project: 'Website',
      repository: 'intranet',
      prefix: 'feature/',
      top: 1,
    });
    expect(branches.structuredContent).toMatchObject({
      items: [{ name: 'feature/search' }],
      continuationToken: '1',
    });
    const branchNext = await call('repo_branch', {
      action: 'list',
      project: 'Website',
      repository: 'intranet',
      prefix: 'feature/',
      top: 1,
      continuationToken: '1',
    });
    expect(branchNext.structuredContent).toMatchObject({
      items: [{ name: 'feature/search-more' }],
    });
  });

  it('returns safe diagnostics with only the version the server actually reports', async () => {
    await useUnrestrictedReads();
    const result = await call('server_info', {});
    expect(result.structuredContent).toMatchObject({
      connected: true,
      collection: 'DefaultCollection',
      defaultProject: null,
      authType: 'pat',
      apiVersion: '7.0',
      reportedProductVersion: '19.205.33122.1',
    });
    expect(JSON.stringify(result)).not.toContain('ADO_TOKEN');
    ado.projectsStatus = 401;
    const failure = await call('server_info', {});
    expect(failure.structuredContent).toMatchObject({
      error: { code: 'HTTP_401', status: 401 },
    });
    expect(JSON.stringify(failure)).not.toContain('Sensitive upstream');
  });

  it('does not retry an uncertain write and tells the agent to inspect PRs', async () => {
    ado.writeStatus = 500;
    const result = await call('repo_pull_request_write', createArgs);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: 'HTTP_500',
        message: expect.stringContaining('write outcome may be unknown'),
      },
    });
    expect(
      ado.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(1);
  });

  it('redacts credentials even if an upstream allowlisted field echoes them', async () => {
    const result = await call('repo_pull_request_write', {
      ...createArgs,
      title: `Echo ${token}`,
    });
    expect(result.structuredContent).toMatchObject({
      title: 'Echo [REDACTED]',
    });
  });
});
