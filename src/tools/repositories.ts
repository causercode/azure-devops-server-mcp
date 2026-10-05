import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  summarizeRepository,
  type RepositoryService,
} from '../services/repositories.js';
import {
  projectInput,
  repositoryInput,
  topInput,
  skipInput,
  readAnnotations,
  required,
  rejectFields,
  type ToolRunner,
} from './shared.js';

export function registerRepositoryTool(
  server: McpServer,
  service: RepositoryService,
  run: ToolRunner,
) {
  server.registerTool(
    'repo_repository',
    {
      description:
        'Get or list Git repositories in an Azure DevOps Server project. Names and IDs are accepted. A configured ADO_ALLOWED_REPOSITORIES list restricts results and access. Use server_info/list_projects first if the project is unknown.',
      inputSchema: z.strictObject({
        action: z.enum(['get', 'list']),
        project: projectInput,
        repository: repositoryInput
          .optional()
          .describe('Repository name or ID; required for get.'),
        top: topInput,
        skip: skipInput,
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'get') {
          return summarizeRepository(
            await service.get(
              input.project,
              required(input.repository, 'repository', 'get'),
            ),
          );
        }
        rejectFields(input, ['repository']);
        const page = await service.list(input.project, input.top, input.skip);
        return { ...page, items: page.items.map(summarizeRepository) };
      }),
  );
}
