import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Phase2Fixture, personId } from '../fixtures/phase2-server.js';
import { project, repository, token } from '../fixtures/ado-server.js';
import { build, definition } from '../fixtures/build-server.js';

describe('two-stage workflow acceptance over compiled MCP stdio', () => {
  let fixture: Phase2Fixture;
  let directory: string;
  let reportPath: string;
  beforeEach(async () => {
    fixture = await new Phase2Fixture().start();
    fixture.ado.branches.set('refs/heads/phase4-mcp-stdio', 'd'.repeat(40));
    directory = await mkdtemp(join(tmpdir(), 'ado-workflow-'));
    reportPath = join(directory, 'report.json');
  });
  afterEach(async () => {
    await fixture.close();
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(directory.split(/[\\/]/u).at(-1)).toMatch(/^ado-workflow-/u);
    await rm(directory, { recursive: true, force: true });
  });
  async function run(extra: Record<string, string> = {}) {
    const child = spawn(
      process.execPath,
      [resolve('scripts/live-workflows.mjs')],
      {
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          ADO_SERVER_URL: `${fixture.ado.baseUrl}/tfs`,
          ADO_COLLECTION: 'DefaultCollection',
          ADO_TOKEN: token,
          ADO_PROJECT: project.name,
          ADO_ALLOWED_REPOSITORIES: JSON.stringify([
            { project: project.id, repository: repository.id },
          ]),
          ADO_ALLOWED_WORK_ITEM_PROJECTS: JSON.stringify([project.id]),
          ADO_WORK_ITEM_WRITE_PROJECTS: JSON.stringify([project.id]),
          ADO_WORKFLOW_REPOSITORY: repository.name,
          ADO_WORKFLOW_WORK_ITEM_ID: '1',
          ADO_WORKFLOW_SOURCE_BRANCH: 'phase4-mcp-stdio',
          ADO_WORKFLOW_TESTED_COMMIT: 'd'.repeat(40),
          ADO_WORKFLOW_REVIEWER_ID: personId,
          ADO_WORKFLOW_REPORT: reportPath,
          ...extra,
        },
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    const code = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
    expect(output).not.toContain(token);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    expect(JSON.stringify(report)).not.toContain(token);
    return { code, output, report };
  }
  it('prepares a ticket, then verifies and resumes a linked draft PR without duplicate writes', async () => {
    const prepared = await run({ ADO_WORKFLOW_MODE: 'prepare' });
    expect(prepared.code, prepared.output).toBe(0);
    expect(prepared.report.state).toContain('prepared');
    const id = String(prepared.report.resources.workItemId);
    const verified = await run({ ADO_WORKFLOW_WORK_ITEM_ID: id });
    expect(verified.code, verified.output).toBe(0);
    expect(verified.report.state).toContain('passed');
    expect(verified.report.resources).toMatchObject({
      sourceCommit: 'd'.repeat(40),
      reviewerAssigned: true,
      ciVerified: false,
    });
    expect(verified.report.checks).toHaveLength(9);
    expect(fixture.ado.pullRequests).toHaveLength(1);
    const repeated = await run({ ADO_WORKFLOW_WORK_ITEM_ID: id });
    expect(repeated.code, repeated.output).toBe(0);
    expect(fixture.ado.pullRequests).toHaveLength(1);
    expect(fixture.threads).toHaveLength(1);
    expect(fixture.reviewers).toHaveLength(1);
  });
  it('rejects a different tested commit before creating a PR or discussion', async () => {
    const result = await run({ ADO_WORKFLOW_TESTED_COMMIT: 'a'.repeat(40) });
    expect(result.code).toBe(1);
    expect(fixture.ado.pullRequests).toHaveLength(0);
    expect(fixture.threads).toHaveLength(0);
  });
  it('diagnoses a matching build with a separate read configuration and preserves its failed outcome', async () => {
    const handler = fixture.ado.phase2Handler!;
    fixture.ado.phase2Handler = (entry, send) => {
      const path = entry.url.pathname;
      if (path.endsWith('/_apis/build/builds/11')) {
        send(200, {
          ...build,
          sourceBranch: 'refs/heads/phase4-mcp-stdio',
          sourceVersion: 'd'.repeat(40),
        });
        return true;
      }
      if (path.endsWith('/_apis/build/definitions/7')) {
        send(200, definition);
        return true;
      }
      if (path.endsWith('/timeline')) {
        send(200, { records: [] });
        return true;
      }
      if (path.endsWith('/test/runs')) {
        send(200, { value: [] });
        return true;
      }
      return handler(entry, send);
    };
    const envFile = join(directory, 'build.env');
    await writeFile(
      envFile,
      `ADO_SERVER_URL=${fixture.ado.baseUrl}/tfs\nADO_COLLECTION=DefaultCollection\nADO_TOKEN=${token}\nADO_ALLOWED_REPOSITORIES='${JSON.stringify([{ project: project.id, repository: repository.id }])}'\n`,
    );
    const result = await run({
      ADO_WORKFLOW_BUILD_ID: '11',
      ADO_WORKFLOW_BUILD_ENV_FILE: envFile,
    });
    expect(result.code, result.output).toBe(0);
    expect(result.report.resources).toMatchObject({
      buildResult: 'failed',
      buildSourceVerified: true,
      buildCompletionVerified: true,
      automatedTestRunCount: 0,
    });
    expect(
      fixture.ado.requests
        .filter((request) => request.url.pathname.includes('/build/'))
        .every((request) => request.method === 'GET'),
    ).toBe(true);
  });
  it('preserves prepare evidence and refuses to create another ticket at the same report path', async () => {
    const prepared = await run({ ADO_WORKFLOW_MODE: 'prepare' });
    const items = fixture.items.size;
    const refused = await run({ ADO_WORKFLOW_MODE: 'prepare' });
    expect(refused.code).toBe(1);
    expect(refused.report).toEqual(prepared.report);
    expect(fixture.items.size).toBe(items);
  });
  it('rejects an unauthorized work item before PR writes', async () => {
    const result = await run({ ADO_WORKFLOW_WORK_ITEM_ID: '3' });
    expect(result.code).toBe(1);
    expect(result.report.errorCode).toBe('WORK_ITEM_PROJECT_NOT_ALLOWED');
    expect(fixture.ado.pullRequests).toHaveLength(0);
  });
  it('does not treat a stale build as validation of the PR', async () => {
    const handler = fixture.ado.phase2Handler!;
    fixture.ado.phase2Handler = (entry, send) => {
      if (entry.url.pathname.endsWith('/_apis/build/builds/11')) {
        send(200, build);
        return true;
      }
      if (entry.url.pathname.endsWith('/_apis/build/definitions/7')) {
        send(200, definition);
        return true;
      }
      return handler(entry, send);
    };
    const result = await run({ ADO_WORKFLOW_BUILD_ID: '11' });
    expect(result.code).toBe(1);
    expect(result.report.checks).not.toContain(
      'matching build source and bounded automated diagnostics',
    );
    expect(
      fixture.ado.requests.every(
        (request) =>
          !(
            request.method === 'POST' &&
            request.url.pathname.includes('/build/')
          ),
      ),
    ).toBe(true);
  });
  it('rejects non-loopback servers before any lab traffic', async () => {
    const result = await run({ ADO_SERVER_URL: 'https://example.test/tfs' });
    expect(result.code).toBe(1);
    expect(fixture.ado.requests).toHaveLength(0);
    expect(fixture.ado.pullRequests).toHaveLength(0);
  });
});
