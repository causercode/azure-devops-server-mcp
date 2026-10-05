import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { PullRequestService } from '../services/pull-requests.js';
import type { ReviewService } from '../services/review.js';
import type { WorkItemLinkService } from '../services/work-item-links.js';
import {
  projectInput,
  repositoryInput,
  branchInput,
  pullRequestIdInput,
  topInput,
  skipInput,
  readAnnotations,
  writeAnnotations,
  required,
  rejectFields,
  allowFields,
  guidInput,
  type ToolRunner,
} from './shared.js';

export function registerPullRequestTools(
  server: McpServer,
  service: PullRequestService,
  review: ReviewService,
  links: WorkItemLinkService,
  run: ToolRunner,
) {
  server.registerTool(
    'repo_pull_request',
    {
      description:
        'Get/list PRs, read reviewers/votes, inspect linked work items, or get paged changed-file metadata with pinned commits for review. get_work_items requires separate work-item project read scope. Returns human-facing PR URLs.',
      inputSchema: z.strictObject({
        action: z.enum([
          'get',
          'list',
          'get_changes',
          'list_reviewers',
          'get_work_items',
        ]),
        project: projectInput,
        repository: repositoryInput,
        pullRequestId: pullRequestIdInput
          .optional()
          .describe('Required for get.'),
        status: z.enum(['active', 'completed', 'abandoned', 'all']).optional(),
        sourceBranch: branchInput.optional(),
        targetBranch: branchInput.optional(),
        top: topInput.removeDefault().optional(),
        skip: skipInput.removeDefault().optional(),
        iterationId: pullRequestIdInput.optional(),
        compareTo: z.number().int().min(0).max(2147483647).optional(),
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
        if (
          ['get_changes', 'list_reviewers', 'get_work_items'].includes(
            input.action,
          )
        ) {
          allowFields(
            input,
            input.action === 'get_changes'
              ? [
                  'repository',
                  'pullRequestId',
                  'iterationId',
                  'compareTo',
                  'top',
                  'skip',
                ]
              : ['repository', 'pullRequestId'],
          );
          const context = {
            ...input,
            pullRequestId: required(
              input.pullRequestId,
              'pullRequestId',
              input.action,
            ),
          };
          if (input.action === 'get_changes')
            return review.changes(
              context,
              input.iterationId,
              input.compareTo ?? 0,
              input.top ?? 25,
              input.skip ?? 0,
            );
          if (input.action === 'list_reviewers')
            return review.reviewers(context);
          return links.prItems(context);
        }
        rejectFields(input, ['iterationId', 'compareTo']);
        if (input.action === 'get') {
          rejectFields(input, ['sourceBranch', 'targetBranch']);
          return service.summarize(
            await service.get(
              input.project,
              input.repository,
              required(input.pullRequestId, 'pullRequestId', 'get'),
            ),
          );
        }
        rejectFields(input, ['pullRequestId']);
        const page = await service.list({
          ...input,
          status: input.status ?? 'active',
          top: input.top ?? 25,
          skip: input.skip ?? 0,
        });
        return {
          ...page,
          items: page.items.map((pr) => service.summarize(pr)),
        };
      }),
  );

  server.registerTool(
    'repo_pull_request_write',
    {
      description:
        'Create a PR after verifying both remote branches, update title/description/draft state, or add/remove one explicit active-person reviewer GUID (use core_identity first). Repository writes require ADO_ALLOWED_REPOSITORIES. Re-adding a current reviewer preserves their vote; no approval voting, merge, completion, autocomplete, policy bypass, retargeting or branch deletion. Inspect the PR/reviewers after uncertain writes.',
      inputSchema: z.strictObject({
        action: z.enum(['create', 'update', 'update_reviewers']),
        project: projectInput,
        repository: repositoryInput,
        pullRequestId: pullRequestIdInput
          .optional()
          .describe('Required for update; omit for create.'),
        sourceBranch: branchInput
          .optional()
          .describe('Required for create. Push the branch through Git first.'),
        targetBranch: branchInput
          .optional()
          .describe('Required for create, such as develop.'),
        title: z
          .string()
          .trim()
          .min(1)
          .max(400)
          .optional()
          .describe('Required for create; optional for update.'),
        description: z
          .string()
          .max(4000)
          .optional()
          .describe('PR description. Empty string clears it on update.'),
        isDraft: z
          .boolean()
          .optional()
          .describe('Create as draft, or change draft state on update.'),
        operation: z.enum(['add', 'remove']).optional(),
        reviewerId: guidInput.optional(),
      }),
      annotations: writeAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'update_reviewers') {
          allowFields(input, [
            'repository',
            'pullRequestId',
            'operation',
            'reviewerId',
          ]);
          return review.updateReviewer(
            {
              ...input,
              pullRequestId: required(
                input.pullRequestId,
                'pullRequestId',
                input.action,
              ),
            },
            required(input.operation, 'operation', input.action),
            required(input.reviewerId, 'reviewerId', input.action),
          );
        }
        rejectFields(input, ['operation', 'reviewerId']);
        if (input.action === 'create') {
          rejectFields(input, ['pullRequestId']);
          return service.summarize(
            await service.create({
              ...input,
              sourceBranch: required(
                input.sourceBranch,
                'sourceBranch',
                'create',
              ),
              targetBranch: required(
                input.targetBranch,
                'targetBranch',
                'create',
              ),
              title: required(input.title, 'title', 'create'),
            }),
          );
        }
        rejectFields(input, ['sourceBranch', 'targetBranch']);
        return service.summarize(
          await service.update({
            ...input,
            pullRequestId: required(
              input.pullRequestId,
              'pullRequestId',
              'update',
            ),
          }),
        );
      }),
  );
}
