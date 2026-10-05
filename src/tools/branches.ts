import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { summarizeBranch, type BranchService } from '../services/branches.js';
import {
  projectInput,
  repositoryInput,
  branchInput,
  topInput,
  continuationInput,
  readAnnotations,
  required,
  rejectFields,
  type ToolRunner,
} from './shared.js';

export function registerBranchTool(
  server: McpServer,
  service: BranchService,
  run: ToolRunner,
) {
  server.registerTool(
    'repo_branch',
    {
      description:
        'Get an exact remote Git branch or list remote branches. Branch names are case-sensitive. Only heads are exposed; local Git state is supplied by the agent.',
      inputSchema: z.strictObject({
        action: z.enum(['get', 'list']),
        project: projectInput,
        repository: repositoryInput,
        branch: branchInput
          .optional()
          .describe('Branch name; required for get.'),
        prefix: z
          .string()
          .max(1024)
          .optional()
          .describe(
            'Optional starts-with branch filter for list, such as feature/.',
          ),
        top: topInput,
        continuationToken: continuationInput,
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'get') {
          rejectFields(input, ['prefix', 'continuationToken']);
          return summarizeBranch(
            await service.get(
              input.project,
              input.repository,
              required(input.branch, 'branch', 'get'),
            ),
          );
        }
        rejectFields(input, ['branch']);
        const page = await service.list(
          input.project,
          input.repository,
          input.top,
          input.prefix,
          input.continuationToken,
        );
        return { ...page, items: page.items.map(summarizeBranch) };
      }),
  );
}
