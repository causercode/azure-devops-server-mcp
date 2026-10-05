import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { PullRequestService } from '../services/pull-requests.js';
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
  type ToolRunner,
} from './shared.js';

export function registerPullRequestTools(
  server: McpServer,
  service: PullRequestService,
  run: ToolRunner,
) {
  server.registerTool(
    'repo_pull_request',
    {
      description:
        'Get a pull request by ID or list pull requests in a repository, optionally filtering status and source/target branch. Returns human-facing PR URLs.',
      inputSchema: z.strictObject({
        action: z.enum(['get', 'list']),
        project: projectInput,
        repository: repositoryInput,
        pullRequestId: pullRequestIdInput
          .optional()
          .describe('Required for get.'),
        status: z
          .enum(['active', 'completed', 'abandoned', 'all'])
          .default('active'),
        sourceBranch: branchInput.optional(),
        targetBranch: branchInput.optional(),
        top: topInput,
        skip: skipInput,
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
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
        const page = await service.list(input);
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
        'Create a PR after verifying both remote branches, or update its title, description, or draft state. Writes require a process-configured ADO_ALLOWED_REPOSITORIES entry; otherwise they are disabled. The agent supplies project/repository and local Git context. No merge, completion, autocomplete, policy bypass, retargeting, or branch deletion is supported. After an uncertain write outcome, list PRs before retrying.',
      inputSchema: z.strictObject({
        action: z.enum(['create', 'update']),
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
      }),
      annotations: writeAnnotations,
    },
    (input) =>
      run(async () => {
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
