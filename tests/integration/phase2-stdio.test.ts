import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Phase2Fixture, personId } from '../fixtures/phase2-server.js';
import { project, repository, token } from '../fixtures/ado-server.js';

describe('Phase 2 guarded acceptance over actual CLI stdio', () => {
  it('exercises the reusable live harness against a stateful HTTP fixture', async () => {
    const fixture = await new Phase2Fixture().start();
    fixture.ado.branches.set(
      'refs/heads/phase2-mcp-stdio-test',
      'd'.repeat(40),
    );
    const directory = await mkdtemp(join(tmpdir(), 'ado-phase2-'));
    const reportPath = join(directory, 'report.json');
    const child = spawn(
      process.execPath,
      [resolve('scripts/live-acceptance-phase2.mjs')],
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
            { project: project.name, repository: repository.name },
          ]),
          ADO_ALLOWED_WORK_ITEM_PROJECTS: JSON.stringify([project.name]),
          ADO_WORK_ITEM_WRITE_PROJECTS: JSON.stringify([project.id]),
          ADO_TEST_REPOSITORY: repository.name,
          ADO_TEST_SOURCE_BRANCH: 'phase2-mcp-stdio-test',
          ADO_TEST_REVIEWER_ID: personId,
          ADO_TEST_UNLISTED_REPOSITORY: 'outside-scope',
          ADO_TEST_UNLISTED_WORK_ITEM_ID: '3',
          ADO_PHASE2_REPORT: reportPath,
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
    try {
      const code = await new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', resolveExit);
      });
      expect(output).not.toContain(token);
      expect(code, output).toBe(0);
      const report = JSON.parse(await readFile(reportPath, 'utf8'));
      expect(report.passed).toBe(true);
      expect(report.checks).toHaveLength(11);
      expect(report.resources.workItemIds).toHaveLength(3);
      expect(fixture.ado.pullRequests).toHaveLength(1);
      expect(fixture.reviewers).toHaveLength(0);
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('rejects remote servers before spawning MCP or creating resources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ado-phase2-guard-'));
    const reportPath = join(directory, 'report.json');
    const child = spawn(
      process.execPath,
      [resolve('scripts/live-acceptance-phase2.mjs')],
      {
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          ADO_SERVER_URL: 'https://example.test/tfs',
          ADO_COLLECTION: 'Collection',
          ADO_TOKEN: token,
          ADO_PHASE2_REPORT: reportPath,
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
    try {
      const code = await new Promise<number | null>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('close', resolveExit);
      });
      expect(code).toBe(1);
      expect(output).toContain('restricted to a loopback lab');
      expect(output).not.toContain(token);
      expect(JSON.parse(await readFile(reportPath, 'utf8'))).toMatchObject({
        passed: false,
        resources: {},
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
