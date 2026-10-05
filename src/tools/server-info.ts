import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerInfoService } from '../services/server-info.js';
import {
  topInput,
  continuationInput,
  readAnnotations,
  rejectFields,
  type ToolRunner,
} from './shared.js';

export function registerServerInfoTool(
  server: McpServer,
  service: ServerInfoService,
  run: ToolRunner,
) {
  server.registerTool(
    'server_info',
    {
      description:
        'Check Azure DevOps Server connectivity and safe configuration, or discover accessible projects without a configured default project. With a repository allowlist, diagnostics query only allowed repositories and discovery returns only their projects. Credentials are never returned. The API version is configured; product build is reported only if the server supplies it.',
      inputSchema: z.strictObject({
        action: z.enum(['get', 'list_projects']).default('get'),
        top: topInput,
        continuationToken: continuationInput,
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'get') {
          rejectFields(input, ['continuationToken']);
          return service.get();
        }
        return service.listProjects(input.top, input.continuationToken);
      }),
  );
}
