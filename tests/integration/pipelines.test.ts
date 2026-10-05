import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import {
  BuildServer,
  commit,
  build,
  definition,
  testResult,
} from '../fixtures/build-server.js';
import { project, repository, token } from '../fixtures/ado-server.js';
describe('scoped build diagnostics over real HTTP/MCP', () => {
  let ado: BuildServer;
  let server: McpServer;
  let client: Client;
  async function connect(env: NodeJS.ProcessEnv = {}) {
    server = createServer(ado.config(env));
    client = new Client({ name: 'build-test', version: '1' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);
  }
  beforeEach(async () => {
    ado = await new BuildServer().start();
    await connect();
  });
  afterEach(async () => {
    await client.close();
    await server.close();
    await ado.close();
  });
  async function call(name: string, args: Record<string, unknown>) {
    const r = await client.callTool({
      name,
      arguments: { repository: repository.name, ...args },
    });
    expect(JSON.stringify(r)).not.toContain(token);
    return r;
  }
  async function data(name: string, args: Record<string, unknown>) {
    const r = await call(name, args);
    expect(r.isError, JSON.stringify(r)).not.toBe(true);
    return r.structuredContent;
  }
  async function error(
    name: string,
    args: Record<string, unknown>,
    code: string,
  ) {
    const r = await call(name, args);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: { code } });
  }
  const buildArgs = { action: 'get_status', buildId: 11 };
  it('discovers definitions by names and GUIDs and strips executable settings', async () => {
    ado.definition.variables = { secret: 'hidden' };
    expect(
      await data('pipelines_definition', { action: 'list' }),
    ).toMatchObject({ items: [{ id: 7, revision: 3 }] });
    const result = await data('pipelines_definition', {
      action: 'get',
      definitionId: 7,
      project: project.id,
      repository: repository.id,
    });
    expect(JSON.stringify(result)).not.toContain('hidden');
    expect(ado.requests.at(-1)?.url.pathname).toContain(project.id);
  });
  it.each(['notStarted', 'inProgress', 'completed', 'cancelling', 'postponed'])(
    'returns build state %s without conflating acceptance/completion',
    async (status) => {
      ado.build.status = status;
      expect(await data('pipelines_build', buildArgs)).toMatchObject({
        id: 11,
        status,
      });
    },
  );
  it.each(['succeeded', 'partiallySucceeded', 'failed', 'canceled'])(
    'preserves result %s',
    async (result) => {
      ado.build.result = result;
      expect(await data('pipelines_build', buildArgs)).toMatchObject({
        result,
      });
    },
  );
  it.each([
    { project: { id: 'other', name: 'Other' } },
    { repository: { id: 'other', type: 'TfsGit' } },
    { repository: { id: repository.id, type: 'GitHub' } },
    { id: 999 },
  ])('denies a hidden build before logs or tests %#', async (override) => {
    Object.assign(ado.build, override);
    await error(
      'pipelines_build_log',
      { action: 'get_content', buildId: 11, logId: 5 },
      'BUILD_NOT_ALLOWED',
    );
    await error(
      'testplan_show_test_results_from_build_id',
      { action: 'list_runs', buildId: 11 },
      'BUILD_NOT_ALLOWED',
    );
    expect(
      ado.requests.some((r) => /logs|\/test\//u.test(r.url.pathname)),
    ).toBe(false);
  });
  it('filters lists on actual source identity and preserves opaque continuation', async () => {
    ado.builds = [
      { ...build, id: 12, repository: { id: 'hidden', type: 'TfsGit' } },
      build,
    ];
    ado.continuation = 'page2';
    expect(
      await data('pipelines_build', {
        action: 'list',
        branch: 'feature/search',
        commit,
        definitionId: 7,
        status: 'completed',
        result: 'failed',
        top: 2,
      }),
    ).toMatchObject({ items: [{ id: 11 }], continuationToken: 'page2' });
    const q = ado.requests.findLast((r) =>
      r.url.pathname.endsWith('/build/builds'),
    )?.url.searchParams;
    expect(q?.get('branchName')).toBe(build.sourceBranch);
    expect(q?.get('definitions')).toBe('7');
    expect(q?.get('repositoryId')).toBe(repository.id);
    expect(
      await data('pipelines_build', { action: 'list', commit: 'b'.repeat(40) }),
    ).toMatchObject({ items: [], continuationToken: 'page2' });
  });
  it('denies mismatched definitions and run mappings', async () => {
    ado.definition.repository = { id: 'other', type: 'TfsGit' };
    await error(
      'pipelines_run',
      { action: 'get', definitionId: 7, runId: 11 },
      'BUILD_NOT_ALLOWED',
    );
    ado.definition = { ...definition };
    ado.build.definition = { id: 8 };
    await error(
      'pipelines_run',
      { action: 'get', definitionId: 7, runId: 11 },
      'RUN_DEFINITION_MISMATCH',
    );
  });
  it('bounds timeline messages and pages records', async () => {
    expect(
      await data('pipelines_build', {
        action: 'get_timeline',
        buildId: 11,
        top: 1,
      }),
    ).toMatchObject({
      items: [{ issues: [{ message: 'x'.repeat(2000), truncated: true }] }],
      nextSkip: 1,
    });
  });
  it('limits aggregate timeline issues across a full page', async () => {
    for (const messageLength of [1, 2500]) {
      ado.timelineRecords = Array.from({ length: 100 }, (_, index) => ({
        id: `task-${index}`,
        issues: Array.from({ length: 25 }, () => ({
          type: 'error',
          message: 'x'.repeat(messageLength),
        })),
      }));
      const response = (await data('pipelines_build', {
        action: 'get_timeline',
        buildId: 11,
        top: 100,
      })) as {
        items: { issues: { message: string }[]; issuesTruncated: boolean }[];
      };
      const items = response.items;
      const issues = items.flatMap((item) => item.issues);
      expect(issues.length).toBe(messageLength === 1 ? 40 : 8);
      expect(
        issues.reduce((sum, issue) => sum + issue.message.length, 0),
      ).toBeLessThanOrEqual(16000);
      expect(items.every((item) => item.issuesTruncated)).toBe(true);
    }
  });
  it('reads validated logs with inclusive zero-based REST ranges and bounded excerpts', async () => {
    expect(
      await data('pipelines_build_log', {
        action: 'get_content',
        buildId: 11,
        logId: 5,
        startLine: 1,
        maxLines: 2,
      }),
    ).toMatchObject({
      content: 'first\nsecond',
      lineCount: 2,
      truncated: true,
      nextStartLine: 3,
    });
    const last = ado.requests.at(-1)!;
    expect(last.url.searchParams.get('startLine')).toBe('0');
    expect(last.url.searchParams.get('endLine')).toBe('1');
    expect(last.url.hostname).toBe('127.0.0.1');
    ado.log = 'z'.repeat(20000);
    expect(
      await data('pipelines_build_log', {
        action: 'get_content',
        buildId: 11,
        logId: 5,
      }),
    ).toMatchObject({ content: 'z'.repeat(16000), characterTruncated: true });
  });
  it('continues within a long line without losing characters or repeating the same offset', async () => {
    ado.log = 'z'.repeat(20000) + '\nend';
    ado.logCount = 2;
    const first = (await data('pipelines_build_log', {
      action: 'get_content',
      buildId: 11,
      logId: 5,
    })) as Record<string, unknown>;
    expect(first).toMatchObject({
      nextStartLine: 1,
      nextStartColumn: 16000,
      lineCount: 0,
    });
    expect(
      await data('pipelines_build_log', {
        action: 'get_content',
        buildId: 11,
        logId: 5,
        startLine: first.nextStartLine,
        startColumn: first.nextStartColumn,
      }),
    ).toMatchObject({ content: 'z'.repeat(4000) + '\nend', truncated: false });
  });
  it('validates YAML run repository resources before exposing diagnostics', async () => {
    ado.definition.process = { type: 2 };
    expect(await data('pipelines_build', buildArgs)).toMatchObject({ id: 11 });
    ado.yamlRun.resources = {
      repositories: {
        self: {
          repository: { id: repository.id, type: 'azureReposGit' },
          refName: build.sourceBranch,
          version: commit,
        },
        other: {
          repository: { id: 'outside', type: 'azureReposGit' },
          refName: build.sourceBranch,
          version: commit,
        },
      },
    };
    await error(
      'pipelines_build_log',
      { action: 'list', buildId: 11 },
      'BUILD_SOURCE_UNSUPPORTED',
    );
    expect(ado.requests.some((r) => r.url.pathname.endsWith('/logs'))).toBe(
      false,
    );
  });
  it('rejects source mismatches in YAML self and definition revision snapshots', async () => {
    ado.definition.process = { type: 2 };
    ado.yamlRun.resources = {
      repositories: {
        self: {
          repository: { id: 'outside', type: 'azureReposGit' },
          refName: build.sourceBranch,
          version: commit,
        },
      },
    };
    await error('pipelines_build', buildArgs, 'BUILD_SOURCE_UNSUPPORTED');
    ado.definition.process = { type: 1 };
    ado.build.definition = { id: 7, revision: 2 };
    await error('pipelines_build', buildArgs, 'BUILD_NOT_ALLOWED');
    expect(ado.requests.at(-1)?.url.searchParams.get('revision')).toBe('2');
  });
  it.each([
    [302, 'text/plain', 'HTTP_302'],
    [200, 'text/html', 'INVALID_RESPONSE'],
    [403, 'text/plain', 'HTTP_403'],
  ])('rejects redirects/content/error %s', async (status, type, code) => {
    ado.logStatus = status as number;
    ado.logType = type as string;
    await error(
      'pipelines_build_log',
      { action: 'get_content', buildId: 11, logId: 5 },
      code as string,
    );
  });
  it('rejects oversized logs and unknown log IDs without following URLs', async () => {
    ado.log = 'z'.repeat(65537);
    await error(
      'pipelines_build_log',
      { action: 'get_content', buildId: 11, logId: 5 },
      'RESPONSE_TOO_LARGE',
    );
    await error(
      'pipelines_build_log',
      { action: 'get_content', buildId: 11, logId: 99 },
      'LOG_NOT_FOUND',
    );
    expect(ado.requests.every((r) => r.url.hostname === '127.0.0.1')).toBe(
      true,
    );
  });
  it('returns automated test counts/failure details with explicit build linkage and paging', async () => {
    expect(
      await data('testplan_show_test_results_from_build_id', {
        action: 'list_runs',
        buildId: 11,
        top: 1,
      }),
    ).toMatchObject({ items: [{ id: 21, totalTests: 2 }], nextSkip: 1 });
    expect(
      ado.requests
        .findLast((r) => r.url.pathname.endsWith('/test/runs'))
        ?.url.searchParams.get('buildUri'),
    ).toBe('vstfs:///Build/Build/11');
    ado.result.errorMessage = 'e'.repeat(5000);
    expect(
      await data('testplan_show_test_results_from_build_id', {
        action: 'list_results',
        buildId: 11,
        runId: 21,
        outcome: 'Failed',
        top: 1,
      }),
    ).toMatchObject({
      items: [{ errorMessage: 'e'.repeat(500), errorMessageTruncated: true }],
      nextSkip: 1,
    });
    expect(ado.requests.at(-1)?.url.searchParams.get('outcomes')).toBe(
      'Failed',
    );
  });
  it('resolves sparse Server test-run references before trusting build/project linkage', async () => {
    ado.runs = [{ id: 21 }];
    expect(
      await data('testplan_show_test_results_from_build_id', {
        action: 'list_runs',
        buildId: 11,
      }),
    ).toMatchObject({
      items: [{ id: 21, project: { id: project.id }, build: { id: '11' } }],
    });
    ado.run.build = { id: 99 };
    expect(
      await data('testplan_show_test_results_from_build_id', {
        action: 'list_runs',
        buildId: 11,
      }),
    ).toEqual({ items: [] });
  });
  it.each([
    { build: { id: 99 } },
    { isAutomated: false },
    { project: { id: 'other', name: 'Other' } },
    { id: 22 },
  ])('rejects out-of-build/manual runs %#', async (override) => {
    Object.assign(ado.run, override);
    await error(
      'testplan_show_test_results_from_build_id',
      { action: 'get_result', buildId: 11, runId: 21, resultId: 31 },
      'TEST_RUN_NOT_ALLOWED',
    );
    expect(
      ado.requests.some((r) => r.url.pathname.endsWith('/results/31')),
    ).toBe(false);
  });
  it.each([{ testRun: { id: 99 } }, { project: { id: 'other' } }])(
    'rejects result identity escape %#',
    async (override) => {
      Object.assign(ado.result, override);
      await error(
        'testplan_show_test_results_from_build_id',
        { action: 'list_results', buildId: 11, runId: 21 },
        'TEST_RESULT_NOT_ALLOWED',
      );
    },
  );
  it('defaults build writes to deny even with repository write authority', async () => {
    await error(
      'pipelines_write',
      {
        action: 'run_pipeline',
        definitionId: 7,
        branch: 'feature/search',
        commit,
      },
      'BUILD_WRITE_SCOPE_REQUIRED',
    );
    expect(ado.requests).toHaveLength(0);
  });
  async function enableWrites(overrides: NodeJS.ProcessEnv = {}) {
    await client.close();
    await server.close();
    await connect({
      ADO_BUILD_WRITE_REPOSITORIES: JSON.stringify([
        { project: project.name, repository: repository.name },
      ]),
      ADO_BUILD_WRITE_DEFINITIONS: '[7]',
      ...overrides,
    });
  }
  const queue = {
    action: 'run_pipeline',
    definitionId: 7,
    branch: 'feature/search',
    commit,
  };
  it('keeps work-item scopes from granting build writes and requires explicit repo read scope', async () => {
    await enableWrites({
      ADO_BUILD_WRITE_REPOSITORIES: '[]',
      ADO_ALLOWED_WORK_ITEM_PROJECTS: '["Website"]',
      ADO_WORK_ITEM_WRITE_PROJECTS: '["Website"]',
    });
    await error('pipelines_write', queue, 'BUILD_WRITE_SCOPE_REQUIRED');
    await enableWrites({ ADO_ALLOWED_REPOSITORIES: undefined });
    await error('pipelines_write', queue, 'BUILD_WRITE_SCOPE_REQUIRED');
    expect(ado.requests).toHaveLength(0);
  });
  it('fails earlier REST versions explicitly and retains configured stable versions', async () => {
    await data('pipelines_build', buildArgs);
    expect(
      ado.requests.every(
        (r) => r.url.searchParams.get('api-version') === '7.0',
      ),
    ).toBe(true);
    await client.close();
    await server.close();
    await connect({ ADO_API_VERSION: '6.0' });
    ado.requests.length = 0;
    await error(
      'pipelines_definition',
      { action: 'list' },
      'UNSUPPORTED_API_VERSION',
    );
    expect(ado.requests).toHaveLength(0);
  });
  it('handles empty inventories and result pages without fabricated resources', async () => {
    ado.definitions = [];
    ado.builds = [];
    ado.runs = [];
    ado.results = [];
    expect(await data('pipelines_definition', { action: 'list' })).toEqual({
      items: [],
    });
    expect(await data('pipelines_build', { action: 'list' })).toEqual({
      items: [],
    });
    expect(
      await data('testplan_show_test_results_from_build_id', {
        action: 'list_runs',
        buildId: 11,
      }),
    ).toEqual({ items: [] });
    expect(
      await data('testplan_show_test_results_from_build_id', {
        action: 'list_results',
        buildId: 11,
        runId: 21,
      }),
    ).toEqual({ items: [] });
  });
  it('reports a queue timeout with build-specific guidance and sends exactly one POST', async () => {
    await enableWrites({ ADO_TIMEOUT_MS: '100' });
    ado.queueDelayMs = 250;
    const r = await call('pipelines_write', queue);
    expect(r.structuredContent).toMatchObject({
      error: {
        code: 'TIMEOUT',
        message: expect.stringContaining('inspect builds'),
      },
    });
    expect(ado.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });
  it('queues once with pinned definition revision and explicit source then verifies response', async () => {
    await enableWrites();
    expect(await data('pipelines_write', queue)).toMatchObject({
      queueAccepted: true,
      completionVerified: false,
      build: { id: 11 },
    });
    const posts = ado.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      definition: { id: 7, revision: 3 },
      sourceBranch: build.sourceBranch,
      sourceVersion: commit,
    });
  });
  it.each([
    { queueStatus: 'disabled' },
    { process: { type: 2 } },
    { process: undefined },
  ])('denies unreviewable execution process %#', async (override) => {
    await enableWrites();
    Object.assign(ado.definition, override);
    await error('pipelines_write', queue, 'UNSUPPORTED_PIPELINE_QUEUE');
    expect(ado.requests.some((r) => r.method === 'POST')).toBe(false);
  });
  it('rejects stale commit and excludes hidden write repository', async () => {
    await enableWrites();
    await error(
      'pipelines_write',
      { ...queue, commit: 'b'.repeat(40) },
      'COMMIT_MISMATCH',
    );
    await enableWrites({
      ADO_BUILD_WRITE_REPOSITORIES:
        '[{"project":"Other","repository":"Other"}]',
    });
    await error('pipelines_write', queue, 'BUILD_WRITE_NOT_ALLOWED');
  });
  it.each([403, 500])(
    'does not retry rejected or uncertain queue %s',
    async (status) => {
      await enableWrites();
      ado.queueStatus = status;
      await error('pipelines_write', queue, `HTTP_${status}`);
      expect(ado.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    },
  );
  it.each([
    { sourceVersion: 'b'.repeat(40) },
    { definition: { id: 7, revision: 4 } },
  ])(
    'reports an unverifiable successful queue with recovery guidance %#',
    async (override) => {
      await enableWrites();
      Object.assign(ado.build, override);
      const r = await call('pipelines_write', queue);
      expect(r.structuredContent).toMatchObject({
        error: {
          code: 'QUEUE_VERIFICATION_FAILED',
          message: expect.stringContaining('before retrying'),
        },
      });
      expect(ado.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    },
  );
  it('rejects unsafe runtime arguments, missing IDs and irrelevant action fields', async () => {
    expect(
      (
        await call('pipelines_write', {
          ...queue,
          templateParameters: { script: 'bad' },
        })
      ).isError,
    ).toBe(true);
    await error(
      'pipelines_build',
      { action: 'get_status' },
      'INVALID_ARGUMENT',
    );
    await error(
      'pipelines_build_log',
      { action: 'list', buildId: 11, startLine: 1 },
      'INVALID_ARGUMENT',
    );
  });
  it('runs pipeline diagnostics and test failures through the actual CLI stdio transport', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/index.js')],
      env: ado.env() as Record<string, string>,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (c) => {
      stderr += String(c);
    });
    const cli = new Client({ name: 'phase3-stdio', version: '1' });
    try {
      await cli.connect(transport);
      const r = await cli.callTool({
        name: 'testplan_show_test_results_from_build_id',
        arguments: {
          repository: repository.name,
          action: 'get_result',
          buildId: 11,
          runId: 21,
          resultId: 31,
        },
      });
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).toMatchObject({ outcome: 'Failed' });
      expect(JSON.stringify(r)).not.toContain(token);
      expect(stderr).toBe('');
    } finally {
      await cli.close();
      await transport.close();
    }
  });
  it('runs the guarded reusable live runner against the fixture without a real credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'phase3-live-fixture-'));
    const reportPath = join(dir, 'report.json');
    const child = spawn(
      process.execPath,
      [resolve('scripts/live-pipelines.mjs')],
      {
        env: {
          ...ado.env(),
          ADO_PHASE3_REPOSITORY: repository.name,
          ADO_PHASE3_BUILD_ID: '11',
          ADO_PHASE3_EXPECT_TEST_RESULTS: '1',
          ADO_PHASE3_REPORT: reportPath,
        },
        windowsHide: true,
      },
    );
    let output = '';
    child.stdout.on('data', (c) => {
      output += String(c);
    });
    child.stderr.on('data', (c) => {
      output += String(c);
    });
    try {
      const code = await new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', resolveExit);
      });
      expect(code, output).toBe(0);
      expect(output).not.toContain(token);
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      expect(report).toMatchObject({
        state: 'passed',
        mode: 'build diagnostics',
        buildId: 11,
      });
      expect(report.checks).toHaveLength(8);
      expect(JSON.stringify(report)).not.toContain(testResult.errorMessage);
    } finally {
      await unlink(reportPath).catch(() => {});
      await rmdir(dir);
    }
  });
});
