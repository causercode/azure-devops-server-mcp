import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createSecretRedactor, PatAuthProvider } from '../dist/ado/auth.js';
import { AdoClient } from '../dist/ado/client.js';
import { repositorySchema } from '../dist/ado/types.js';
import { loadConfig } from '../dist/config.js';

// Deliberately separate from the offline suite: this creates/edits a real lab PR.
const serverUrl = new URL(process.env.ADO_SERVER_URL ?? 'http://invalid/');
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(serverUrl.hostname),
  'Live acceptance is restricted to a loopback test server.',
);
const project = process.env.ADO_PROJECT;
const repository = process.env.ADO_TEST_REPOSITORY ?? 'mcp-acceptance';
const sourceBranch =
  process.env.ADO_TEST_SOURCE_BRANCH ?? 'feature/mcp-acceptance';
const targetBranch = process.env.ADO_TEST_TARGET_BRANCH ?? 'develop';
assert.ok(project, 'Configure ADO_PROJECT for the disposable test project.');
assert.ok(
  process.env.ADO_ALLOWED_REPOSITORIES !== undefined,
  'Configure ADO_ALLOWED_REPOSITORIES for only the disposable test repository; PR writes require explicit scope.',
);
assert.ok(
  process.env.ADO_TOKEN,
  'Configure the lab PAT in the process environment.',
);
const redact = createSecretRedactor(process.env.ADO_TOKEN);
const client = new Client({ name: 'live-acceptance', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('dist/index.js')],
  env: Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  ),
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (chunk) => {
  stderr += String(chunk);
});
const checks = [];

