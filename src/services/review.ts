import { z } from 'zod';
import type { AdoClient } from '../ado/client.js';
import { listSchema, type Repository } from '../ado/types.js';
import {
  commentSchema,
  threadSchema,
  identityRefSchema,
  changesSchema,
  iterationSchema,
  type Thread,
} from '../ado/phase2-types.js';
import type { RepositoryService } from './repositories.js';
import { repositoryPath } from './repositories.js';
import type { PullRequestService } from './pull-requests.js';
import type { IdentityService } from './identities.js';
import { SafeError } from '../errors.js';
import { boundedText, page } from './bounds.js';

export interface PrContext {
  project?: string | undefined;
  repository: string;
  pullRequestId: number;
}
const recovery =
  'read this pull request, its threads and reviewers before retrying';
export class ReviewService {
  constructor(
    private readonly client: AdoClient,
    readonly repositories: RepositoryService,
    private readonly pullRequests: PullRequestService,
    readonly identities: IdentityService,
  ) {}
  async context(input: PrContext, write = false) {
    if (write) this.repositories.requireWriteAccess();
    const pr = await this.pullRequests.get(
      input.project,
      input.repository,
      input.pullRequestId,
    );
    return {
      repository: pr.repository,
      path: [
        ...repositoryPath(pr.repository),
        'pullrequests',
        String(input.pullRequestId),
      ],
    };
  }
  async changes(
    input: PrContext,
    iterationId: number | undefined,
    compareTo: number,
    top: number,
    skip: number,
  ) {
    const { path } = await this.context(input);
    const iterations = (
      await this.client.request(
        [...path, 'iterations'],
        listSchema(iterationSchema),
        { endpoint: 'phase2' },
      )
    ).data.value;
    const iteration =
      iterationId === undefined
        ? iterations.reduce<(typeof iterations)[number] | undefined>(
            (latest, next) => (!latest || next.id > latest.id ? next : latest),
            undefined,
          )
        : iterations.find((item) => item.id === iterationId);
    if (!iteration || compareTo >= iteration.id)
      throw new SafeError(
        'INVALID_ARGUMENT',
        'Select an existing PR iteration and an earlier compareTo iteration (0 means merge base).',
      );
    const base =
      compareTo === 0
        ? iteration.commonRefCommit
        : iterations.find((item) => item.id === compareTo)?.sourceRefCommit;
    if (!base)
      throw new SafeError(
        'INVALID_RESPONSE',
        'The comparison commit is unavailable; explicitly select an earlier iteration or inspect the PR on the server.',
      );
    const result = (
      await this.client.request(
        [...path, 'iterations', String(iteration.id), 'changes'],
        changesSchema,
        {
          endpoint: 'phase2',
          query: { $compareTo: compareTo, $top: top, $skip: skip },
        },
      )
    ).data;
    if (
      result.changeEntries.length > top ||
      (result.nextSkip && result.nextSkip <= skip)
    )
      throw new SafeError(
        'INVALID_RESPONSE',
        'The server returned an invalid changes page.',
      );
    return {
      iterationId: iteration.id,
      compareTo,
      sourceCommit: iteration.sourceRefCommit.commitId,
      targetCommit: iteration.targetRefCommit.commitId,
      baseCommit: base.commitId,
      items: result.changeEntries.map((change) => ({
        ...change,
        item: { ...change.item, path: change.item.path.slice(0, 4096) },
      })),
      ...(result.nextSkip ? { nextSkip: result.nextSkip } : {}),
      reviewNote:
        'Changed-file metadata only. Use repo_file/get_content at baseCommit and sourceCommit to inspect text; retain iterationId for subsequent pages.',
    };
  }
  async file(
    project: string | undefined,
    repository: string,
    path: string,
    commit: string,
    startLine: number,
    maxLines: number,
  ) {
    const resolved = await this.repositories.get(project, repository);
    if (
      !path.startsWith('/') ||
      /[\\\u0000-\u001f]/u.test(path) ||
      path.split('/').some((segment) => ['.', '..'].includes(segment))
    )
      throw new SafeError(
        'INVALID_ARGUMENT',
        'Use an absolute repository file path without dot segments, backslashes, or control characters.',
      );
    const item = (
      await this.client.request(
        [...repositoryPath(resolved), 'items'],
        z.object({
          path: z.string(),
          gitObjectType: z.string(),
          content: z.string().optional(),
          contentMetadata: z
            .object({ isBinary: z.boolean().optional() })
            .optional(),
        }),
        {
          endpoint: 'phase2',
          query: {
            path,
            includeContent: true,
            includeContentMetadata: true,
            'versionDescriptor.versionType': 'commit',
            'versionDescriptor.version': commit,
            resolveLfs: false,
            $format: 'json',
          },
        },
      )
    ).data;
    if (
      item.path !== path ||
      item.gitObjectType !== 'blob' ||
      item.contentMetadata?.isBinary ||
      item.content === undefined ||
      item.content.includes('\u0000')
    )
      throw new SafeError(
        'UNSUPPORTED_FILE',
        'The response must be the requested text file. Binary, directory, and missing content responses are not returned.',
      );
    const lines = item.content.split(/\r?\n/u);
    const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
    let text = '';
    let count = 0;
    for (const line of selected) {
      const next = `${count ? '\n' : ''}${line}`;
      if (text.length + next.length > 32000) break;
      text += next;
      count++;
    }
    if (!count && selected.length)
      throw new SafeError(
        'RESPONSE_TOO_LARGE',
        'A selected file line exceeds 32000 characters. Inspect this file locally.',
      );
    const nextStartLine = startLine + count;
    return {
      path,
      commit,
      startLine,
      linesReturned: count,
      totalLines: lines.length,
      content: text,
      truncated: nextStartLine <= lines.length,
      ...(nextStartLine <= lines.length ? { nextStartLine } : {}),
    };
  }
  async reviewers(input: PrContext) {
    const { path } = await this.context(input);
    const items = (
      await this.client.request(
        [...path, 'reviewers'],
        listSchema(identityRefSchema),
        { endpoint: 'phase2' },
      )
    ).data.value;
    if (items.length > 100)
      throw new SafeError(
        'RESPONSE_TOO_LARGE',
        'This PR has more than 100 reviewers. Inspect reviewers on the server.',
      );
    return {
      items: items.map((item) => ({
        id: item.id,
        displayName: item.displayName?.slice(0, 256) ?? null,
        uniqueName: item.uniqueName?.slice(0, 256) ?? null,
        vote: item.vote ?? 0,
        isRequired: item.isRequired ?? false,
        isContainer: item.isContainer ?? false,
      })),
    };
  }
  async updateReviewer(
    input: PrContext,
    operation: 'add' | 'remove',
    reviewerId: string,
  ) {
    const { path } = await this.context(input, true);
    const current = (
      await this.client.request(
        [...path, 'reviewers'],
        listSchema(identityRefSchema),
        { endpoint: 'phase2' },
      )
    ).data.value;
    if (operation === 'add') {
      await this.identities.person(reviewerId);
      // Adding an existing reviewer must preserve their vote and policy state.
      if (
        current.some(
          (person) => person.id.toLowerCase() === reviewerId.toLowerCase(),
        )
      )
        return this.reviewers(input);
      const result = (
        await this.client.request(
          [...path, 'reviewers', reviewerId],
          identityRefSchema,
          {
            endpoint: 'phase2',
            method: 'PUT',
            body: { id: reviewerId },
            recovery,
          },
        )
      ).data;
      if (result.id.toLowerCase() !== reviewerId.toLowerCase())
        throw new SafeError(
          'INVALID_RESPONSE',
          `The reviewer response did not match the selected person; ${recovery}.`,
        );
    } else {
      if (
        !current.some(
          (person) => person.id.toLowerCase() === reviewerId.toLowerCase(),
        )
      )
        throw new SafeError(
          'IDENTITY_NOT_FOUND',
          'The explicit ID is not currently a reviewer of this PR.',
        );
      await this.client.request(
        [...path, 'reviewers', reviewerId],
        z.unknown(),
        { endpoint: 'phase2', method: 'DELETE', allowEmpty: true, recovery },
      );
    }
    return this.reviewers(input);
  }
  private comment(comment: ReturnType<typeof commentSchema.parse>) {
    return {
      id: comment.id,
      parentCommentId: comment.parentCommentId ?? 0,
      ...boundedText(comment.content ?? ''),
      author: comment.author?.displayName?.slice(0, 256) ?? null,
      publishedDate: comment.publishedDate ?? null,
      isDeleted: comment.isDeleted ?? false,
    };
  }
  private thread(thread: Thread) {
    return {
      id: thread.id,
      status: thread.status ?? null,
      isDeleted: thread.isDeleted ?? false,
      comments: (thread.comments ?? [])
        .slice(0, 10)
        .map((comment) => this.comment(comment)),
      commentsTruncated: (thread.comments?.length ?? 0) > 10,
    };
  }
  async threads(input: PrContext, top: number, skip: number) {
    const { path } = await this.context(input);
    const result = (
      await this.client.request(
        [...path, 'threads'],
        listSchema(threadSchema),
        { endpoint: 'phase2' },
      )
    ).data.value;
    return page(
      result.map((thread) => this.thread(thread)),
      top,
      skip,
    );
  }
  private async verifiedThread(path: string[], threadId: number) {
    const result = (
      await this.client.request(
        [...path, 'threads', String(threadId)],
        threadSchema,
        { endpoint: 'phase2' },
      )
    ).data;
    if (result.id !== threadId)
      throw new SafeError(
        'INVALID_RESPONSE',
        'The server returned a different thread ID.',
      );
    return result;
  }
  async comments(
    input: PrContext,
    threadId: number,
    top: number,
    skip: number,
  ) {
    const { path } = await this.context(input);
    await this.verifiedThread(path, threadId);
    return page(
      (
        await this.client.request(
          [...path, 'threads', String(threadId), 'comments'],
          listSchema(commentSchema),
          { endpoint: 'phase2' },
        )
      ).data.value.map((comment) => this.comment(comment)),
      top,
      skip,
    );
  }
  async writeThread(
    input: PrContext,
    action: 'create' | 'reply' | 'update_status',
    threadId: number | undefined,
    content: string | undefined,
    status: 'resolved' | 'active' | undefined,
  ) {
    const { path } = await this.context(input, true);
    if (action !== 'create') await this.verifiedThread(path, threadId!);
    if (action === 'reply') {
      const comment = (
        await this.client.request(
          [...path, 'threads', String(threadId), 'comments'],
          commentSchema,
          {
            endpoint: 'phase2',
            method: 'POST',
            body: { content, commentType: 1, parentCommentId: 0 },
            recovery,
          },
        )
      ).data;
      return { threadId, comment: this.comment(comment) };
    }
    const thread = (
      await this.client.request(
        [
          ...path,
          'threads',
          ...(action === 'create' ? [] : [String(threadId)]),
        ],
        threadSchema,
        {
          endpoint: 'phase2',
          method: action === 'create' ? 'POST' : 'PATCH',
          body:
            action === 'create'
              ? {
                  comments: [{ content, commentType: 1, parentCommentId: 0 }],
                  status: 1,
                }
              : { status: status === 'resolved' ? 2 : 1 },
          recovery,
        },
      )
    ).data;
    if (action !== 'create' && thread.id !== threadId)
      throw new SafeError(
        'INVALID_RESPONSE',
        `The thread write response did not match; ${recovery}.`,
      );
    return this.thread(thread);
  }
  async linkedIds(input: PrContext) {
    const { path, repository } = await this.context(input);
    const result = (
      await this.client.request(
        [...path, 'workitems'],
        listSchema(
          z.object({ id: z.string().regex(/^\d+$/u).transform(Number) }),
        ),
        { endpoint: 'phase2' },
      )
    ).data.value;
    if (result.length > 100)
      throw new SafeError(
        'RESPONSE_TOO_LARGE',
        'The PR has more than 100 work-item links. Inspect links on the server.',
      );
    return { repository, ids: result.map((item) => item.id) };
  }
  artifact(repository: Repository, pullRequestId: number) {
    return `vstfs:///Git/PullRequestId/${repository.project.id}%2F${repository.id}%2F${pullRequestId}`;
  }
}
