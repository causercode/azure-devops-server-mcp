import {
  MockAdoServer,
  project,
  repository,
  type RecordedRequest,
} from './ado-server.js';

export const otherProject = {
  id: '44444444-4444-4444-4444-444444444444',
  name: 'Other',
};
export const personId = '55555555-5555-5555-5555-555555555555';
export const queryId = '66666666-6666-6666-6666-666666666666';
export const folderId = '77777777-7777-7777-7777-777777777777';
const person = {
  id: personId,
  providerDisplayName: 'Same Name',
  isActive: true,
  isContainer: false,
  properties: { Account: { $value: 'person' }, Domain: { $value: 'example' } },
};

export class Phase2Fixture {
  readonly ado = new MockAdoServer();
  readonly items = new Map<number, Record<string, unknown>>([
    [
      1,
      {
        id: 1,
        rev: 1,
        fields: {
          'System.TeamProject': project.name,
          'System.WorkItemType': 'Task',
          'System.Title': 'First',
          'System.State': 'New',
          'System.Description': 'Long '.repeat(1000),
        },
        relations: [],
      },
    ],
    [
      2,
      {
        id: 2,
        rev: 1,
        fields: {
          'System.TeamProject': project.name,
          'System.Title': 'Second',
        },
        relations: [],
      },
    ],
    [
      3,
      {
        id: 3,
        rev: 1,
        fields: {
          'System.TeamProject': otherProject.name,
          'System.Title': 'Private other-project item',
        },
        relations: [],
      },
    ],
  ]);
  readonly comments = new Map<number, Record<string, unknown>[]>();
  readonly threads: Record<string, unknown>[] = [];
  readonly reviewers: Record<string, unknown>[] = [];
  identityResults = structuredClone([
    person,
    {
      ...person,
      id: '88888888-8888-8888-8888-888888888888',
      properties: {
        Account: { $value: 'different' },
        Domain: { $value: 'example' },
      },
    },
  ]);
  identitiesStatus = 200;
  queryIds = [1, 2];
  queryWiql =
    "SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.State] = 'New'";
  queryType = 'flat';
  mutateBeforePatch = false;
  patchStatus = 200;
  fileContent = 'one\ntwo\nthree\nfour';
  fileBinary = false;
  mismatchedThread = false;
  mismatchedProject = false;
  batchMode: 'normal' | 'duplicate' | 'incomplete' | 'unexpected' = 'normal';
  commentWrongId = false;
  constructor() {
    this.ado.phase2Handler = (entry, send) => this.route(entry, send);
  }
  async start() {
    await this.ado.start();
    return this;
  }
  async close() {
    await this.ado.close();
  }
  config(extra: NodeJS.ProcessEnv = {}) {
    return this.ado.config({
      ADO_PROJECT: project.name,
      ADO_ALLOWED_REPOSITORIES: JSON.stringify([
        { project: project.name, repository: repository.name },
      ]),
      ADO_ALLOWED_WORK_ITEM_PROJECTS: JSON.stringify([project.name]),
      ADO_WORK_ITEM_WRITE_PROJECTS: JSON.stringify([project.id]),
      ...extra,
    });
  }
  private route(
    entry: RecordedRequest,
    send: (status: number, data?: unknown) => void,
  ) {
    const path = decodeURIComponent(entry.url.pathname).replace(
      '/tfs/DefaultCollection',
      '',
    );
    const body = entry.body ?? {};
    const method = entry.method;
    const top = Number(entry.url.searchParams.get('$top') ?? 25);
    if (path.startsWith('/_apis/projects/')) {
      const selector = path.split('/').at(-1);
      const result = [project, otherProject].find(
        (item) =>
          item.id === selector ||
          item.name.toLowerCase() === selector?.toLowerCase(),
      );
      send(result ? 200 : 404, this.mismatchedProject ? otherProject : result);
      return true;
    }
    if (path === '/_apis/identities') {
      const selected = entry.url.searchParams.get('identityIds');
      send(this.identitiesStatus, {
        value: selected
          ? this.identityResults.filter((item) => item.id === selected)
          : this.identityResults,
      });
      return true;
    }
    if (path === `/${project.id}/_apis/wit/workitemtypes`) {
      send(200, {
        value: [
          { name: 'Task', referenceName: 'Task', description: 'A task' },
          { name: 'Bug', referenceName: 'Bug' },
        ],
      });
      return true;
    }
    if (path === `/${project.id}/_apis/wit/workitemtypes/Task`) {
      send(200, { name: 'Task', referenceName: 'Task', description: 'A task' });
      return true;
    }
    if (
      path === `/${project.id}/_apis/wit/fields` ||
      path === `/${project.id}/_apis/wit/workitemtypes/Task/fields`
    ) {
      send(200, {
        value: [
          {
            name: 'Title',
            referenceName: 'System.Title',
            type: 'string',
            readOnly: false,
          },
          { name: 'State', referenceName: 'System.State', type: 'string' },
        ],
      });
      return true;
    }
    if (path.startsWith(`/${project.id}/_apis/wit/queries`)) {
      if (path.endsWith('/queries'))
        send(200, {
          value: [{ id: folderId, name: 'Shared Queries', isFolder: true }],
        });
      else if (path.endsWith(folderId))
        send(200, {
          id: folderId,
          name: 'Shared Queries',
          isFolder: true,
          children: [
            { id: queryId, name: 'Tasks', isFolder: false, queryType: 'flat' },
          ],
        });
      else
        send(200, {
          id: queryId,
          name: 'Tasks',
          isFolder: false,
          queryType: this.queryType,
          wiql: this.queryWiql,
        });
      return true;
    }
    if (path === `/${project.id}/_apis/wit/wiql`) {
      const exactIds = [
        ...String(body.query).matchAll(/\[System\.Id\] = (\d+)/gu),
      ].map((match) => Number(match[1]));
      const ids = exactIds.length
        ? exactIds.filter(
            (id) =>
              (
                this.items.get(id)?.fields as
                  Record<string, unknown> | undefined
              )?.['System.TeamProject'] === project.name,
          )
        : this.queryIds;
      send(200, {
        queryType: this.queryType,
        asOf: '2026-10-04T12:00:00Z',
        workItems: ids.slice(0, top).map((id) => ({ id })),
      });
      return true;
    }
    if (path === `/${project.id}/_apis/wit/workitemsbatch`) {
      let result = (body.ids as number[]).map((id) => this.items.get(id));
      if (this.batchMode === 'duplicate') result = [result[0], result[0]];
      if (this.batchMode === 'incomplete') result = result.slice(1);
      if (this.batchMode === 'unexpected') result = [this.items.get(3)];
      send(200, { value: result });
      return true;
    }
    if (
      path === `/${project.id}/_apis/wit/workitems/$Task` &&
      method === 'POST'
    ) {
      const fields: Record<string, unknown> = {
        'System.TeamProject': project.name,
        'System.WorkItemType': 'Task',
      };
      for (const operation of body as unknown as {
        path: string;
        value: unknown;
      }[])
        fields[operation.path.slice('/fields/'.length)] = operation.value;
      const id = this.items.size + 1;
      const item = { id, rev: 1, fields, relations: [] };
      this.items.set(id, item);
      send(200, item);
      return true;
    }
    const workItemPath = new RegExp(
      `^/${project.id}/_apis/wit/workitems/(\\d+)(/comments)?$`,
      'u',
    ).exec(path);
    if (workItemPath) {
      const id = Number(workItemPath[1]);
      const item = this.items.get(id);
      if (!item) {
        send(404, {});
        return true;
      }
      if (workItemPath[2]) {
        const comments = this.comments.get(id) ?? [];
        if (method === 'POST') {
          const comment = {
            id: comments.length + 1,
            workItemId: this.commentWrongId ? 3 : id,
            version: 1,
            text: body.text,
            createdBy: { id: personId, displayName: 'Test Person' },
          };
          comments.push(comment);
          this.comments.set(id, comments);
          send(200, comment);
        } else {
          const offset = Number(
            entry.url.searchParams.get('continuationToken') ?? 0,
          );
          send(200, {
            comments: comments.slice(offset, offset + top),
            ...(offset + top < comments.length
              ? { continuationToken: String(offset + top) }
              : {}),
          });
        }
        return true;
      }
      if (method === 'PATCH') {
        if (this.patchStatus !== 200) {
          send(this.patchStatus, { message: 'private error' });
          return true;
        }
        if (this.mutateBeforePatch) item.rev = Number(item.rev) + 1;
        const operations = body as unknown as {
          op: string;
          path: string;
          value: unknown;
        }[];
        if (operations[0]?.value !== item.rev) {
          send(412, {});
          return true;
        }
        for (const operation of operations.slice(1)) {
          if (operation.path === '/relations/-') {
            const relation = operation.value as { rel: string; url: string };
            // Server canonicalizes local work-item relations to a project-qualified URL.
            (item.relations as unknown[]).push({
              ...relation,
              url: relation.url.includes('/_apis/wit/workitems/')
                ? relation.url.replace(
                    '/_apis/wit/workitems/',
                    `/${project.id}/_apis/wit/workItems/`,
                  )
                : relation.url,
            });
            if (relation.rel === 'ArtifactLink')
              this.linkedWorkItemIds.push(id);
            const linkedId = Number(relation.url.split('/').at(-1));
            if (
              relation.rel === 'System.LinkTypes.Hierarchy-Forward' &&
              this.items.has(linkedId)
            )
              (this.items.get(linkedId)!.relations as unknown[]).push({
                rel: 'System.LinkTypes.Hierarchy-Reverse',
                url: `${this.ado.baseUrl}/tfs/DefaultCollection/${project.id}/_apis/wit/workItems/${id}`,
              });
          } else
            (item.fields as Record<string, unknown>)[
              operation.path.slice('/fields/'.length)
            ] = operation.value;
        }
        item.rev = Number(item.rev) + 1;
      }
      send(200, item);
      return true;
    }
    const repoPath = `/${project.id}/_apis/git/repositories/${repository.id}`;
    const prPath = `${repoPath}/pullrequests/42`;
    if (path === `${repoPath}/items`) {
      send(200, {
        path: entry.url.searchParams.get('path'),
        gitObjectType: 'blob',
        content: this.fileContent,
        contentMetadata: { isBinary: this.fileBinary },
      });
      return true;
    }
    if (!this.ado.pullRequests.some((pr) => pr.pullRequestId === 42))
      return false;
    if (path === `${prPath}/iterations`) {
      send(200, {
        value: [
          {
            id: 1,
            sourceRefCommit: { commitId: 'a'.repeat(40) },
            targetRefCommit: { commitId: 'b'.repeat(40) },
            commonRefCommit: { commitId: 'c'.repeat(40) },
          },
          {
            id: 2,
            sourceRefCommit: { commitId: 'd'.repeat(40) },
            targetRefCommit: { commitId: 'b'.repeat(40) },
            commonRefCommit: { commitId: 'c'.repeat(40) },
          },
        ],
      });
      return true;
    }
    if (/\/iterations\/\d+\/changes$/u.test(path)) {
      const skip = Number(entry.url.searchParams.get('$skip') ?? 0);
      const items = ['/a.ts', '/b.ts', '/deleted.ts'].map((path, i) => ({
        changeId: i + 1,
        changeType: i === 2 ? 'delete' : 'edit',
        item: {
          path,
          objectId: 'd'.repeat(40),
          originalObjectId: 'c'.repeat(40),
        },
      }));
      send(200, {
        changeEntries: items.slice(skip, skip + top),
        nextSkip: skip + top < items.length ? skip + top : 0,
        nextTop: skip + top < items.length ? top : 0,
      });
      return true;
    }
    if (path === `${prPath}/workitems`) {
      send(200, {
        value: this.linkedWorkItemIds.map((id) => ({ id: String(id) })),
      });
      return true;
    }
    if (path === `${prPath}/reviewers`) {
      send(200, { value: this.reviewers });
      return true;
    }
    if (path.startsWith(`${prPath}/reviewers/`)) {
      const id = path.split('/').at(-1)!;
      if (method === 'PUT') {
        const reviewer = { id, displayName: 'Test Person', vote: 0 };
        this.reviewers.push(reviewer);
        send(200, reviewer);
      } else if (method === 'DELETE') {
        this.reviewers.splice(
          this.reviewers.findIndex((item) => item.id === id),
          1,
        );
        send(204);
      }
      return true;
    }
    if (path === `${prPath}/threads`) {
      if (method === 'POST') {
        const thread = {
          id: this.threads.length + 1,
          status: body.status,
          comments: (body.comments as unknown[]).map((comment, index) => ({
            id: index + 1,
            ...(comment as Record<string, unknown>),
          })),
        };
        this.threads.push(thread);
        send(200, thread);
      } else send(200, { value: this.threads });
      return true;
    }
    const threadPath = new RegExp(
      `^${prPath}/threads/(\\d+)(/comments)?$`,
      'u',
    ).exec(path);
    if (threadPath) {
      const id = Number(threadPath[1]);
      const thread = this.threads.find((item) => item.id === id);
      if (!thread) {
        send(404, {});
        return true;
      }
      const comments = thread.comments as Record<string, unknown>[];
      if (threadPath[2]) {
        if (method === 'POST') {
          const comment = { id: comments.length + 1, ...body };
          comments.push(comment);
          send(200, comment);
        } else send(200, { value: comments });
      } else {
        if (method === 'PATCH') thread.status = body.status;
        send(200, this.mismatchedThread ? { ...thread, id: 99 } : thread);
      }
      return true;
    }
    return false;
  }
  linkedWorkItemIds: number[] = [];
}
