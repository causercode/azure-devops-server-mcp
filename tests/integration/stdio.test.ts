import { spawn } from 'node:child_process';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MockAdoServer, token } from '../fixtures/ado-server.js';

describe('published CLI over stdio', () => {
  it('runs the repeatable live acceptance command against a local fixture', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ado-mcp-acceptance-'));
    const reportPath = join(directory, 'report.json');
    const child = spawn(
      process.execPath,
      [resolve('scripts/live-acceptance.mjs')],
      {
        env: {
          ...env(),
          ADO_TEST_REPOSITORY: 'intranet',
          ADO_TEST_SOURCE_BRANCH: 'feature/search',
          ADO_TEST_UNLISTED_REPOSITORY: 'outside-scope',
          ADO_LIVE_REPORT: reportPath,
        },
        windowsHide: true,
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
      const exitCode = await new Promise<number | null>(
        (resolveExit, reject) => {
          child.once('error', reject);
          child.once('close', resolveExit);
        },
      );
      expect(output).not.toContain(token);
      expect(exitCode, output).toBe(0);
      const report: { pullRequestId: number; checks: string[] } = JSON.parse(
        await readFile(reportPath, 'utf8'),
      );
      expect(report.pullRequestId).toBe(42);
      expect(report.checks).toHaveLength(9);
      expect(ado.pullRequests).toHaveLength(1);
    } finally {
      await unlink(reportPath).catch(() => {});
      await rmdir(directory);
    }
  });
  let ado: MockAdoServer;
  beforeEach(async () => {
    ado = await new MockAdoServer().start();
  });
  afterEach(async () => {
    await ado.close();
  });

  function env(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      ADO_SERVER_URL: `${ado.baseUrl}/tfs`,
      ADO_COLLECTION: 'DefaultCollection',
      ADO_PROJECT: 'Website',
      ADO_ALLOWED_REPOSITORIES: JSON.stringify([
        { project: 'Website', repository: 'intranet' },
      ]),
      ADO_TOKEN: token,
    };
  }

  it('initializes, lists tools, and creates a PR through a real child process', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/index.js')],
      env: env(),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(20);
      const result = await client.callTool({
        name: 'repo_pull_request_write',
        arguments: {
          action: 'create',
          repository: 'intranet',
          sourceBranch: 'feature/search',
          targetBranch: 'develop',
          title: 'PR through stdio',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        pullRequestId: 42,
        title: 'PR through stdio',
      });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(stderr).toBe('');
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it('accepts a legacy MCP 2025 client using raw JSON-RPC lines on stdin/stdout', async () => {
    const child = spawn(process.execPath, [resolve('dist/index.js')], {
      env: env(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const messages: Record<string, unknown>[] = [];
    let buffer = '';
    const response = new Promise<Record<string, unknown>>(
      (resolveResult, reject) => {
        child.once('error', reject);
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
          buffer += String(chunk);
          let index: number;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            const message: Record<string, unknown> = JSON.parse(line);
            messages.push(message);
            if (message.id === 1) {
              child.stdin.write(
                `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
              );
              child.stdin.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
              );
            }
            if (message.id === 2) resolveResult(message);
          }
        });
        child.once('exit', () =>
          reject(new Error('Child exited before response')),
        );
      },
    );
    try {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy-client', version: '1' } } })}\n`,
      );
      const result = await response;
      expect(result).toMatchObject({
        result: {
          tools: expect.arrayContaining([
            {
              name: 'server_info',
              description: expect.any(String),
              inputSchema: expect.any(Object),
              annotations: expect.any(Object),
            },
          ]),
        },
      });
      expect(messages[0]).toMatchObject({
        result: { protocolVersion: '2025-06-18' },
      });
      expect(output).not.toContain(token);
      expect(stderr).toBe('');
    } finally {
      child.kill();
      if (child.exitCode === null)
        await new Promise<void>((resolveExit) =>
          child.once('exit', () => resolveExit()),
        );
    }
  });

  it('fails missing configuration on stderr without polluting protocol stdout', async () => {
    const child = spawn(process.execPath, [resolve('dist/index.js')], {
      env: {
        PATH: process.env.PATH ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        ADO_TOKEN: token,
      },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', resolveExit);
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('ADO_SERVER_URL is required');
    expect(stderr).not.toContain(token);
  });
});
