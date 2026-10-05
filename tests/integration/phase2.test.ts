import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import {
  Phase2Fixture,
  personId,
  queryId,
  folderId,
  otherProject,
} from '../fixtures/phase2-server.js';
import {
  project,
  repository,
  token,
  outsideRepository,
} from '../fixtures/ado-server.js';

describe('Phase 2 MCP → real HTTP boundaries and returned state', () => {
  let fixture: Phase2Fixture;
  let server: McpServer;
  let client: Client;
  async function connect(extra: NodeJS.ProcessEnv = {}) {
    if (client) await client.close();
    if (server) await server.close();
    server = createServer(fixture.config(extra));
    client = new Client({ name: 'phase2-tests', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
  }
  beforeEach(async () => {
    fixture = await new Phase2Fixture().start();
    await connect();
  });
  afterEach(async () => {
    await client.close();
    await server.close();
    await fixture.close();
  });
  async function call(
    name: string,
    args: Record<string, unknown>,
    error?: string,
  ) {
    const result = await client.callTool({ name, arguments: args });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(
      Buffer.from(`:${token}`).toString('base64'),
    );
    if (error) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: error },
      });
    } else expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return result.structuredContent as Record<string, unknown>;
  }
  async function pr() {
    return call('repo_pull_request_write', {
      action: 'create',
      repository: repository.name,
      sourceBranch: 'feature/search',
      targetBranch: 'develop',
      title: 'Review test',
      isDraft: true,
    });
  }
  const context = { repository: repository.name, pullRequestId: 42 };
  const writes = () =>
    fixture.ado.requests.filter(
      (r) =>
        ['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method) &&
        !r.url.pathname.endsWith('/wiql') &&
        !r.url.pathname.endsWith('/workitemsbatch'),
    );

  it('reads selected work-item fields, bounds descriptions and verifies batches by ID', async () => {
    expect(await call('wit_work_item', { action: 'get', id: 1 })).toMatchObject(
      {
        id: 1,
        revision: 1,
        fields: { 'System.Title': 'First', 'System.TeamProject': project.name },
        truncatedFields: ['System.Description'],
      },
    );
    const batch = await call('wit_work_item', {
      action: 'get_batch',
      ids: [2, 1],
      fields: ['System.Title'],
    });
    expect(batch).toMatchObject({
      items: [
        { id: 2, fields: { 'System.Title': 'Second' } },
        { id: 1, fields: { 'System.Title': 'First' } },
      ],
    });
    const request = fixture.ado.requests.find((r) =>
      r.url.pathname.endsWith('workitemsbatch'),
    )!;
    expect(request.body).toMatchObject({
      fields: ['System.Title', 'System.TeamProject'],
      errorPolicy: 'Fail',
    });
    expect(JSON.stringify(batch)).not.toContain('Long ');
  });
  it('reads useful type/field metadata and pages server full lists', async () => {
    expect(
      await call('wit_work_item', { action: 'list_types', top: 1 }),
    ).toMatchObject({ items: [{ name: 'Task' }], nextSkip: 1 });
    expect(
      await call('wit_work_item', { action: 'get_type', type: 'Task' }),
    ).toMatchObject({ name: 'Task', description: 'A task' });
    expect(
      await call('wit_work_item', {
        action: 'list_fields',
        type: 'Task',
        top: 1,
        skip: 1,
      }),
    ).toMatchObject({ items: [{ referenceName: 'System.State' }] });
  });
  it.each([
    {
      ADO_ALLOWED_WORK_ITEM_PROJECTS: undefined,
      ADO_WORK_ITEM_WRITE_PROJECTS: undefined,
    },
    {
      ADO_ALLOWED_WORK_ITEM_PROJECTS: '[]',
      ADO_WORK_ITEM_WRITE_PROJECTS: '[]',
    },
  ])(
    'work-item read/write access defaults to deny even with repository writes enabled: %j',
    async (extra) => {
      // Mock config defaults are explicitly removed to reproduce absent process scopes.
      const config = fixture.config();
      delete config.allowedWorkItemProjects;
      delete config.workItemWriteProjects;
      if (extra.ADO_ALLOWED_WORK_ITEM_PROJECTS === '[]')
        config.allowedWorkItemProjects = [];
      await client.close();
      await server.close();
      server = createServer(config);
      client = new Client({ name: 'deny-test', version: '1' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      await client.connect(ct);
      await call(
        'wit_work_item',
        { action: 'get', id: 1 },
        'WORK_ITEM_PROJECT_NOT_ALLOWED',
      );
      await call(
        'wit_work_item_write',
        {
          action: 'create',
          type: 'Task',
          fields: { 'System.Title': 'denied' },
        },
        'WORK_ITEM_PROJECT_NOT_ALLOWED',
      );
      expect(fixture.ado.requests).toHaveLength(0);
      expect(await pr()).toMatchObject({ pullRequestId: 42 });
    },
  );
  it('independent work-item authorization works when repository access is deny-all', async () => {
    await connect({ ADO_ALLOWED_REPOSITORIES: '[]' });
    expect(await call('wit_work_item', { action: 'get', id: 1 })).toMatchObject(
      { id: 1 },
    );
    await call(
      'repo_repository',
      { action: 'get', repository: repository.name },
      'REPOSITORY_NOT_ALLOWED',
    );
  });
  it('requires write permission to be within read permission, resolving names/GUIDs safely', async () => {
    await connect({
      ADO_ALLOWED_WORK_ITEM_PROJECTS: JSON.stringify([project.id]),
      ADO_WORK_ITEM_WRITE_PROJECTS: JSON.stringify([otherProject.id]),
    });
    await call(
      'wit_work_item_write',
      {
        action: 'update',
        project: project.name.toUpperCase(),
        id: 1,
        revision: 1,
        fields: { 'System.Title': 'No' },
      },
      'WORK_ITEM_PROJECT_NOT_ALLOWED',
    );
    expect(writes()).toHaveLength(0);
    expect(
      await call('wit_work_item', {
        action: 'get',
        project: project.id,
        id: 1,
      }),
    ).toMatchObject({ id: 1 });
  });
  it('rejects mismatched configured-project resolution', async () => {
    fixture.mismatchedProject = true;
    await call(
      'wit_work_item',
      { action: 'get', id: 1 },
      'WORK_ITEM_PROJECT_NOT_ALLOWED',
    );
    expect(fixture.ado.requests).toHaveLength(1);
  });
  it.each([
    { action: 'get', id: 3 },
    { action: 'get_batch', ids: [1, 3] },
    { action: 'list_comments', id: 3 },
    { action: 'get_links', id: 3 },
  ])(
    'rejects cross-project ID access without returning partial private data: %j',
    async (args) => {
      const response = await call(
        'wit_work_item',
        args,
        'WORK_ITEM_PROJECT_NOT_ALLOWED',
      );
      expect(JSON.stringify(response)).not.toContain('Private other-project');
    },
  );
  it.each(['duplicate', 'incomplete', 'unexpected'] as const)(
    'rejects %s batch responses',
    async (mode) => {
      fixture.batchMode = mode;
      await call(
        'wit_work_item',
        { action: 'get_batch', ids: mode === 'unexpected' ? [1] : [1, 2] },
        'INVALID_RESPONSE',
      );
    },
  );
  it('creates/updates explicit fields with JSON Patch and a mandatory test /rev', async () => {
    const created = await call('wit_work_item_write', {
      action: 'create',
      type: 'Task',
      fields: { 'System.Title': 'A new task', 'System.Description': '' },
    });
    expect(created).toMatchObject({
      id: 4,
      revision: 1,
      fields: { 'System.Title': 'A new task', 'System.Description': '' },
    });
    expect(
      await call('wit_work_item_write', {
        action: 'update',
        id: 4,
        revision: 1,
        fields: {
          'System.Title': 'Changed',
          'Custom.Bool': false,
          'Custom.Estimate': 0,
        },
      }),
    ).toMatchObject({
      revision: 2,
      fields: { 'Custom.Bool': false, 'Custom.Estimate': 0 },
    });
    const request = writes().at(-1)!;
    expect(request.contentType).toBe('application/json-patch+json');
    expect(request.body).toEqual([
      { op: 'test', path: '/rev', value: 1 },
      { op: 'add', path: '/fields/System.Title', value: 'Changed' },
      { op: 'add', path: '/fields/Custom.Bool', value: false },
      { op: 'add', path: '/fields/Custom.Estimate', value: 0 },
    ]);
  });
  it('rejects stale revisions before writing, and races with a server revision test', async () => {
    await call(
      'wit_work_item_write',
      {
        action: 'update',
        id: 1,
        revision: 2,
        fields: { 'System.Title': 'stale' },
      },
      'REVISION_CONFLICT',
    );
    expect(writes()).toHaveLength(0);
    fixture.mutateBeforePatch = true;
    await call(
      'wit_work_item_write',
      {
        action: 'update',
        id: 1,
        revision: 1,
        fields: { 'System.Title': 'race' },
      },
      'HTTP_412',
    );
    expect(writes()).toHaveLength(1);
    expect(fixture.items.get(1)?.fields).toMatchObject({
      'System.Title': 'First',
    });
  });
  it.each([
    'System.TeamProject',
    'system.teamproject',
    'System.Id',
    'System.WorkItemType',
    'System.History',
    'System.CreatedBy',
    'System.Title/relations',
    'System.Title~1relations',
  ])('rejects protected/injected field %s', async (field) => {
    const result = await client.callTool({
      name: 'wit_work_item_write',
      arguments: {
        action: 'update',
        id: 1,
        revision: 1,
        fields: { [field]: 'Other' },
      },
    });
    expect(result.isError).toBe(true);
    expect(writes()).toHaveLength(0);
  });
  it('rejects cross-project field paths and all arbitrary patch/bypass inputs', async () => {
    await call(
      'wit_work_item_write',
      {
        action: 'update',
        id: 1,
        revision: 1,
        fields: { 'System.AreaPath': 'Other\\Area' },
      },
      'WORK_ITEM_PROJECT_NOT_ALLOWED',
    );
    for (const extra of [
      { bypassRules: true },
      { patch: [{ op: 'remove', path: '/fields/System.TeamProject' }] },
      { relations: [] },
    ]) {
      const response = await client.callTool({
        name: 'wit_work_item_write',
        arguments: {
          action: 'update',
          id: 1,
          revision: 1,
          fields: { 'System.Title': 'changed' },
          ...extra,
        },
      });
      expect(response.isError).toBe(true);
    }
    expect(writes()).toHaveLength(0);
  });
  it('reads/adds comments using endpoint-specific versions with pagination and text limits', async () => {
    await call('wit_work_item_comment_write', {
      action: 'add',
      id: 1,
      text: 'First comment',
    });
    await call('wit_work_item_comment_write', {
      action: 'add',
      id: 1,
      text: 'Second comment',
    });
    expect(
      await call('wit_work_item', { action: 'list_comments', id: 1, top: 1 }),
    ).toMatchObject({
      items: [{ text: 'First comment' }],
      continuationToken: '1',
    });
    expect(
      await call('wit_work_item', {
        action: 'list_comments',
        id: 1,
        top: 1,
        continuationToken: '1',
      }),
    ).toMatchObject({ items: [{ text: 'Second comment' }] });
    expect(
      fixture.ado.requests
        .filter((r) => r.url.pathname.endsWith('/comments'))
        .every(
          (r) => r.url.searchParams.get('api-version') === '7.0-preview.3',
        ),
    ).toBe(true);
    fixture.commentWrongId = true;
    await call(
      'wit_work_item_comment_write',
      { action: 'add', id: 1, text: 'Mismatch' },
      'INVALID_RESPONSE',
    );
  });
  it('discovers saved queries and guards query results against OR-based project escape', async () => {
    expect(await call('wit_query', { action: 'list' })).toMatchObject({
      items: [{ id: folderId, isFolder: true }],
    });
    expect(
      await call('wit_query', { action: 'list', queryId: folderId }),
    ).toMatchObject({ items: [{ id: queryId }] });
    expect(await call('wit_query', { action: 'get', queryId })).toMatchObject({
      name: 'Tasks',
      queryType: 'flat',
    });
    expect(
      await call('wit_query', { action: 'get_results', queryId, top: 1 }),
    ).toMatchObject({ items: [{ id: 1 }], possiblyMore: true });
    const wiql =
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'Other' OR [System.State] = 'New' ORDER BY [System.Id] ASC";
    await call('wit_query', { action: 'wiql', wiql });
    const request = fixture.ado.requests
      .filter((r) => r.url.pathname.endsWith('/wiql'))
      .at(-1)!;
    expect(request.body).toMatchObject({
      query: `SELECT [System.Id] FROM WorkItems WHERE ([System.TeamProject] = 'Other' OR [System.State] = 'New') AND [System.TeamProject] = '${project.name}' ORDER BY [System.Id] ASC`,
    });
    fixture.queryIds = [1, 3];
    await call(
      'wit_query',
      { action: 'get_results', queryId },
      'WORK_ITEM_PROJECT_NOT_ALLOWED',
    );
    expect(writes()).toHaveLength(0);
  });
  it('rejects saved link queries and malformed action contracts before execution', async () => {
    fixture.queryType = 'tree';
    await call(
      'wit_query',
      { action: 'get_results', queryId },
      'INVALID_ARGUMENT',
    );
    expect(
      fixture.ado.requests.some((r) => r.url.pathname.endsWith('/wiql')),
    ).toBe(false);
    for (const [name, args] of [
      ['wit_work_item', { action: 'get', ids: [1] }],
      ['wit_work_item', { action: 'get', id: 1, type: 'Task' }],
      ['wit_query', { action: 'get_results', wiql: 'x' }],
      [
        'wit_work_item_write',
        {
          action: 'create',
          id: 1,
          type: 'Task',
          fields: { 'System.Title': 'No' },
        },
      ],
    ] as const) {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).toBe(true);
    }
    expect(writes()).toHaveLength(0);
  });
  it('returns pinned PR iteration changes with usable base/source commits and pagination', async () => {
    await pr();
    expect(
      await call('repo_pull_request', {
        action: 'get_changes',
        ...context,
        top: 1,
      }),
    ).toMatchObject({
      iterationId: 2,
      compareTo: 0,
      sourceCommit: 'd'.repeat(40),
      baseCommit: 'c'.repeat(40),
      items: [{ item: { path: '/a.ts' } }],
      nextSkip: 1,
    });
    expect(
      await call('repo_pull_request', {
        action: 'get_changes',
        ...context,
        iterationId: 2,
        compareTo: 1,
        top: 1,
        skip: 2,
      }),
    ).toMatchObject({
      baseCommit: 'a'.repeat(40),
      items: [{ changeType: 'delete' }],
    });
    await call(
      'repo_pull_request',
      { action: 'get_changes', ...context, iterationId: 1, compareTo: 1 },
      'INVALID_ARGUMENT',
    );
  });
  it('reads bounded commit-pinned text, rejects binary and invalid paths', async () => {
    expect(
      await call('repo_file', {
        action: 'get_content',
        repository: repository.name,
        path: '/a.ts',
        commit: 'd'.repeat(40),
        maxLines: 2,
      }),
    ).toMatchObject({ content: 'one\ntwo', totalLines: 4, nextStartLine: 3 });
    expect(
      fixture.ado.requests
        .at(-1)!
        .url.searchParams.get('versionDescriptor.version'),
    ).toBe('d'.repeat(40));
    expect(
      await call('repo_file', {
        action: 'get_content',
        repository: repository.name,
        path: '/a.ts',
        commit: 'd'.repeat(40),
        startLine: 3,
      }),
    ).toMatchObject({ content: 'three\nfour', truncated: false });
    fixture.fileBinary = true;
    await call(
      'repo_file',
      {
        action: 'get_content',
        repository: repository.name,
        path: '/a.ts',
        commit: 'd'.repeat(40),
      },
      'UNSUPPORTED_FILE',
    );
    fixture.fileBinary = false;
    fixture.fileContent = 'x'.repeat(32001);
    await call(
      'repo_file',
      {
        action: 'get_content',
        repository: repository.name,
        path: '/a.ts',
        commit: 'd'.repeat(40),
      },
      'RESPONSE_TOO_LARGE',
    );
    await call(
      'repo_file',
      {
        action: 'get_content',
        repository: repository.name,
        path: '/../secret',
        commit: 'd'.repeat(40),
      },
      'INVALID_ARGUMENT',
    );
  });
  it('creates/replies/resolves/reopens PR threads and pages bounded comments', async () => {
    await pr();
    expect(
      await call('repo_pull_request_thread_write', {
        action: 'create',
        ...context,
        content: 'Review finding',
      }),
    ).toMatchObject({
      id: 1,
      status: 1,
      comments: [{ text: 'Review finding' }],
    });
    expect(
      await call('repo_pull_request_thread_write', {
        action: 'reply',
        ...context,
        threadId: 1,
        content: 'Fixed',
      }),
    ).toMatchObject({ threadId: 1, comment: { id: 2, text: 'Fixed' } });
    expect(
      await call('repo_pull_request_thread', {
        action: 'list_comments',
        ...context,
        threadId: 1,
        top: 1,
      }),
    ).toMatchObject({ items: [{ id: 1 }], nextSkip: 1 });
    expect(
      await call('repo_pull_request_thread_write', {
        action: 'update_status',
        ...context,
        threadId: 1,
        status: 'resolved',
      }),
    ).toMatchObject({ status: 2 });
    expect(
      await call('repo_pull_request_thread_write', {
        action: 'update_status',
        ...context,
        threadId: 1,
        status: 'active',
      }),
    ).toMatchObject({ status: 1 });
    expect(
      await call('repo_pull_request_thread', { action: 'list', ...context }),
    ).toMatchObject({ items: [{ id: 1, status: 1 }] });
    fixture.mismatchedThread = true;
    const before = writes().length;
    await call(
      'repo_pull_request_thread_write',
      { action: 'reply', ...context, threadId: 1, content: 'No' },
      'INVALID_RESPONSE',
    );
    expect(writes()).toHaveLength(before);
  });
  it('searches ambiguous identities without choosing and adds/removes an explicit person without votes', async () => {
    await pr();
    expect(
      await call('core_identity', {
        action: 'search',
        repository: repository.name,
        search: 'Same',
        top: 1,
      }),
    ).toMatchObject({
      items: [{ id: personId, accountName: 'person' }],
      nextSkip: 1,
    });
    expect(writes()).toHaveLength(1);
    expect(
      await call('core_identity', {
        action: 'get',
        repository: repository.name,
        identityId: personId,
      }),
    ).toMatchObject({ id: personId });
    expect(
      await call('repo_pull_request_write', {
        action: 'update_reviewers',
        ...context,
        operation: 'add',
        reviewerId: personId,
      }),
    ).toMatchObject({ items: [{ id: personId, vote: 0 }] });
    expect(fixture.ado.requests.find((r) => r.method === 'PUT')?.body).toEqual({
      id: personId,
    });
    expect(
      await call('repo_pull_request', { action: 'list_reviewers', ...context }),
    ).toMatchObject({ items: [{ id: personId }] });
    expect(
      await call('repo_pull_request_write', {
        action: 'update_reviewers',
        ...context,
        operation: 'remove',
        reviewerId: personId,
      }),
    ).toEqual({ items: [] });
    expect(
      fixture.ado.requests.filter((r) => r.method === 'DELETE'),
    ).toHaveLength(1);
  });
  it.each(['missing', 'group', 'inactive', 'duplicate'] as const)(
    'rejects %s person resolution before reviewer writes',
    async (mode) => {
      await pr();
      const person = fixture.identityResults[0]!;
      if (mode === 'missing') fixture.identityResults = [];
      if (mode === 'group') person.isContainer = true;
      if (mode === 'inactive') person.isActive = false;
      if (mode === 'duplicate') fixture.identityResults = [person, person];
      await call(
        'repo_pull_request_write',
        {
          action: 'update_reviewers',
          ...context,
          operation: 'add',
          reviewerId: personId,
        },
        'IDENTITY_NOT_FOUND',
      );
      expect(fixture.ado.requests.some((r) => r.method === 'PUT')).toBe(false);
    },
  );
  it('preserves a current reviewer vote on repeat add and accepts proven person identities with omitted container flags', async () => {
    await pr();
    const identity = fixture.identityResults[0]! as Omit<
      (typeof fixture.identityResults)[number],
      'isContainer'
    > & { isContainer?: boolean };
    delete identity.isContainer;
    identity.properties = {
      ...identity.properties,
      SchemaClassName: { $value: 'User' },
    } as typeof identity.properties;
    fixture.reviewers.push({
      id: personId,
      displayName: 'Test Person',
      vote: 10,
      isRequired: true,
    });
    expect(
      await call('repo_pull_request_write', {
        action: 'update_reviewers',
        ...context,
        operation: 'add',
        reviewerId: personId,
      }),
    ).toMatchObject({ items: [{ vote: 10, isRequired: true }] });
    expect(
      fixture.ado.requests.some((request) => request.method === 'PUT'),
    ).toBe(false);
  });
  it('rejects unknown person/group classification instead of assuming an omitted flag is false', async () => {
    await pr();
    delete (fixture.identityResults[0]! as { isContainer?: boolean })
      .isContainer;
    await call(
      'repo_pull_request_write',
      {
        action: 'update_reviewers',
        ...context,
        operation: 'add',
        reviewerId: personId,
      },
      'IDENTITY_NOT_FOUND',
    );
    expect(
      fixture.ado.requests.some((request) => request.method === 'PUT'),
    ).toBe(false);
  });
  it('enforces link inspection bounds before following relation IDs', async () => {
    fixture.items.get(1)!.relations = Array.from({ length: 101 }, () => ({
      rel: 'System.LinkTypes.Related',
      url: `${fixture.ado.baseUrl}/tfs/DefaultCollection/_apis/wit/workitems/2`,
    }));
    await call(
      'wit_work_item',
      { action: 'get_links', id: 1 },
      'RESPONSE_TOO_LARGE',
    );
    expect(fixture.ado.requests).toHaveLength(2);
  });
  it('links related/parent/child work items and PRs with revision and both scopes', async () => {
    await pr();
    expect(
      await call('wit_work_item_link_write', {
        action: 'link',
        id: 1,
        revision: 1,
        targetId: 2,
        relationship: 'related',
      }),
    ).toMatchObject({ revision: 2, alreadyLinked: false });
    expect(
      await call('wit_work_item_link_write', {
        action: 'link',
        id: 1,
        revision: 2,
        targetId: 2,
        relationship: 'related',
      }),
    ).toMatchObject({ revision: 2, alreadyLinked: true });
    expect(
      await call('wit_work_item_link_write', {
        action: 'link_to_pull_request',
        ...context,
        id: 1,
        revision: 2,
      }),
    ).toMatchObject({ revision: 3 });
    expect(
      await call('wit_work_item', { action: 'get_links', id: 1, top: 1 }),
    ).toMatchObject({
      items: [{ relationship: 'related', targetId: 2 }],
      nextSkip: 1,
    });
    expect(
      await call('repo_pull_request', { action: 'get_work_items', ...context }),
    ).toMatchObject({ items: [{ id: 1 }] });
    const patch = fixture.ado.requests
      .filter((r) => r.method === 'PATCH')
      .at(-1)!;
    expect(patch.body).toEqual([
      { op: 'test', path: '/rev', value: 2 },
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'ArtifactLink',
          url: `vstfs:///Git/PullRequestId/${project.id}%2F${repository.id}%2F42`,
          attributes: { name: 'Pull Request' },
        },
      },
    ]);
  });
  it.each(['parent', 'child'] as const)(
    'constructs %s relationships internally',
    async (relationship) => {
      await call('wit_work_item_link_write', {
        action: 'link',
        id: 1,
        revision: 1,
        targetId: 2,
        relationship,
      });
      expect(fixture.items.get(1)?.relations).toMatchObject([
        {
          rel:
            relationship === 'parent'
              ? 'System.LinkTypes.Hierarchy-Reverse'
              : 'System.LinkTypes.Hierarchy-Forward',
        },
      ]);
    },
  );
  it('rejects cross-project link targets and cross-repository PR links, and hides escaped links', async () => {
    await pr();
    const before = writes().length;
    await call(
      'wit_work_item_link_write',
      {
        action: 'link',
        id: 1,
        revision: 1,
        targetId: 3,
        relationship: 'related',
      },
      'WORK_ITEM_PROJECT_NOT_ALLOWED',
    );
    await call(
      'wit_work_item_link_write',
      {
        action: 'link_to_pull_request',
        ...context,
        repository: outsideRepository.name,
        id: 1,
        revision: 1,
      },
      'REPOSITORY_NOT_ALLOWED',
    );
    fixture.items.get(1)!.relations = [
      {
        rel: 'System.LinkTypes.Related',
        url: `${fixture.ado.baseUrl}/tfs/DefaultCollection/_apis/wit/workitems/3`,
      },
      {
        rel: 'System.LinkTypes.Related',
        url: 'https://untrusted.example.test/_apis/wit/workitems/2',
      },
      {
        rel: 'ArtifactLink',
        url: `vstfs:///Git/PullRequestId/${project.id}%2F${outsideRepository.id}%2F42`,
      },
      {
        rel: 'ArtifactLink',
        url: `vstfs:///Git/PullRequestId/${otherProject.id}%2F${repository.id}%2F42`,
      },
      { rel: 'Hyperlink', url: 'https://untrusted.example.test' },
    ];
    expect(
      await call('wit_work_item', { action: 'get_links', id: 1 }),
    ).toMatchObject({ items: [], omittedLinks: 5 });
    expect(
      fixture.ado.requests.every((r) => r.url.hostname === '127.0.0.1'),
    ).toBe(true);
    expect(writes()).toHaveLength(before);
    fixture.linkedWorkItemIds = [1, 3];
    await call(
      'repo_pull_request',
      { action: 'get_work_items', ...context },
      'WORK_ITEM_PROJECT_NOT_ALLOWED',
    );
  });
  it('requires repository write scope even when work-item write scope permits PR linking', async () => {
    await pr();
    const config = fixture.config();
    delete config.allowedRepositories;
    await client.close();
    await server.close();
    server = createServer(config);
    client = new Client({ name: 'scope', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    await call(
      'wit_work_item_link_write',
      { action: 'link_to_pull_request', ...context, id: 1, revision: 1 },
      'REPOSITORY_SCOPE_REQUIRED',
    );
    expect(
      fixture.ado.requests.filter((r) => r.method === 'PATCH'),
    ).toHaveLength(0);
  });
  it.each([
    'repo_pull_request_thread_write',
    'repo_pull_request_write',
  ] as const)('enforces repository scope on new %s writes', async (name) => {
    await pr();
    const args =
      name === 'repo_pull_request_thread_write'
        ? { action: 'create', content: 'denied' }
        : {
            action: 'update_reviewers',
            operation: 'add',
            reviewerId: personId,
          };
    await call(
      name,
      { ...context, repository: outsideRepository.name, ...args },
      'REPOSITORY_NOT_ALLOWED',
    );
    expect(writes()).toHaveLength(1);
  });
  it('does not retry uncertain work-item writes and gives truthful recovery guidance', async () => {
    fixture.patchStatus = 500;
    const response = await call(
      'wit_work_item_write',
      {
        action: 'update',
        id: 1,
        revision: 1,
        fields: { 'System.Title': 'Maybe' },
      },
      'HTTP_500',
    );
    expect(response).toMatchObject({
      error: { message: expect.stringContaining('read the work item') },
    });
    expect(JSON.stringify(response)).not.toContain('inspect pull requests');
    expect(writes()).toHaveLength(1);
  });
});
