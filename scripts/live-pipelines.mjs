import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// Separate guarded lab runner. No setup, agent installation or definition mutation.
const url = new URL(process.env.ADO_SERVER_URL ?? 'http://invalid/');
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
  'Phase3 live tests require a loopback disposable lab.',
);
const repository = process.env.ADO_PHASE3_REPOSITORY;
assert.ok(repository, 'ADO_PHASE3_REPOSITORY is required.');
assert.ok(process.env.ADO_TOKEN, 'A local process PAT is required.');
const scope = JSON.parse(process.env.ADO_ALLOWED_REPOSITORIES ?? 'null');
assert.ok(
  Array.isArray(scope) && scope.length === 1,
  'Live tests require exactly one approved disposable repository.',
);
const project = process.env.ADO_PROJECT;
const context = { project, repository };
const checks = [];
const client = new Client({ name: 'live-pipelines', version: '0.3.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(process.env.ADO_PHASE3_ENTRYPOINT ?? 'dist/index.js')],
  env: Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined),
  ),
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (chunk) => {
  stderr += String(chunk);
});
let buildId = Number(process.env.ADO_PHASE3_BUILD_ID) || undefined;
let definitionId = Number(process.env.ADO_PHASE3_DEFINITION_ID) || undefined;
const reportPath = process.env.ADO_PHASE3_REPORT ?? 'live-pipelines.local.json';
async function call(name, args, expectedError = false) {
  const r = await client.callTool({ name, arguments: { ...context, ...args } });
  const serialized = JSON.stringify(r);
  assert.ok(
    !serialized.includes(process.env.ADO_TOKEN) &&
      !serialized.includes(
        Buffer.from(`:${process.env.ADO_TOKEN}`).toString('base64'),
      ),
    'A credential appeared in a result.',
  );
  assert.equal(
    r.isError === true,
    expectedError,
    `Unexpected ${name} result; error code ${r.structuredContent?.error?.code ?? 'input/unknown'}. Inspect privately.`,
  );
  return r.structuredContent;
}
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const name of [
    'pipelines_definition',
    'pipelines_build',
    'pipelines_build_log',
    'pipelines_run',
    'pipelines_write',
    'testplan_show_test_results_from_build_id',
  ])
    assert.ok(names.includes(name));
  checks.push('pipeline tool discovery');
  const repo = await call('repo_repository', { action: 'get' });
  const byId = await call('repo_repository', {
    action: 'get',
    project: repo.project.id,
    repository: repo.id,
  });
  assert.equal(byId.id, repo.id);
  checks.push('repository names and GUIDs');
  const definitions = await call('pipelines_definition', {
    action: 'list',
    top: 10,
  });
  const builds = await call('pipelines_build', { action: 'list', top: 10 });
  assert.ok(Array.isArray(definitions.items) && Array.isArray(builds.items));
  checks.push('definition and build discovery');
  if (process.env.ADO_PHASE3_EXCLUDED_REPOSITORY) {
    const denied = await call(
      'pipelines_definition',
      {
        action: 'list',
        repository: process.env.ADO_PHASE3_EXCLUDED_REPOSITORY,
      },
      true,
    );
    assert.equal(denied.error.code, 'REPOSITORY_NOT_ALLOWED');
    checks.push('excluded repository denied');
  }
  if (process.env.ADO_PHASE3_QUEUE === '1') {
    assert.ok(
      !buildId,
      'Use either an existing build ID or queue a new build, never both.',
    );
    assert.ok(
      definitionId &&
        process.env.ADO_PHASE3_BRANCH &&
        process.env.ADO_PHASE3_COMMIT,
      'Queue tests require explicit definition, branch and commit.',
    );
    assert.equal(
      process.env.ADO_PHASE3_AGENT_READY,
      '1',
      'Confirm the disposable agent is online with ADO_PHASE3_AGENT_READY=1 before queueing.',
    );
    const queued = await call('pipelines_write', {
      action: 'run_pipeline',
      definitionId,
      branch: process.env.ADO_PHASE3_BRANCH,
      commit: process.env.ADO_PHASE3_COMMIT,
    });
    assert.equal(queued.queueAccepted, true);
    assert.equal(queued.completionVerified, false);
    buildId = queued.build.id;
    // Save the accepted ID immediately so a later failure can be resumed without requeueing.
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          state: 'queue accepted; read verification pending',
          buildId,
          definitionId,
          checks,
        },
        null,
        2,
      ),
    );
    checks.push('explicit scoped queue accepted');
  }
  if (buildId) {
    let build = await call('pipelines_build', {
      action: 'get_status',
      buildId,
    });
    definitionId ??= build.definition.id;
    const timeout =
      Date.now() + Number(process.env.ADO_PHASE3_WAIT_MS ?? '180000');
    while (
      process.env.ADO_PHASE3_QUEUE === '1' &&
      build.status !== 'completed' &&
      Date.now() < timeout
    ) {
      console.log('Waiting for the accepted disposable build to complete.');
      await setTimeout(10000);
      build = await call('pipelines_build', { action: 'get_status', buildId });
    }
    if (process.env.ADO_PHASE3_QUEUE === '1')
      assert.equal(
        build.status,
        'completed',
        'Accepted build did not complete; resume using its saved ID, do not queue again.',
      );
    checks.push('validated build status');
    const run = await call('pipelines_run', {
      action: 'get',
      definitionId,
      runId: buildId,
    });
    assert.equal(run.id, buildId);
    checks.push('run to build definition mapping');
    const timeline = await call('pipelines_build', {
      action: 'get_timeline',
      buildId,
      top: 2,
    });
    assert.ok(timeline.items.length <= 2);
    checks.push('bounded timeline');
    const logs = await call('pipelines_build_log', {
      action: 'list',
      buildId,
      top: 2,
    });
    assert.ok(logs.items.length <= 2);
    if (logs.items.length) {
      const excerpt = await call('pipelines_build_log', {
        action: 'get_content',
        buildId,
        logId: logs.items[0].id,
        maxLines: 2,
      });
      assert.ok(excerpt.content.length <= 16000 && excerpt.lineCount <= 2);
      if (excerpt.nextStartLine) {
        const next = await call('pipelines_build_log', {
          action: 'get_content',
          buildId,
          logId: logs.items[0].id,
          maxLines: 2,
          startLine: excerpt.nextStartLine,
          startColumn: excerpt.nextStartColumn,
        });
        assert.equal(next.startLine, excerpt.nextStartLine);
      }
      checks.push('bounded log text and continuation');
    }
    const tests = await call('testplan_show_test_results_from_build_id', {
      action: 'list_runs',
      buildId,
      top: 10,
    });
    if (process.env.ADO_PHASE3_EXPECT_TEST_RESULTS === '1')
      assert.ok(
        tests.items.length,
        'Expected automated results were not published.',
      );
    if (tests.items.length) {
      const testRun = await call('testplan_show_test_results_from_build_id', {
        action: 'get_run',
        buildId,
        runId: tests.items[0].id,
      });
      assert.equal(Number(testRun.build.id), buildId);
      const results = await call('testplan_show_test_results_from_build_id', {
        action: 'list_results',
        buildId,
        runId: testRun.id,
        outcome: 'Failed',
        top: 2,
      });
      assert.ok(results.items.length <= 2);
      if (process.env.ADO_PHASE3_EXPECT_TEST_RESULTS === '1')
        assert.ok(
          results.items.length,
          'Expected deterministic failure was not published.',
        );
      if (results.items.length) {
        const failure = await call('testplan_show_test_results_from_build_id', {
          action: 'get_result',
          buildId,
          runId: testRun.id,
          resultId: results.items[0].id,
        });
        assert.equal(failure.outcome, 'Failed');
        assert.ok(
          (failure.errorMessage?.length ?? 0) <= 4000 &&
            (failure.stackTrace?.length ?? 0) <= 4000,
        );
      }
      checks.push('automated run linkage and bounded failure details');
    }
  }
  assert.equal(stderr, '', 'Unexpected CLI stderr; inspect privately.');
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        state: 'passed',
        mode: buildId ? 'build diagnostics' : 'discovery only',
        buildId,
        definitionId,
        checks,
      },
      null,
      2,
    ),
  );
  console.log(
    `Phase3 live acceptance passed ${checks.length} checks (${buildId ? 'build diagnostics' : 'discovery only'}).`,
  );
} catch (e) {
  console.error(
    e instanceof assert.AssertionError
      ? e.message
      : 'Phase3 live acceptance failed; inspect private report/state before any queue retry.',
  );
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
}