async function call(name, args, expectError = false) {
  const result = await client.callTool({ name, arguments: args });
  const serialized = JSON.stringify(result);
  assert.ok(
    !serialized.includes(process.env.ADO_TOKEN) &&
      !serialized.includes(
        Buffer.from(`:${process.env.ADO_TOKEN}`).toString('base64'),
      ),
    'Credentials appeared in a tool result.',
  );
  assert.equal(
    result.isError === true,
    expectError,
    `${name}/${args.action ?? 'get'} returned an unexpected error state: ${serialized}`,
  );
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content.find((item) => item.type === 'text')?.text ?? '';
  if (expectError) return { error: { message: text } };
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 5);
  checks.push('five tools advertised');
  const diagnostics = await call('server_info', {});
  assert.equal(diagnostics.connected, true);
  const projects = await call('server_info', {
    action: 'list_projects',
    top: 100,
  });
  assert.ok(projects.items.some((item) => item.name === project));
  checks.push('connectivity and project discovery');
  const repos = await call('repo_repository', { action: 'list', project });
  assert.ok(repos.items.some((item) => item.name === repository));
  const resolvedRepo = await call('repo_repository', {
    action: 'get',
    project,
    repository,
  });
  const byId = await call('repo_repository', {
    action: 'get',
    project: resolvedRepo.project.id,
    repository: resolvedRepo.id,
  });
  assert.equal(byId.id, resolvedRepo.id);
  checks.push('repository discovery by name and ID');
  const branches = await call('repo_branch', {
    action: 'list',
    project,
    repository,
  });
  assert.ok(branches.items.some((item) => item.name === targetBranch));
  for (const branch of [sourceBranch, targetBranch]) {
    const result = await call('repo_branch', {
      action: 'get',
      project,
      repository,
      branch,
    });
    assert.equal(result.name, branch);
  }
  checks.push('remote branch list and exact lookups');
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
    'An active PR already exists. Use a fresh disposable source branch before rerunning.',
  );
  const title = `Live MCP acceptance ${new Date().toISOString()}`;
  const created = await call('repo_pull_request_write', {
    action: 'create',
    project,
    repository,
    sourceBranch: `refs/heads/${sourceBranch}`,
    targetBranch,
    title,
    description: 'Disposable PR created by the live stdio acceptance check.',
    isDraft: true,
  });
  assert.ok(created.pullRequestId > 0);
  assert.equal(created.sourceBranch, sourceBranch);
  assert.equal(created.targetBranch, targetBranch);
  assert.equal(created.isDraft, true);
  assert.equal(new URL(created.url).origin, serverUrl.origin);
  checks.push('PR creation with numeric ID and browser URL');
  // Print the created PR immediately so an interrupted test can inspect its outcome.
  console.log(
    JSON.stringify({ pullRequestId: created.pullRequestId, url: created.url }),
  );
  const input = { project, repository, pullRequestId: created.pullRequestId };
  const get = await call('repo_pull_request', { action: 'get', ...input });
  assert.equal(get.title, title);
  const list = await call('repo_pull_request', {
    action: 'list',
    project,
    repository,
    sourceBranch,
    targetBranch,
  });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].pullRequestId, created.pullRequestId);
  checks.push('PR read and filtered list; one PR created');
  const updated = await call('repo_pull_request_write', {
    action: 'update',
    ...input,
    title: `${title} — verified`,
    description:
      'Title, description, and draft updates verified on the live server.',
    isDraft: false,
  });
  assert.equal(updated.isDraft, false);
  assert.equal(updated.title, `${title} — verified`);
  const cleared = await call('repo_pull_request_write', {
    action: 'update',
    ...input,
    description: '',
    isDraft: true,
  });
  assert.equal(cleared.description, '');
  assert.equal(cleared.isDraft, true);
  checks.push('title, description, draft, empty string and false updates');
  for (const args of [
    { action: 'update', ...input, status: 'completed' },
    { action: 'update', ...input, completionOptions: { bypassPolicy: true } },
    {
      action: 'create',
      project,
      repository,
      sourceBranch: targetBranch,
      targetBranch,
      title: 'Must not be created',
    },
    {
      action: 'create',
      project,
      repository,
      sourceBranch: 'feature/does-not-exist-live-acceptance',
      targetBranch,
      title: 'Must not be created',
    },
  ]) {
    await call('repo_pull_request_write', args, true);
  }
  checks.push('unsafe, identical-branch and missing-branch writes rejected');
  const unlistedRepository = process.env.ADO_TEST_UNLISTED_REPOSITORY;
  if (unlistedRepository) {
    // Lab-only proof: the PAT can read this disposable repository, but MCP scope rejects it.
    const config = loadConfig();
    const rest = new AdoClient(config, new PatAuthProvider(config.token));
    const { data: unlisted } = await rest.request(
      [project, '_apis', 'git', 'repositories', unlistedRepository],
      repositorySchema,
    );
    assert.notEqual(
      unlisted.id,
      resolvedRepo.id,
      'Select a different repository for the scope rejection check.',
    );
    for (const selector of [unlisted.name, unlisted.id]) {
      for (const [name, args] of [
        ['repo_repository', { action: 'get' }],
        ['repo_branch', { action: 'list' }],
        ['repo_pull_request', { action: 'list' }],
        [
          'repo_pull_request_write',
          {
            action: 'create',
            sourceBranch,
            targetBranch,
            title: 'Must not be created outside scope',
          },
        ],
        [
          'repo_pull_request_write',
          {
            action: 'update',
            pullRequestId: created.pullRequestId,
            title: 'Must not be updated outside scope',
          },
        ],
      ]) {
        const denied = await call(
          name,
          { ...args, project, repository: selector },
          true,
        );
        assert.equal(denied.error.code, 'REPOSITORY_NOT_ALLOWED');
      }
    }
    checks.push(
      'unlisted repository reads/writes denied by name and ID despite PAT access',
    );
  }
  assert.equal(stderr, '', 'The server emitted unexpected stderr.');
  const report = {
    date: new Date().toISOString(),
    apiVersion: diagnostics.apiVersion,
    reportedProductVersion: diagnostics.reportedProductVersion,
    transport: 'compiled CLI over stdio',
    pullRequestId: created.pullRequestId,
    url: created.url,
    checks,
  };
  const reportPath =
    process.env.ADO_LIVE_REPORT ?? 'live-acceptance.local.json';
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, reportPath, checks }));
} catch (error) {
  console.error(
    redact(error instanceof Error ? error.message : 'Live acceptance failed.'),
  );
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
}
