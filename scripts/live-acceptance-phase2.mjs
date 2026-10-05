import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadConfig } from '../dist/config.js';
import { authSecrets, createSecretRedactor } from '../dist/ado/auth.js';

// Write-capable, loopback-only acceptance. Branch creation/setup stays outside MCP.
let client;
let transport;
let redact = (value) => value;
const reportPath =
  process.env.ADO_PHASE2_REPORT ?? 'phase2-acceptance.local.json';
const checks = [];
const resources = {};
let stage = 'configuration';
async function report(passed, error) {
  await writeFile(
    reportPath,
    `${JSON.stringify({ date: new Date().toISOString(), passed, apiVersion: process.env.ADO_API_VERSION ?? '7.0', transport: 'compiled CLI over stdio', stage, checks, resources, ...(error ? { error } : {}) }, null, 2)}\n`,
  );
}
try {
  const config = loadConfig();
  redact = createSecretRedactor(authSecrets(config));
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(
      new URL(config.serverUrl).hostname,
    ),
    'Phase 2 live acceptance is restricted to a loopback lab.',
  );
  const project = config.project;
  const repository = process.env.ADO_TEST_REPOSITORY;
  const sourceBranch = process.env.ADO_TEST_SOURCE_BRANCH;
  const targetBranch = process.env.ADO_TEST_TARGET_BRANCH ?? 'develop';
  const reviewerId = process.env.ADO_TEST_REVIEWER_ID;
  const type = process.env.ADO_TEST_WORK_ITEM_TYPE ?? 'Task';
  assert.ok(
    project && repository && sourceBranch?.startsWith('phase2-mcp-'),
    'Configure the disposable project/repository and a fresh phase2-mcp- source branch.',
  );
  assert.ok(
    reviewerId,
    'Configure an explicitly verified ADO_TEST_REVIEWER_ID for a disposable lab person.',
  );
  assert.ok(
    config.allowedRepositories?.length,
    'Explicit repository scope is required.',
  );
  assert.ok(
    config.allowedWorkItemProjects?.length &&
      config.workItemWriteProjects?.length,
    'Configure both work-item project read and write scopes.',
  );
  client = new Client({ name: 'phase2-live-acceptance', version: '0.2.0' });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  await client.connect(transport);
  async function call(name, args, errorCode) {
    stage = `${name}/${args.action}`;
    const result = await client.callTool({ name, arguments: args });
    const serialized = JSON.stringify(result);
    assert.ok(
      authSecrets(config).every(
        (secret) =>
          !serialized.includes(secret) &&
          !serialized.includes(Buffer.from(`:${secret}`).toString('base64')),
      ),
      'A credential appeared in a tool response.',
    );
    const data =
      result.structuredContent ??
      JSON.parse(
        result.content.find((item) => item.type === 'text')?.text ?? '{}',
      );
    if (errorCode) {
      assert.equal(result.isError, true, 'Expected operation rejection.');
      assert.equal(data.error?.code, errorCode);
    } else
      assert.ok(
        !result.isError,
        `${stage} failed (${data.error?.code ?? 'input validation'}).`,
      );
    return data;
  }
  const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
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
  ])
    assert.ok(toolNames.includes(name));
  await call('server_info', { action: 'get' });
  const resolved = await call('repo_repository', {
    action: 'get',
    project,
    repository,
  });
  const branch = await call('repo_branch', {
    action: 'get',
    project,
    repository,
    branch: sourceBranch,
  });
  await call('repo_branch', {
    action: 'get',
    project,
    repository,
    branch: targetBranch,
  });
  const person = await call('core_identity', {
    action: 'get',
    project,
    repository,
    identityId: reviewerId,
  });
  assert.equal(person.id.toLowerCase(), reviewerId.toLowerCase());
  const types = await call('wit_work_item', {
    action: 'list_types',
    project,
    top: 100,
  });
  assert.ok(
    types.items.some((item) => item.name === type),
    'Select a work-item type actually present in this lab project.',
  );
  await call('wit_work_item', { action: 'get_type', project, type });
  const fields = await call('wit_work_item', {
    action: 'list_fields',
    project,
    type,
    top: 100,
  });
  assert.ok(fields.items.some((item) => item.referenceName === 'System.Title'));
  const saved = await call('wit_query', { action: 'list', project });
  if (saved.items[0]) {
    const metadata = await call('wit_query', {
      action: 'get',
      project,
      queryId: saved.items[0].id,
    });
    if (metadata.isFolder)
      await call('wit_query', {
        action: 'list',
        project,
        queryId: metadata.id,
      });
  }
  const prior = await call('repo_pull_request', {
    action: 'list',
    project,
    repository,
    sourceBranch,
    targetBranch,
    status: 'active',
  });
  assert.equal(
    prior.items.length,
    0,
    'Use a fresh Phase 2 branch; an active PR already exists.',
  );
  checks.push(
    'read-only prerequisites: tools, scopes, branches, identity, WIT metadata and saved query discovery',
  );

  const title = `phase2-mcp-${new Date().toISOString()}`;
  const created = await call('repo_pull_request_write', {
    action: 'create',
    project,
    repository,
    sourceBranch,
    targetBranch,
    title,
    description: 'Disposable Phase 2 review acceptance.',
    isDraft: true,
  });
  resources.pullRequestId = created.pullRequestId;
  resources.url = created.url;
  await report(false);
  const context = { project, repository, pullRequestId: created.pullRequestId };
  assert.equal(created.isDraft, true);
  assert.equal(created.sourceBranch, sourceBranch);
  const updated = await call('repo_pull_request_write', {
    action: 'update',
    ...context,
    title: `${title} verified`,
    description: '',
  });
  assert.equal(updated.description, '');
  assert.equal(
    (await call('repo_pull_request', { action: 'get', ...context })).title,
    `${title} verified`,
  );
  checks.push('PR create/update/get and draft state regression');
  const changes = await call('repo_pull_request', {
    action: 'get_changes',
    ...context,
    top: 1,
  });
  assert.equal(changes.sourceCommit, branch.commitId);
  assert.ok(
    changes.items.length > 0,
    'The fresh feature branch must contain a text-file change.',
  );
  const change = changes.items.find(
    (item) => !['delete', 16].includes(item.changeType),
  );
  assert.ok(change, 'Provide an added/edited text file for review acceptance.');
  const file = await call('repo_file', {
    action: 'get_content',
    project,
    repository,
    path: change.item.path,
    commit: changes.sourceCommit,
    maxLines: 2,
  });
  assert.equal(file.commit, changes.sourceCommit);
  assert.ok(file.linesReturned > 0);
  if (file.nextStartLine)
    await call('repo_file', {
      action: 'get_content',
      project,
      repository,
      path: change.item.path,
      commit: changes.sourceCommit,
      startLine: file.nextStartLine,
      maxLines: 2,
    });
  if (changes.nextSkip)
    await call('repo_pull_request', {
      action: 'get_changes',
      ...context,
      iterationId: changes.iterationId,
      skip: changes.nextSkip,
      top: 1,
    });
  checks.push(
    'PR changed-file iteration, pinned commits and bounded file content',
  );
  const thread = await call('repo_pull_request_thread_write', {
    action: 'create',
    ...context,
    content: 'Phase 2 review discussion.',
  });
  resources.threadId = thread.id;
  await report(false);
  await call('repo_pull_request_thread_write', {
    action: 'reply',
    ...context,
    threadId: thread.id,
    content: 'Verified reply.',
  });
  const comments = await call('repo_pull_request_thread', {
    action: 'list_comments',
    ...context,
    threadId: thread.id,
    top: 1,
  });
  assert.ok(comments.nextSkip > 0);
  await call('repo_pull_request_thread', {
    action: 'list_comments',
    ...context,
    threadId: thread.id,
    top: 1,
    skip: comments.nextSkip,
  });
  await call('repo_pull_request_thread_write', {
    action: 'update_status',
    ...context,
    threadId: thread.id,
    status: 'resolved',
  });
  await call('repo_pull_request_thread_write', {
    action: 'update_status',
    ...context,
    threadId: thread.id,
    status: 'active',
  });
  const threads = await call('repo_pull_request_thread', {
    action: 'list',
    ...context,
  });
  assert.ok(
    threads.items.some(
      (item) => item.id === thread.id && [1, 'active'].includes(item.status),
    ),
  );
  checks.push(
    'discussion create/reply/read/paging/resolve/reopen returned state',
  );
  const initialReviewers = await call('repo_pull_request', {
    action: 'list_reviewers',
    ...context,
  });
  assert.ok(
    !initialReviewers.items.some(
      (item) => item.id.toLowerCase() === reviewerId.toLowerCase(),
    ),
    'Select a person who is not already a reviewer; acceptance will add then remove them.',
  );
  const reviewers = await call('repo_pull_request_write', {
    action: 'update_reviewers',
    ...context,
    operation: 'add',
    reviewerId,
  });
  assert.ok(
    reviewers.items.some(
      (item) =>
        item.id.toLowerCase() === reviewerId.toLowerCase() && item.vote === 0,
    ),
  );
  const removed = await call('repo_pull_request_write', {
    action: 'update_reviewers',
    ...context,
    operation: 'remove',
    reviewerId,
  });
  assert.ok(
    !removed.items.some(
      (item) => item.id.toLowerCase() === reviewerId.toLowerCase(),
    ),
  );
  checks.push(
    'explicit active-person reviewer add/read/remove without approval vote',
  );

  const first = await call('wit_work_item_write', {
    action: 'create',
    project,
    type,
    fields: {
      'System.Title': `${title} first`,
      'System.Description': 'Disposable work-item acceptance.',
    },
  });
  resources.workItemIds = [first.id];
  await report(false);
  const second = await call('wit_work_item_write', {
    action: 'create',
    project,
    type,
    fields: { 'System.Title': `${title} second` },
  });
  resources.workItemIds.push(second.id);
  await report(false);
  const batch = await call('wit_work_item', {
    action: 'get_batch',
    project,
    ids: [first.id, second.id],
  });
  assert.equal(batch.items.length, 2);
  const edited = await call('wit_work_item_write', {
    action: 'update',
    project,
    id: first.id,
    revision: first.revision,
    fields: { 'System.Title': `${title} updated`, 'System.Description': '' },
  });
  assert.ok(edited.revision > first.revision);
  assert.equal(edited.fields['System.Description'], '');
  await call(
    'wit_work_item_write',
    {
      action: 'update',
      project,
      id: first.id,
      revision: first.revision,
      fields: { 'System.Title': 'stale must fail' },
    },
    'REVISION_CONFLICT',
  );
  await call(
    'wit_work_item_write',
    {
      action: 'update',
      project,
      id: first.id,
      revision: edited.revision,
      fields: { 'System.TeamProject': 'Other' },
    },
    'INVALID_ARGUMENT',
  );
  checks.push(
    'WIT create/batch/get/fields and stale-revision/protected-project rejection',
  );
  const comment1 = await call('wit_work_item_comment_write', {
    action: 'add',
    project,
    id: first.id,
    text: 'Phase 2 work-item comment.',
  });
  await call('wit_work_item_comment_write', {
    action: 'add',
    project,
    id: first.id,
    text: 'Second comment for pagination.',
  });
  const commentPage = await call('wit_work_item', {
    action: 'list_comments',
    project,
    id: first.id,
    top: 1,
  });
  assert.equal(commentPage.items[0].id, comment1.id);
  assert.ok(commentPage.continuationToken);
  await call('wit_work_item', {
    action: 'list_comments',
    project,
    id: first.id,
    top: 1,
    continuationToken: commentPage.continuationToken,
  });
  checks.push(
    'WIT comment add/read/preview version and server continuation token',
  );
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.Id] IN (${first.id}, ${second.id}) ORDER BY [System.Id]`;
  const queried = await call('wit_query', {
    action: 'wiql',
    project,
    wiql,
    top: 1,
  });
  assert.equal(queried.items.length, 1);
  assert.equal(queried.possiblyMore, true);
  checks.push('bounded project-guarded WIQL with verified result IDs');
  if (process.env.ADO_TEST_QUERY_ID) {
    const metadata = await call('wit_query', {
      action: 'get',
      project,
      queryId: process.env.ADO_TEST_QUERY_ID,
    });
    assert.equal(metadata.queryType, 'flat');
    const savedResults = await call('wit_query', {
      action: 'get_results',
      project,
      queryId: process.env.ADO_TEST_QUERY_ID,
      top: 100,
    });
    assert.ok(savedResults.items.some((item) => item.id === first.id));
    checks.push(
      'saved flat query metadata/execution with normalized projection and verified IDs',
    );
  }
  let current = await call('wit_work_item', {
    action: 'get',
    project,
    id: first.id,
  });
  const linked = await call('wit_work_item_link_write', {
    action: 'link',
    project,
    id: first.id,
    revision: current.revision,
    targetId: second.id,
    relationship: 'related',
  });
  const again = await call('wit_work_item_link_write', {
    action: 'link',
    project,
    id: first.id,
    revision: linked.revision,
    targetId: second.id,
    relationship: 'related',
  });
  assert.equal(again.alreadyLinked, true);
  current = await call('wit_work_item', {
    action: 'get',
    project,
    id: first.id,
  });
  await call('wit_work_item_link_write', {
    action: 'link_to_pull_request',
    ...context,
    id: first.id,
    revision: current.revision,
  });
  const links = await call('wit_work_item', {
    action: 'get_links',
    project,
    id: first.id,
  });
  assert.ok(
    links.items.some(
      (item) => item.relationship === 'related' && item.targetId === second.id,
    ),
  );
  assert.ok(
    links.items.some(
      (item) =>
        item.relationship === 'pull_request' &&
        item.pullRequestId === created.pullRequestId,
    ),
  );
  const prItems = await call('repo_pull_request', {
    action: 'get_work_items',
    ...context,
  });
  assert.ok(prItems.items.some((item) => item.id === first.id));
  // Add a parent/child relationship using a third item to avoid duplicate pair constraints.
  const third = await call('wit_work_item_write', {
    action: 'create',
    project,
    type,
    fields: { 'System.Title': `${title} child` },
  });
  resources.workItemIds.push(third.id);
  await report(false);
  current = await call('wit_work_item', {
    action: 'get',
    project,
    id: second.id,
  });
  await call('wit_work_item_link_write', {
    action: 'link',
    project,
    id: second.id,
    revision: current.revision,
    targetId: third.id,
    relationship: 'child',
  });
  const childLinks = await call('wit_work_item', {
    action: 'get_links',
    project,
    id: third.id,
  });
  assert.ok(
    childLinks.items.some(
      (item) => item.relationship === 'parent' && item.targetId === second.id,
    ),
  );
  checks.push(
    'related/parent/child/PR links, duplicate detection and both-sided inspection',
  );

  if (process.env.ADO_TEST_UNLISTED_REPOSITORY) {
    await call(
      'repo_pull_request_thread_write',
      {
        action: 'create',
        ...context,
        repository: process.env.ADO_TEST_UNLISTED_REPOSITORY,
        content: 'must fail',
      },
      'REPOSITORY_NOT_ALLOWED',
    );
    await call(
      'wit_work_item_link_write',
      {
        action: 'link_to_pull_request',
        ...context,
        repository: process.env.ADO_TEST_UNLISTED_REPOSITORY,
        id: first.id,
        revision: current.revision,
      },
      'REPOSITORY_NOT_ALLOWED',
    );
    checks.push(
      'unlisted repository discussion and work-item/PR link writes rejected',
    );
  }
  if (process.env.ADO_TEST_UNLISTED_WORK_ITEM_ID) {
    const outsideId = Number(process.env.ADO_TEST_UNLISTED_WORK_ITEM_ID);
    await call(
      'wit_work_item',
      { action: 'get', project, id: outsideId },
      'WORK_ITEM_PROJECT_NOT_ALLOWED',
    );
    await call(
      'wit_work_item',
      { action: 'get_batch', project, ids: [first.id, outsideId] },
      'WORK_ITEM_PROJECT_NOT_ALLOWED',
    );
    current = await call('wit_work_item', {
      action: 'get',
      project,
      id: first.id,
    });
    await call(
      'wit_work_item_link_write',
      {
        action: 'link',
        project,
        id: first.id,
        revision: current.revision,
        targetId: outsideId,
        relationship: 'related',
      },
      'WORK_ITEM_PROJECT_NOT_ALLOWED',
    );
    const scopedResult = await call('wit_query', {
      action: 'wiql',
      project,
      wiql: `SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.Id] = ${first.id} OR [System.Id] = ${outsideId}`,
      top: 100,
    });
    assert.deepEqual(
      scopedResult.items.map((item) => item.id),
      [first.id],
    );
    checks.push('cross-project work-item ID/batch/link rejections');
  }
  assert.equal(stderr, '', 'Unexpected child stderr.');
  resources.repositoryId = resolved.id;
  stage = 'complete';
  await report(true);
  console.log(
    JSON.stringify({ passed: true, checks: checks.length, reportPath }),
  );
} catch (error) {
  const message = redact(
    error instanceof Error ? error.message : 'Phase 2 acceptance failed.',
  );
  await report(false, message).catch(() => {});
  console.error(
    JSON.stringify({ passed: false, stage, error: message, reportPath }),
  );
  process.exitCode = 1;
} finally {
  await client?.close();
  await transport?.close();
}
