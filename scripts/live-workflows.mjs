import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadConfig } from '../dist/config.js';
import { authSecrets, createSecretRedactor } from '../dist/ado/auth.js';

// Two-stage loopback acceptance: prepare a ticket, implement/test/push through
// local client tools, then verify the exact pushed commit and linked draft PR.
// This runner never runs Git, changes the checkout, queues builds or merges PRs.
const mode = process.env.ADO_WORKFLOW_MODE ?? 'verify';
const reportPath =
  process.env.ADO_WORKFLOW_REPORT ?? 'workflow-acceptance.local.json';
const resources = {};
const checks = [];
let client;
let transport;
let buildClient;
let buildTransport;
let stage = 'configuration';
let redact = (text) => text;
let credentialSecrets = [];
async function save(state, errorCode) {
  await writeFile(
    reportPath,
    `${redact(JSON.stringify({ date: new Date().toISOString(), state, mode, stage, checks, resources, ...(errorCode ? { errorCode } : {}) }, null, 2))}\n`,
  );
}
function positiveId(value, name) {
  assert.ok(
    /^[1-9]\d{0,9}$/u.test(value ?? '') && Number(value) <= 2147483647,
    `${name} must be a positive int32 ID.`,
  );
  return Number(value);
}
function sameBranch(actual, requested) {
  return (
    actual ===
    (requested.startsWith('refs/heads/')
      ? requested
      : `refs/heads/${requested}`)
  );
}
try {
  const config = loadConfig();
  credentialSecrets = authSecrets(config);
  redact = createSecretRedactor(credentialSecrets);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(
      new URL(config.serverUrl).hostname,
    ),
    'Workflow acceptance is restricted to a loopback lab.',
  );
  assert.ok(
    ['prepare', 'verify'].includes(mode),
    'ADO_WORKFLOW_MODE must be prepare or verify.',
  );
  assert.ok(
    ['7.0', '7.1'].includes(config.apiVersion),
    'Workflow acceptance requires REST 7.0 or 7.1.',
  );
  assert.equal(
    config.allowedRepositories?.length,
    1,
    'Configure exactly one approved disposable repository.',
  );
  assert.equal(
    config.allowedWorkItemProjects?.length,
    1,
    'Configure exactly one work-item read project.',
  );
  assert.equal(
    config.workItemWriteProjects?.length,
    1,
    'Configure exactly one work-item write project.',
  );
  const project = config.project;
  const repository = process.env.ADO_WORKFLOW_REPOSITORY;
  const targetBranch = process.env.ADO_WORKFLOW_TARGET_BRANCH ?? 'develop';
  assert.ok(
    project && repository,
    'Configure ADO_PROJECT and ADO_WORKFLOW_REPOSITORY.',
  );
  const context = { project, repository };
  let workItemId;
  let sourceBranch;
  let testedCommit;
  if (mode === 'prepare') {
    // Do not overwrite evidence for an earlier resource creation.
    const prior = await readFile(reportPath, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    assert.equal(
      prior,
      undefined,
      'Use a fresh report path for prepare; existing evidence must be preserved.',
    );
  } else {
    workItemId = positiveId(
      process.env.ADO_WORKFLOW_WORK_ITEM_ID,
      'ADO_WORKFLOW_WORK_ITEM_ID',
    );
    sourceBranch = process.env.ADO_WORKFLOW_SOURCE_BRANCH;
    testedCommit = process.env.ADO_WORKFLOW_TESTED_COMMIT?.toLowerCase();
    assert.ok(
      sourceBranch?.startsWith('phase4-mcp-'),
      'Use a fresh phase4-mcp- source branch.',
    );
    assert.ok(
      /^[a-f\d]{40}$/u.test(testedCommit ?? ''),
      'ADO_WORKFLOW_TESTED_COMMIT must be the exact locally tested commit.',
    );
  }
  const entrypoint = resolve(
    process.env.ADO_WORKFLOW_ENTRYPOINT ?? 'dist/index.js',
  );
  client = new Client({ name: 'workflow-live-acceptance', version: '0.4.0' });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ),
    stderr: 'pipe',
  });
  // Never surface arbitrary child diagnostics; they can include private data.
  let stderrReceived = false;
  transport.stderr?.on('data', () => {
    stderrReceived = true;
  });
  await client.connect(transport);
  async function call(name, args, target = client) {
    stage = `${name}/${args.action ?? 'get'}`;
    const result = await target.callTool({ name, arguments: args });
    const serialized = JSON.stringify(result);
    assert.ok(
      credentialSecrets.every(
        (secret) =>
          !serialized.includes(secret) &&
          !serialized.includes(Buffer.from(`:${secret}`).toString('base64')),
      ),
      'A credential appeared in a tool response.',
    );
    const data = result.structuredContent;
    if (result.isError || !data) {
      const error = new Error(
        'MCP workflow operation failed; inspect remote state before retrying writes.',
      );
      error.code = data?.error?.code ?? 'MCP_ERROR';
      throw error;
    }
    return data;
  }
  async function prompt(name, args, target = client) {
    stage = `prompt/${name}`;
    const result = await target.getPrompt({ name, arguments: args });
    assert.equal(
      result.messages[0]?.role,
      'user',
      'Expected workflow guidance.',
    );
    assert.ok(
      result.messages[0]?.content.text?.includes('untrusted data'),
      'Expected remote-data trust boundary.',
    );
  }
  const names = (await client.listPrompts()).prompts.map((p) => p.name);
  assert.ok(
    [
      'work_item_to_pull_request',
      'review_pull_request',
      'diagnose_build',
    ].every((name) => names.includes(name)),
    'Expected all three workflow prompts.',
  );
  checks.push('workflow prompt discovery');
  await call('server_info', {});
  const repo = await call('repo_repository', { action: 'get', ...context });
  resources.projectId = repo.project.id;
  resources.repositoryId = repo.id;
  await call('repo_branch', {
    action: 'get',
    ...context,
    branch: targetBranch,
  });
  checks.push('authorized repository and explicit target');
  if (mode === 'prepare') {
    const type = process.env.ADO_WORKFLOW_WORK_ITEM_TYPE ?? 'Task';
    await call('wit_work_item', { action: 'get_type', project, type });
    const item = await call('wit_work_item_write', {
      action: 'create',
      project,
      type,
      fields: {
        'System.Title': `Workflow acceptance ${new Date().toISOString()}`,
        'System.Description':
          'In an isolated lab clone, add workflow-acceptance.mjs exporting add(a, b), and workflow-acceptance.test.mjs using node:test to verify positive, zero and negative integer addition. Run node --test workflow-acceptance.test.mjs, commit and push a fresh phase4-mcp- branch, and create/link a draft PR. Do not merge or close this task.',
      },
    });
    workItemId = item.id;
    resources.workItemId = workItemId;
    resources.workItemRevision = item.revision;
    await save('work item created; local implementation pending');
  }
  const item = await call('wit_work_item', {
    action: 'get',
    project,
    id: workItemId,
  });
  assert.equal(item.id, workItemId, 'Unexpected work item.');
  resources.workItemId = workItemId;
  resources.workItemRevision = item.revision;
  await prompt('work_item_to_pull_request', {
    ...context,
    workItemId: String(workItemId),
    targetBranch,
  });
  checks.push('work item read and implementation guidance');
  if (mode === 'prepare') {
    assert.equal(stderrReceived, false, 'Unexpected CLI diagnostics.');
    await save('prepared; implement, test and push locally before verify');
    console.log(
      `Workflow preparation passed ${checks.length} checks; ticket ID is in the private report.`,
    );
  } else {
    const branch = await call('repo_branch', {
      action: 'get',
      ...context,
      branch: sourceBranch,
    });
    assert.equal(
      branch.commitId.toLowerCase(),
      testedCommit,
      'The pushed branch must match the locally tested commit.',
    );
    resources.sourceCommit = testedCommit;
    resources.sourceBranch = sourceBranch;
    checks.push('exact tested and pushed commit');
    const existing = [];
    let skip = 0;
    do {
      const page = await call('repo_pull_request', {
        action: 'list',
        ...context,
        sourceBranch,
        targetBranch,
        status: 'all',
        top: 100,
        skip,
      });
      existing.push(...page.items);
      skip = page.nextSkip;
      assert.ok(
        existing.length <= 1000,
        'Too many matching PRs; inspect manually.',
      );
    } while (skip !== undefined);
    assert.ok(
      existing.length <= 1,
      'Multiple matching PRs require manual inspection.',
    );
    let pr = existing[0];
    if (pr)
      assert.ok(
        pr.status === 'active' && pr.isDraft,
        'An existing completed, abandoned or non-draft PR requires an explicit decision.',
      );
    else
      pr = await call('repo_pull_request_write', {
        action: 'create',
        ...context,
        sourceBranch,
        targetBranch,
        title: `Workflow acceptance for work item ${workItemId}`,
        description: `Implements work item ${workItemId}. Local node:test checks were run before pushing commit ${testedCommit}. This is retained disposable lab acceptance; no merge requested.`,
        isDraft: true,
      });
    resources.pullRequestId = pr.pullRequestId;
    resources.pullRequestUrl = pr.url;
    await save('draft PR identified; link and review pending');
    const prContext = { ...context, pullRequestId: pr.pullRequestId };
    pr = await call('repo_pull_request', { action: 'get', ...prContext });
    assert.ok(
      pr.isDraft &&
        pr.status === 'active' &&
        sameBranch(`refs/heads/${pr.sourceBranch}`, sourceBranch) &&
        sameBranch(`refs/heads/${pr.targetBranch}`, targetBranch),
      'PR state or branches do not match the checkpoint.',
    );
    const current = await call('wit_work_item', {
      action: 'get',
      project,
      id: workItemId,
    });
    const linked = await call('wit_work_item_link_write', {
      action: 'link_to_pull_request',
      ...prContext,
      id: workItemId,
      revision: current.revision,
    });
    resources.workItemRevision = linked.revision;
    await save('draft PR linked; review pending');
    const links = await call('wit_work_item', {
      action: 'get_links',
      project,
      id: workItemId,
    });
    assert.ok(
      links.items.some(
        (link) =>
          link.relationship === 'pull_request' &&
          link.pullRequestId === pr.pullRequestId,
      ),
      'Work item does not expose the verified PR link.',
    );
    const prItems = await call('repo_pull_request', {
      action: 'get_work_items',
      ...prContext,
    });
    assert.ok(
      prItems.items.some((wi) => wi.id === workItemId),
      'PR does not expose the verified work item.',
    );
    checks.push('draft PR read-back and reciprocal work-item link');
    await prompt('review_pull_request', {
      ...context,
      pullRequestId: String(pr.pullRequestId),
    });
    const changes = await call('repo_pull_request', {
      action: 'get_changes',
      ...prContext,
      top: 100,
    });
    assert.equal(
      changes.sourceCommit.toLowerCase(),
      testedCommit,
      'PR source changed since local validation.',
    );
    assert.equal(
      changes.nextSkip,
      undefined,
      'Acceptance fixture must fit one changed-file page.',
    );
    assert.ok(
      changes.items.length,
      'Expected a reviewable implementation change.',
    );
    for (const change of changes.items) {
      if (['delete', 16].includes(change.changeType)) continue;
      const file = await call('repo_file', {
        action: 'get_content',
        ...context,
        path: change.item.path,
        commit: changes.sourceCommit,
        maxLines: 200,
      });
      assert.equal(
        file.commit,
        testedCommit,
        'File was not read at the tested commit.',
      );
      assert.equal(
        file.nextStartLine,
        undefined,
        'Acceptance files must fit the review excerpt.',
      );
    }
    resources.reviewIterationId = changes.iterationId;
    checks.push('pinned PR changes and text file review');
    const reviewerId = process.env.ADO_WORKFLOW_REVIEWER_ID;
    if (reviewerId) {
      const person = await call('core_identity', {
        action: 'get',
        ...context,
        identityId: reviewerId,
      });
      assert.equal(
        person.id.toLowerCase(),
        reviewerId.toLowerCase(),
        'Unexpected reviewer identity.',
      );
      await call('repo_pull_request_write', {
        action: 'update_reviewers',
        ...prContext,
        operation: 'add',
        reviewerId,
      });
      const reviewers = await call('repo_pull_request', {
        action: 'list_reviewers',
        ...prContext,
      });
      assert.ok(
        reviewers.items.some(
          (r) => r.id.toLowerCase() === reviewerId.toLowerCase(),
        ),
        'Reviewer assignment not verified.',
      );
      resources.reviewerAssigned = true;
      checks.push('explicit reviewer assignment and read-back');
    }
    const content = `Workflow acceptance: reviewed pinned commit ${testedCommit}; local checks recorded separately. Human approval is still required.`;
    const threads = await call('repo_pull_request_thread', {
      action: 'list',
      ...prContext,
      top: 100,
    });
    assert.equal(
      threads.nextSkip,
      undefined,
      'Inspect further discussion pages manually.',
    );
    assert.ok(
      threads.items.every((thread) => !thread.commentsTruncated),
      'Inspect full discussion comments before deciding whether another thread is needed.',
    );
    let thread = threads.items.find((t) =>
      t.comments?.some((c) => c.text === content),
    );
    if (!thread)
      thread = await call('repo_pull_request_thread_write', {
        action: 'create',
        ...prContext,
        content,
      });
    resources.threadId = thread.id;
    await save('review discussion identified; read-back pending');
    const comments = await call('repo_pull_request_thread', {
      action: 'list_comments',
      ...prContext,
      threadId: thread.id,
    });
    assert.ok(
      comments.items.some((c) => c.text === content),
      'Review discussion not verified.',
    );
    checks.push('review discussion and read-back');
    if (process.env.ADO_WORKFLOW_BUILD_ID) {
      const buildId = positiveId(
        process.env.ADO_WORKFLOW_BUILD_ID,
        'ADO_WORKFLOW_BUILD_ID',
      );
      let diagnosticClient = client;
      if (process.env.ADO_WORKFLOW_BUILD_ENV_FILE) {
        const buildEnv = parseEnv(
          await readFile(process.env.ADO_WORKFLOW_BUILD_ENV_FILE, 'utf8'),
        );
        const buildConfig = loadConfig(buildEnv);
        assert.ok(
          buildConfig.serverUrl === config.serverUrl &&
            buildConfig.collection === config.collection,
          'Build diagnostics must use the same server and collection.',
        );
        credentialSecrets.push(...authSecrets(buildConfig));
        redact = createSecretRedactor(credentialSecrets);
        buildClient = new Client({
          name: 'workflow-build-diagnostics',
          version: '0.4.0',
        });
        buildTransport = new StdioClientTransport({
          command: process.execPath,
          args: [entrypoint],
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([key, value]) =>
                  value !== undefined && !key.startsWith('ADO_'),
              ),
            ),
            ...buildEnv,
          },
          stderr: 'pipe',
        });
        buildTransport.stderr?.on('data', () => {
          stderrReceived = true;
        });
        await buildClient.connect(buildTransport);
        diagnosticClient = buildClient;
        const buildRepo = await call(
          'repo_repository',
          { action: 'get', ...context },
          diagnosticClient,
        );
        assert.ok(
          buildRepo.id.toLowerCase() === repo.id.toLowerCase() &&
            buildRepo.project.id.toLowerCase() ===
              repo.project.id.toLowerCase(),
          'Build credential resolved a different repository.',
        );
      }
      await prompt(
        'diagnose_build',
        { ...context, buildId: String(buildId) },
        diagnosticClient,
      );
      const build = await call(
        'pipelines_build',
        { action: 'get_status', ...context, buildId },
        diagnosticClient,
      );
      assert.ok(
        build.sourceVersion.toLowerCase() === testedCommit &&
          sameBranch(build.sourceBranch, sourceBranch),
        'Build does not validate this branch and tested commit.',
      );
      resources.buildId = buildId;
      resources.buildStatus = build.status;
      resources.buildResult = build.result ?? null;
      resources.buildSourceVerified = true;
      resources.buildCompletionVerified = build.status === 'completed';
      const timeline = await call(
        'pipelines_build',
        { action: 'get_timeline', ...context, buildId, top: 10 },
        diagnosticClient,
      );
      const logId = timeline.items.find(
        (record) => record.result === 'failed' && record.log,
      )?.log?.id;
      if (logId)
        await call(
          'pipelines_build_log',
          { action: 'get_content', ...context, buildId, logId, maxLines: 10 },
          diagnosticClient,
        );
      const runs = await call(
        'testplan_show_test_results_from_build_id',
        { action: 'list_runs', ...context, buildId, top: 10 },
        diagnosticClient,
      );
      resources.automatedTestRunCount = runs.items.length;
      for (const run of runs.items) {
        const results = await call(
          'testplan_show_test_results_from_build_id',
          {
            action: 'list_results',
            ...context,
            buildId,
            runId: run.id,
            outcome: 'Failed',
            top: 10,
          },
          diagnosticClient,
        );
        if (results.items[0])
          await call(
            'testplan_show_test_results_from_build_id',
            {
              action: 'get_result',
              ...context,
              buildId,
              runId: run.id,
              resultId: results.items[0].id,
            },
            diagnosticClient,
          );
      }
      checks.push('matching build source and bounded automated diagnostics');
    } else resources.ciVerified = false;
    const latest = await call('repo_pull_request', {
      action: 'get_changes',
      ...prContext,
      top: 1,
    });
    assert.equal(
      latest.sourceCommit,
      changes.sourceCommit,
      'PR changed during review.',
    );
    assert.equal(
      latest.iterationId,
      changes.iterationId,
      'PR iteration changed during review.',
    );
    assert.equal(stderrReceived, false, 'Unexpected CLI diagnostics.');
    checks.push('review checkpoint remains current');
    await save('passed; retained draft PR requires human review');
    console.log(
      `Workflow acceptance passed ${checks.length} checks. Resource IDs and checkpoints are in the private report.`,
    );
  }
} catch (error) {
  // Error details/assertion payloads can contain server text or credentials.
  // Preserve a code and stage only. Never overwrite prior prepare evidence.
  if (!(mode === 'prepare' && stage === 'configuration'))
    await save(
      'failed; inspect checkpoint before any write retry',
      error.code ?? 'ACCEPTANCE_FAILED',
    ).catch(() => {});
  console.error(
    `Workflow acceptance failed at ${stage}; code ${error.code ?? 'ACCEPTANCE_FAILED'}. Inspect private state before retrying.`,
  );
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
  await buildClient?.close().catch(() => {});
  await buildTransport?.close().catch(() => {});
}
