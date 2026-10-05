import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../../src/config.js';
import { project, repository, token } from './ado-server.js';
export const commit = 'a'.repeat(40);
export const definition = {
  id: 7,
  name: 'Harmless CI',
  revision: 3,
  type: 'build',
  queueStatus: 'enabled',
  project,
  repository: { id: repository.id, type: 'TfsGit' },
  process: { type: 1 },
};
export const build = {
  id: 11,
  project,
  repository: { id: repository.id, type: 'TfsGit' },
  definition: { id: 7, name: 'Harmless CI', revision: 3 },
  status: 'completed',
  result: 'failed',
  sourceBranch: 'refs/heads/feature/search',
  sourceVersion: commit,
};
export const testRun = {
  id: 21,
  name: 'Automated CI',
  project,
  isAutomated: true,
  build: { id: '11' },
  state: 'Completed',
  totalTests: 2,
  passedTests: 1,
};
export const testResult = {
  id: 31,
  project,
  testRun: { id: '21' },
  outcome: 'Failed',
  automatedTestName: 'example fails',
  errorMessage: 'Expected true',
  stackTrace: 'at example:1',
};
export class BuildServer {
  baseUrl = '';
  definition: Record<string, unknown> = { ...definition };
  build: Record<string, unknown> = { ...build };
  run: Record<string, unknown> = { ...testRun };
  result: Record<string, unknown> = { ...testResult };
  definitions: Record<string, unknown>[] | undefined;
  builds: Record<string, unknown>[] | undefined;
  runs: Record<string, unknown>[] | undefined;
  results: Record<string, unknown>[] | undefined;
  timelineRecords: Record<string, unknown>[] | undefined;
  log = 'first\r\nsecond\r\nthird\r\n';
  logType = 'text/plain; charset=utf-8';
  logStatus = 200;
  logCount: number | undefined = 3;
  queueStatus = 200;
  queueDelayMs = 0;
  continuation: string | undefined;
  yamlRun: Record<string, unknown> = {
    id: 11,
    pipeline: { id: 7 },
    resources: {
      repositories: {
        self: {
          repository: { id: repository.id, type: 'azureReposGit' },
          refName: build.sourceBranch,
          version: commit,
        },
      },
    },
  };
  readonly requests: { method: string; url: URL; body: unknown }[] = [];
  private server: Server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', this.baseUrl);
    this.requests.push({
      method: req.method ?? 'GET',
      url,
      body: text ? JSON.parse(text) : undefined,
    });
    const path = decodeURIComponent(url.pathname);
    res.setHeader('content-type', 'application/json');
    const send = (status: number, data: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(data));
    };
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from(`:${token}`).toString('base64')}`
    ) {
      send(401, {});
      return;
    }
    if (path.includes('/git/repositories/')) {
      if (path.endsWith('/refs'))
        send(200, { value: [{ name: build.sourceBranch, objectId: commit }] });
      else send(200, repository);
      return;
    }
    if (path.endsWith('/build/definitions')) {
      if (this.continuation)
        res.setHeader('x-ms-continuationtoken', this.continuation);
      send(200, {
        value: this.definitions ?? [this.definition],
      });
      return;
    }
    if (path.endsWith('/build/definitions/7')) {
      send(200, this.definition);
      return;
    }
    if (path.endsWith('/build/definitions/8')) {
      send(200, { ...this.definition, id: 8 });
      return;
    }
    if (path.endsWith('/pipelines/7/runs/11')) {
      send(200, this.yamlRun);
      return;
    }
    if (path.endsWith('/build/builds')) {
      if (req.method === 'POST') {
        if (this.queueDelayMs)
          await new Promise((resolve) =>
            setTimeout(resolve, this.queueDelayMs),
          );
        send(this.queueStatus, this.build);
      } else {
        if (this.continuation)
          res.setHeader('x-ms-continuationtoken', this.continuation);
        send(200, { value: this.builds ?? [this.build] });
      }
      return;
    }
    if (path.endsWith('/build/builds/11')) {
      send(200, this.build);
      return;
    }
    if (path.endsWith('/timeline')) {
      send(200, {
        records: this.timelineRecords ?? [
          {
            id: 'task-1',
            name: 'Test',
            state: 'completed',
            result: 'failed',
            log: { id: 5 },
            issues: [{ type: 'error', message: 'x'.repeat(2500) }],
          },
          { id: 'task-2', name: 'Publish', state: 'pending' },
        ],
      });
      return;
    }
    if (path.endsWith('/logs')) {
      send(200, {
        value: [
          {
            id: 5,
            ...(this.logCount === undefined
              ? {}
              : { lineCount: this.logCount }),
            url: 'https://outside.invalid/stolen',
          },
        ],
      });
      return;
    }
    if (path.endsWith('/logs/5')) {
      res.statusCode = this.logStatus;
      res.setHeader('content-type', this.logType);
      res.setHeader('location', 'https://outside.invalid/stolen');
      res.end(this.log);
      return;
    }
    if (path.endsWith('/test/runs')) {
      send(200, { value: this.runs ?? [this.run] });
      return;
    }
    if (path.endsWith('/test/runs/21')) {
      send(200, this.run);
      return;
    }
    if (path.endsWith('/results')) {
      send(200, { value: this.results ?? [this.result] });
      return;
    }
    if (path.endsWith('/results/31')) {
      send(200, this.result);
      return;
    }
    send(404, {});
  });
  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
  }
  env(overrides: NodeJS.ProcessEnv = {}) {
    return {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      ADO_SERVER_URL: this.baseUrl,
      ADO_COLLECTION: 'Collection',
      ADO_PROJECT: project.name,
      ADO_TOKEN: token,
      ADO_ALLOWED_REPOSITORIES: JSON.stringify([
        { project: project.name, repository: repository.name },
      ]),
      ...overrides,
    };
  }
  config(overrides: NodeJS.ProcessEnv = {}) {
    return loadConfig(this.env(overrides));
  }
}
