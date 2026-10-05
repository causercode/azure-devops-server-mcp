import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../../src/config.js';

export const project = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Website',
  state: 'wellFormed',
};
export const repository = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'intranet',
  project,
  defaultBranch: 'refs/heads/develop',
};
export const token = 'test-pat-never-visible-7f4155e9';
export const outsideRepository = {
  ...repository,
  id: '33333333-3333-3333-3333-333333333333',
  name: 'outside-scope',
};

export interface RecordedRequest {
  method: string;
  url: URL;
  authorization: string | undefined;
  body: Record<string, unknown> | undefined;
  contentType?: string | undefined;
}

export class MockAdoServer {
  readonly requests: RecordedRequest[] = [];
  readonly branches = new Map([
    ['refs/heads/feature/search', 'a'.repeat(40)],
    ['refs/heads/develop', 'b'.repeat(40)],
    ['refs/heads/feature/search-more', 'c'.repeat(40)],
  ]);
  readonly pullRequests: Record<string, unknown>[] = [];
  projectsStatus = 200;
  projectDelayMs = 0;
  writeStatus = 201;
  acceptedAuthorization = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  readonly #server: Server;
  baseUrl = '';
  phase2Handler?: (
    entry: RecordedRequest,
    send: (status: number, data?: unknown) => void,
  ) => boolean;

  constructor() {
    this.#server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8');
      const entry: RecordedRequest = {
        method: request.method ?? 'GET',
        url: new URL(request.url ?? '/', this.baseUrl),
        authorization: request.headers.authorization,
        body: text ? JSON.parse(text) : undefined,
        contentType: request.headers['content-type'],
      };
      this.requests.push(entry);
      response.setHeader('content-type', 'application/json');
      const send = (status: number, data: unknown) => {
        response.statusCode = status;
        response.end(JSON.stringify(data));
      };
      if (entry.authorization !== this.acceptedAuthorization) {
        send(401, { message: 'Invalid auth' });
        return;
      }
      if (
        !['7.0', '7.0-preview.3', '7.0-preview.1'].includes(
          entry.url.searchParams.get('api-version') ?? '',
        )
      ) {
        send(400, { message: 'Unsupported version' });
        return;
      }
      const base = '/tfs/DefaultCollection';
      const path = decodeURIComponent(entry.url.pathname);
      if (this.phase2Handler?.(entry, send)) return;
      if (path === `${base}/_apis/projects`) {
        if (this.projectDelayMs)
          await new Promise((resolve) =>
            setTimeout(resolve, this.projectDelayMs),
          );
        response.setHeader('x-tfs-product-version', '19.205.33122.1');
        if (this.projectsStatus !== 200)
          send(this.projectsStatus, {
            message: `Sensitive upstream error ${token}`,
          });
        else if (entry.url.searchParams.has('continuationToken'))
          send(200, { value: [{ id: 'project-2', name: 'Other' }] });
        else {
          response.setHeader('x-ms-continuationtoken', '1');
          send(200, { count: 1, value: [project] });
        }
        return;
      }
      if (path === `${base}/Website/_apis/git/repositories`) {
        send(200, { value: [repository, outsideRepository] });
        return;
      }
      if (
        [
          `${base}/Website/_apis/git/repositories/outside-scope`,
          `${base}/${project.id}/_apis/git/repositories/${outsideRepository.id}`,
        ].includes(path)
      ) {
        send(200, outsideRepository);
        return;
      }
      if (
        [
          `${base}/Website/_apis/git/repositories/intranet`,
          `${base}/${project.id}/_apis/git/repositories/${repository.id}`,
        ].includes(path)
      ) {
        send(200, repository);
        return;
      }
      const repoPath = `${base}/${project.id}/_apis/git/repositories/${repository.id}`;
      if (path === `${repoPath}/refs`) {
        const filter = `refs/${entry.url.searchParams.get('filter') ?? ''}`;
        const refs = [...this.branches]
          .filter(([name]) => name.startsWith(filter))
          .map(([name, objectId]) => ({ name, objectId }));
        const offset = Number(
          entry.url.searchParams.get('continuationToken') ?? 0,
        );
        const top = Number(entry.url.searchParams.get('$top') ?? 100);
        if (offset + top < refs.length)
          response.setHeader('x-ms-continuationtoken', String(offset + top));
        send(200, { value: refs.slice(offset, offset + top) });
        return;
      }
      if (path === `${repoPath}/pullrequests`) {
        if (entry.method === 'POST') {
          if (this.writeStatus >= 400) {
            send(this.writeStatus, { message: `Sensitive error ${token}` });
            return;
          }
          const pr = {
            repository,
            pullRequestId: 42 + this.pullRequests.length,
            status: 'active',
            createdBy: {
              displayName: 'Test User',
              uniqueName: 'omitted@example.test',
            },
            creationDate: '2026-10-04T12:00:00Z',
            ...entry.body,
          };
          this.pullRequests.push(pr);
          send(this.writeStatus, pr);
        } else {
          let prs = this.pullRequests;
          const status = entry.url.searchParams.get('searchCriteria.status');
          if (status && status !== 'all')
            prs = prs.filter((pr) => pr.status === status);
          for (const field of ['sourceRefName', 'targetRefName']) {
            const filter = entry.url.searchParams.get(
              `searchCriteria.${field}`,
            );
            if (filter) prs = prs.filter((pr) => pr[field] === filter);
          }
          const skip = Number(entry.url.searchParams.get('$skip') ?? 0);
          const top = Number(entry.url.searchParams.get('$top') ?? 25);
          send(200, { value: prs.slice(skip, skip + top) });
        }
        return;
      }
      const id = path.startsWith(`${repoPath}/pullrequests/`)
        ? Number(path.split('/').at(-1))
        : NaN;
      const pr = this.pullRequests.find((item) => item.pullRequestId === id);
      if (pr) {
        if (entry.method === 'PATCH') Object.assign(pr, entry.body);
        send(200, pr);
        return;
      }
      send(404, { message: 'Not found' });
    });
  }

  async start() {
    await new Promise<void>((resolve) =>
      this.#server.listen(0, '127.0.0.1', resolve),
    );
    this.baseUrl = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  config(extra: NodeJS.ProcessEnv = {}) {
    return loadConfig({
      ADO_SERVER_URL: `${this.baseUrl}/tfs`,
      ADO_COLLECTION: 'DefaultCollection',
      ADO_TOKEN: token,
      ...extra,
    });
  }

  async close() {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
