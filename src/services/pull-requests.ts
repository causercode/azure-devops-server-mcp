import type { AdoClient } from '../ado/client.js';
import {
  listSchema,
  pullRequestSchema,
  type Page,
  type PullRequest,
  type Repository,
} from '../ado/types.js';
import { SafeError } from '../errors.js';
import { normalizeBranch, type BranchService } from './branches.js';
import { repositoryPath, type RepositoryService } from './repositories.js';

export interface CreatePullRequest {
  project?: string | undefined;
  repository: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string | undefined;
  isDraft?: boolean | undefined;
}

export interface UpdatePullRequest {
  project?: string | undefined;
  repository: string;
  pullRequestId: number;
  title?: string | undefined;
  description?: string | undefined;
  isDraft?: boolean | undefined;
}

export interface ListPullRequests {
  project?: string | undefined;
  repository: string;
  status: 'active' | 'completed' | 'abandoned' | 'all';
  sourceBranch?: string | undefined;
  targetBranch?: string | undefined;
  top: number;
  skip: number;
}

export class PullRequestService {
  constructor(
    private readonly client: AdoClient,
    private readonly repositories: RepositoryService,
    private readonly branches: BranchService,
  ) {}

  async get(
    project: string | undefined,
    repository: string,
    pullRequestId: number,
  ): Promise<PullRequest> {
    const resolved = await this.repositories.get(project, repository);
    const result = (
      await this.client.request(
        [...repositoryPath(resolved), 'pullrequests', String(pullRequestId)],
        pullRequestSchema,
      )
    ).data;
    this.verifyRepository(result, resolved);
    return result;
  }

  async list(input: ListPullRequests): Promise<Page<PullRequest>> {
    const resolved = await this.repositories.get(
      input.project,
      input.repository,
    );
    const result = await this.client.request(
      [...repositoryPath(resolved), 'pullrequests'],
      listSchema(pullRequestSchema),
      {
        query: {
          'searchCriteria.status': input.status,
          'searchCriteria.sourceRefName':
            input.sourceBranch === undefined
              ? undefined
              : normalizeBranch(input.sourceBranch),
          'searchCriteria.targetRefName':
            input.targetBranch === undefined
              ? undefined
              : normalizeBranch(input.targetBranch),
          $top: input.top,
          $skip: input.skip,
        },
      },
    );
    for (const pr of result.data.value) this.verifyRepository(pr, resolved);
    return {
      items: result.data.value,
      // A full page is a possible next page; ADO does not report a total here.
      ...(result.data.value.length === input.top
        ? { nextSkip: input.skip + input.top }
        : {}),
    };
  }

  async create(input: CreatePullRequest): Promise<PullRequest> {
    this.repositories.requireWriteAccess();
    const sourceRefName = normalizeBranch(input.sourceBranch);
    const targetRefName = normalizeBranch(input.targetBranch);
    if (sourceRefName === targetRefName)
      throw new SafeError(
        'INVALID_ARGUMENT',
        'Source and target branches must differ.',
      );
    const resolved = await this.repositories.get(
      input.project,
      input.repository,
    );
    await Promise.all([
      this.branches.getInRepository(resolved, sourceRefName),
      this.branches.getInRepository(resolved, targetRefName),
    ]);
    // Explicit allowlist: callers cannot smuggle completion options into this write.
    const result = (
      await this.client.request(
        [...repositoryPath(resolved), 'pullrequests'],
        pullRequestSchema,
        {
          method: 'POST',
          body: {
            sourceRefName,
            targetRefName,
            title: input.title,
            ...(input.description === undefined
              ? {}
              : { description: input.description }),
            isDraft: input.isDraft ?? false,
          },
        },
      )
    ).data;
    this.verifyRepository(result, resolved, true);
    return result;
  }

  async update(input: UpdatePullRequest): Promise<PullRequest> {
    this.repositories.requireWriteAccess();
    const body = {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      ...(input.isDraft === undefined ? {} : { isDraft: input.isDraft }),
    };
    if (Object.keys(body).length === 0)
      throw new SafeError(
        'INVALID_ARGUMENT',
        'An update requires title, description, or isDraft.',
      );
    const resolved = await this.repositories.get(
      input.project,
      input.repository,
    );
    // Check the actual PR's repository before writing; a PR ID alone is not permission.
    const existing = (
      await this.client.request(
        [
          ...repositoryPath(resolved),
          'pullrequests',
          String(input.pullRequestId),
        ],
        pullRequestSchema,
      )
    ).data;
    this.verifyRepository(existing, resolved);
    const result = (
      await this.client.request(
        [
          ...repositoryPath(resolved),
          'pullrequests',
          String(input.pullRequestId),
        ],
        pullRequestSchema,
        { method: 'PATCH', body },
      )
    ).data;
    this.verifyRepository(result, resolved, true);
    return result;
  }

  private verifyRepository(
    pr: PullRequest,
    repository: Repository,
    write = false,
  ): void {
    if (
      pr.repository.id.toLowerCase() !== repository.id.toLowerCase() ||
      pr.repository.project.id.toLowerCase() !==
        repository.project.id.toLowerCase()
    ) {
      throw new SafeError(
        'REPOSITORY_NOT_ALLOWED',
        `The pull request does not belong to the selected repository.${write ? ' The write outcome may be unknown; inspect PRs before retrying.' : ''}`,
      );
    }
  }

  summarize(pr: PullRequest) {
    const webUrl = this.client.url([
      pr.repository.project.id,
      '_git',
      pr.repository.id,
      'pullrequest',
      String(pr.pullRequestId),
    ]);
    webUrl.search = '';
    return {
      pullRequestId: pr.pullRequestId,
      url: webUrl.href,
      title: pr.title,
      description: pr.description ?? '',
      status: pr.status,
      isDraft: pr.isDraft ?? false,
      sourceBranch: pr.sourceRefName.replace(/^refs\/heads\//u, ''),
      targetBranch: pr.targetRefName.replace(/^refs\/heads\//u, ''),
      project: {
        id: pr.repository.project.id,
        name: pr.repository.project.name,
      },
      repository: { id: pr.repository.id, name: pr.repository.name },
      createdBy: pr.createdBy?.displayName ?? null,
      creationDate: pr.creationDate ?? null,
    };
  }
}
