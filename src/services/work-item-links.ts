import type { AdoClient } from '../ado/client.js';
import type { Project } from '../ado/types.js';
import type { WorkItem } from '../ado/phase2-types.js';
import type { WorkItemService } from './work-items.js';
import type { ReviewService, PrContext } from './review.js';
import { SafeError } from '../errors.js';
import { page } from './bounds.js';

const relationships = {
  parent: 'System.LinkTypes.Hierarchy-Reverse',
  child: 'System.LinkTypes.Hierarchy-Forward',
  related: 'System.LinkTypes.Related',
} as const;
type Relationship = keyof typeof relationships;
export class WorkItemLinkService {
  constructor(
    private readonly client: AdoClient,
    private readonly workItems: WorkItemService,
    private readonly review: ReviewService,
  ) {}
  async link(
    project: string | undefined,
    id: number,
    revision: number,
    targetId: number,
    relationship: Relationship,
  ) {
    if (id === targetId)
      throw new SafeError(
        'INVALID_ARGUMENT',
        'A work item cannot link to itself.',
      );
    const resolved = await this.workItems.scope.resolve(project, true);
    const source = await this.workItems.verified(resolved, id, undefined, true);
    await this.workItems.verified(resolved, targetId);
    this.workItems.requireRevision(source, revision);
    const url = this.client.url([
      '_apis',
      'wit',
      'workitems',
      String(targetId),
    ]);
    url.search = '';
    return this.add(
      resolved,
      source,
      revision,
      relationships[relationship],
      url.href,
    );
  }
  async linkPr(input: PrContext, id: number, revision: number) {
    const project = await this.workItems.scope.resolve(input.project, true);
    const { repository } = await this.review.context(input, true);
    if (repository.project.id.toLowerCase() !== project.id.toLowerCase())
      throw new SafeError(
        'WORK_ITEM_PROJECT_NOT_ALLOWED',
        'The work item and PR must belong to the same authorized project.',
      );
    const source = await this.workItems.verified(project, id, undefined, true);
    this.workItems.requireRevision(source, revision);
    return this.add(
      project,
      source,
      revision,
      'ArtifactLink',
      this.review.artifact(repository, input.pullRequestId),
      'Pull Request',
    );
  }
  private async add(
    project: Project,
    source: WorkItem,
    revision: number,
    rel: string,
    url: string,
    name?: string,
  ) {
    const targetId = this.parseWorkItemUrl(url, project);
    if (
      source.relations?.some(
        (link) =>
          link.rel === rel &&
          (targetId === undefined
            ? link.url.replace(/%2f/giu, '/').toLowerCase() ===
              url.replace(/%2f/giu, '/').toLowerCase()
            : this.parseWorkItemUrl(link.url, project) === targetId),
      )
    )
      return { id: source.id, revision: source.rev, alreadyLinked: true };
    const item = await this.workItems.patch(project, source.id, revision, [
      {
        op: 'add',
        path: '/relations/-',
        value: { rel, url, ...(name ? { attributes: { name } } : {}) },
      },
    ]);
    return { id: item.id, revision: item.rev, alreadyLinked: false };
  }
  async get(
    project: string | undefined,
    id: number,
    top: number,
    skip: number,
  ) {
    const resolved = await this.workItems.scope.resolve(project);
    const item = await this.workItems.verified(resolved, id, undefined, true);
    if ((item.relations?.length ?? 0) > 100)
      throw new SafeError(
        'RESPONSE_TOO_LARGE',
        'This work item has more than 100 relations. Inspect its links on the server.',
      );
    const links: Record<string, unknown>[] = [];
    let omitted = 0;
    for (const link of item.relations ?? []) {
      try {
        const relationship = Object.entries(relationships).find(
          ([, value]) => value === link.rel,
        )?.[0];
        if (relationship) {
          const targetId = this.parseWorkItemUrl(link.url, resolved);
          if (targetId === undefined) {
            omitted++;
            continue;
          }
          await this.workItems.verified(resolved, targetId, [
            'System.TeamProject',
          ]);
          links.push({ relationship, targetId });
        } else if (link.rel === 'ArtifactLink') {
          const artifact =
            /^vstfs:\/\/\/Git\/PullRequestId\/([a-f\d-]{36})(?:%2f|\/)([a-f\d-]{36})(?:%2f|\/)(\d+)$/iu.exec(
              link.url,
            );
          if (
            !artifact ||
            artifact[1]!.toLowerCase() !== resolved.id.toLowerCase()
          ) {
            omitted++;
            continue;
          }
          const pullRequestId = Number(artifact[3]);
          if (
            !Number.isSafeInteger(pullRequestId) ||
            pullRequestId < 1 ||
            pullRequestId > 2147483647
          ) {
            omitted++;
            continue;
          }
          const { repository } = await this.review.context({
            project: resolved.id,
            repository: artifact[2]!,
            pullRequestId,
          });
          links.push({
            relationship: 'pull_request',
            pullRequestId,
            repository: { id: repository.id, name: repository.name },
          });
        } else omitted++;
      } catch (error) {
        if (
          error instanceof SafeError &&
          [
            'WORK_ITEM_PROJECT_NOT_ALLOWED',
            'REPOSITORY_NOT_ALLOWED',
            'HTTP_404',
          ].includes(error.code)
        )
          omitted++;
        else throw error;
      }
    }
    return {
      ...page(links, top, skip),
      omittedLinks: omitted,
      note: 'Only authorized same-project work-item and PR links are exposed. Other artifact/hyperlink/attachment relations are omitted.',
    };
  }
  private parseWorkItemUrl(raw: string, project: Project): number | undefined {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    const base = new URL(this.client.collectionUrl);
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    if (
      !url.pathname.toLowerCase().startsWith(`${base.pathname.toLowerCase()}/`)
    )
      return undefined;
    const match = /^\/(?:([^/]+)\/)?_apis\/wit\/workitems\/(\d+)$/iu.exec(
      url.pathname.slice(base.pathname.length),
    );
    if (!match) return undefined;
    if (match[1]) {
      let selector: string;
      try {
        selector = decodeURIComponent(match[1]);
      } catch {
        return undefined;
      }
      if (
        ![project.id.toLowerCase(), project.name.toLowerCase()].includes(
          selector.toLowerCase(),
        )
      )
        return undefined;
    }
    const id = Number(match[2]);
    return Number.isSafeInteger(id) && id > 0 && id <= 2147483647
      ? id
      : undefined;
  }
  async prItems(input: PrContext) {
    const project = await this.workItems.scope.resolve(input.project);
    const { repository, ids } = await this.review.linkedIds(input);
    if (repository.project.id.toLowerCase() !== project.id.toLowerCase())
      throw new SafeError(
        'WORK_ITEM_PROJECT_NOT_ALLOWED',
        'The PR must belong to the selected work-item project.',
      );
    if (!ids.length) return { items: [] };
    return {
      items: (await this.workItems.batchVerified(project, ids)).map((item) =>
        this.workItems.summarize(item),
      ),
    };
  }
}
