import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ReviewService } from '../services/review.js';
import {
  projectInput,
  repositoryInput,
  pullRequestIdInput,
  topInput,
  skipInput,
  readAnnotations,
  writeAnnotations,
  required,
  allowFields,
  guidInput,
  type ToolRunner,
} from './shared.js';

export function registerReviewTools(
  server: McpServer,
  service: ReviewService,
  run: ToolRunner,
) {
  server.registerTool(
    'repo_file',
    {
      description:
        'Read bounded text file content at an explicit 40-hex commit for PR review. Use baseCommit/sourceCommit from repo_pull_request/get_changes. Maximum 200 lines and 32000 characters per result; binary/directory responses are rejected. Repository scope applies.',
      inputSchema: z.strictObject({
        action: z.literal('get_content'),
        project: projectInput,
        repository: repositoryInput,
        path: z.string().min(1).max(4096),
        commit: z.string().regex(/^[a-f\d]{40}$/iu),
        startLine: z.number().int().min(1).max(1000000).default(1),
        maxLines: z.number().int().min(1).max(200).default(100),
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(() =>
        service.file(
          input.project,
          input.repository,
          input.path,
          input.commit,
          input.startLine,
          input.maxLines,
        ),
      ),
  );
  server.registerTool(
    'core_identity',
    {
      description:
        'Search active people or resolve an explicit identity ID for reviewer assignment in an authorized repository. Search returns candidates without choosing among them; verify account/domain/mail and pass an explicit ID. Requires Identity Read access (a PAT scope when using a PAT); no group assignment.',
      inputSchema: z.strictObject({
        action: z.enum(['search', 'get']),
        project: projectInput,
        repository: repositoryInput,
        search: z.string().trim().min(2).max(256).optional(),
        identityId: guidInput.optional(),
        top: topInput.removeDefault().optional(),
        skip: skipInput.removeDefault().optional(),
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'get') {
          allowFields(input, ['repository', 'identityId']);
          const id = required(input.identityId, 'identityId', input.action);
          await service.repositories.get(input.project, input.repository);
          return service.identities.person(id);
        }
        allowFields(input, ['repository', 'search', 'top', 'skip']);
        const search = required(input.search, 'search', input.action);
        await service.repositories.get(input.project, input.repository);
        return service.identities.search(
          search,
          input.top ?? 25,
          input.skip ?? 0,
        );
      }),
  );
  server.registerTool(
    'repo_pull_request_thread',
    {
      description:
        'Read paged PR discussion threads or comments. PR/repository scope is checked before thread access. Threads include at most ten shortened comments; list_comments retrieves additional comments. REST full lists are locally paged under the transport byte limit.',
      inputSchema: z.strictObject({
        action: z.enum(['list', 'list_comments']),
        project: projectInput,
        repository: repositoryInput,
        pullRequestId: pullRequestIdInput,
        threadId: pullRequestIdInput.optional(),
        top: topInput.removeDefault().optional(),
        skip: skipInput.removeDefault().optional(),
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'list') {
          allowFields(input, ['repository', 'pullRequestId', 'top', 'skip']);
          return service.threads(input, input.top ?? 25, input.skip ?? 0);
        }
        return service.comments(
          input,
          required(input.threadId, 'threadId', input.action),
          input.top ?? 25,
          input.skip ?? 0,
        );
      }),
  );
  server.registerTool(
    'repo_pull_request_thread_write',
    {
      description:
        'Create a PR thread, reply to a thread, or resolve/reopen it (status resolved/active). Requires ADO_ALLOWED_REPOSITORIES write scope and verifies PR/thread before writes. No votes, author spoofing, deletion or file-line anchoring; inspect threads after uncertain outcomes.',
      inputSchema: z.strictObject({
        action: z.enum(['create', 'reply', 'update_status']),
        project: projectInput,
        repository: repositoryInput,
        pullRequestId: pullRequestIdInput,
        threadId: pullRequestIdInput.optional(),
        content: z.string().trim().min(1).max(4000).optional(),
        status: z.enum(['resolved', 'active']).optional(),
      }),
      annotations: writeAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'create') {
          allowFields(input, ['repository', 'pullRequestId', 'content']);
          required(input.content, 'content', input.action);
        } else if (input.action === 'reply') {
          allowFields(input, [
            'repository',
            'pullRequestId',
            'threadId',
            'content',
          ]);
          required(input.threadId, 'threadId', input.action);
          required(input.content, 'content', input.action);
        } else {
          allowFields(input, [
            'repository',
            'pullRequestId',
            'threadId',
            'status',
          ]);
          required(input.threadId, 'threadId', input.action);
          required(input.status, 'status', input.action);
        }
        return service.writeThread(
          input,
          input.action,
          input.threadId,
          input.content,
          input.status,
        );
      }),
  );
}
