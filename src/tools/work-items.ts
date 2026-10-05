import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { WorkItemService } from '../services/work-items.js';
import type { QueryService } from '../services/queries.js';
import type { WorkItemLinkService } from '../services/work-item-links.js';
import {
  projectInput,
  repositoryInput,
  pullRequestIdInput,
  topInput,
  skipInput,
  continuationInput,
  readAnnotations,
  writeAnnotations,
  required,
  allowFields,
  guidInput,
  type ToolRunner,
} from './shared.js';

const id = z.number().int().positive().max(2147483647);
const referenceName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,255}$/u);
const type = z.string().trim().min(1).max(128);
const fields = z
  .record(
    referenceName,
    z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine(
    (value) => Object.keys(value).length > 0 && Object.keys(value).length <= 30,
    'Provide 1–30 fields.',
  );
export function registerWorkItemTools(
  server: McpServer,
  service: WorkItemService,
  queries: QueryService,
  links: WorkItemLinkService,
  run: ToolRunner,
) {
  server.registerTool(
    'wit_work_item',
    {
      description:
        'Read work items, type/field metadata, comments or authorized links. Requires ADO_ALLOWED_WORK_ITEM_PROJECTS; omitted or [] denies all access. Fields and text are bounded; IDs are verified against the selected project.',
      inputSchema: z.strictObject({
        action: z.enum([
          'get',
          'get_batch',
          'get_type',
          'list_types',
          'list_fields',
          'list_comments',
          'get_links',
        ]),
        project: projectInput,
        id: id.optional(),
        ids: z.array(id).min(1).max(100).optional(),
        fields: z.array(referenceName).min(1).max(30).optional(),
        type: type.optional(),
        top: topInput.removeDefault().optional(),
        skip: skipInput.removeDefault().optional(),
        continuationToken: continuationInput,
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
        const top = input.top ?? 25;
        const skip = input.skip ?? 0;
        switch (input.action) {
          case 'get':
            allowFields(input, ['id', 'fields']);
            return service.get(
              input.project,
              required(input.id, 'id', input.action),
              input.fields,
            );
          case 'get_batch':
            allowFields(input, ['ids', 'fields']);
            return service.getBatch(
              input.project,
              required(input.ids, 'ids', input.action),
              input.fields,
            );
          case 'get_type':
            allowFields(input, ['type']);
            return service.metadata(
              input.project,
              input.action,
              required(input.type, 'type', input.action),
              top,
              skip,
            );
          case 'list_types':
            allowFields(input, ['top', 'skip']);
            return service.metadata(
              input.project,
              input.action,
              undefined,
              top,
              skip,
            );
          case 'list_fields':
            allowFields(input, ['type', 'top', 'skip']);
            return service.metadata(
              input.project,
              input.action,
              input.type,
              top,
              skip,
            );
          case 'list_comments':
            allowFields(input, ['id', 'top', 'continuationToken']);
            return service.comments(
              input.project,
              required(input.id, 'id', input.action),
              top,
              input.continuationToken,
            );
          case 'get_links':
            allowFields(input, ['id', 'top', 'skip']);
            return links.get(
              input.project,
              required(input.id, 'id', input.action),
              top,
              skip,
            );
        }
      }),
  );
  server.registerTool(
    'wit_work_item_write',
    {
      description:
        'Create a work item or update explicit fields with a mandatory revision test. Requires both ADO_ALLOWED_WORK_ITEM_PROJECTS and ADO_WORK_ITEM_WRITE_PROJECTS. No project moves, rule bypass, type changes or arbitrary JSON Patch. On uncertainty read the work item before retrying.',
      inputSchema: z.strictObject({
        action: z.enum(['create', 'update']),
        project: projectInput,
        id: id.optional(),
        revision: id.optional(),
        type: type.optional(),
        fields,
      }),
      annotations: writeAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'create') {
          allowFields(input, ['type', 'fields']);
          return service.create(
            input.project,
            required(input.type, 'type', input.action),
            input.fields,
          );
        }
        allowFields(input, ['id', 'revision', 'fields']);
        return service.update(
          input.project,
          required(input.id, 'id', input.action),
          required(input.revision, 'revision', input.action),
          input.fields,
        );
      }),
  );
  server.registerTool(
    'wit_work_item_comment_write',
    {
      description:
        'Add a comment as the authenticated identity to an authorized work item. No author spoofing or comment deletion/editing; inspect comments after an uncertain outcome.',
      inputSchema: z.strictObject({
        action: z.literal('add'),
        project: projectInput,
        id,
        text: z.string().trim().min(1).max(4000),
      }),
      annotations: writeAnnotations,
    },
    (input) =>
      run(() => service.addComment(input.project, input.id, input.text)),
  );
  server.registerTool(
    'wit_query',
    {
      description:
        'Discover saved queries or execute bounded flat WIQL: SELECT [fields] FROM WorkItems WHERE, with optional ORDER BY fields. Projection is normalized to System.Id; a project guard is injected and every returned ID is project-checked. Saved query execution accepts the same limited grammar. No ASOF/link/recursive query or saved-query mutation.',
      inputSchema: z.strictObject({
        action: z.enum(['list', 'get', 'get_results', 'wiql']),
        project: projectInput,
        queryId: guidInput.optional(),
        wiql: z.string().min(1).max(8000).optional(),
        top: topInput.removeDefault().optional(),
        skip: skipInput.removeDefault().optional(),
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'list') {
          allowFields(input, ['queryId', 'top', 'skip']);
          return queries.read(
            input.project,
            input.action,
            input.queryId,
            input.top ?? 25,
            input.skip ?? 0,
          );
        }
        if (input.action === 'get') {
          allowFields(input, ['queryId']);
          return queries.read(
            input.project,
            input.action,
            required(input.queryId, 'queryId', input.action),
            25,
            0,
          );
        }
        if (input.action === 'get_results') {
          allowFields(input, ['queryId', 'top']);
          return queries.execute(input.project, input.top ?? 25, {
            queryId: required(input.queryId, 'queryId', input.action),
          });
        }
        allowFields(input, ['wiql', 'top']);
        return queries.execute(input.project, input.top ?? 25, {
          wiql: required(input.wiql, 'wiql', input.action),
        });
      }),
  );
  server.registerTool(
    'wit_work_item_link_write',
    {
      description:
        'Link two same-project work items (parent/child/related), or link a ticket to a verified PR in an explicitly allowed repository of the same project. Mandatory source revision; both sides are checked. No arbitrary artifact URLs or unlinking.',
      inputSchema: z.strictObject({
        action: z.enum(['link', 'link_to_pull_request']),
        project: projectInput,
        id,
        revision: id,
        targetId: id.optional(),
        relationship: z.enum(['parent', 'child', 'related']).optional(),
        repository: repositoryInput.optional(),
        pullRequestId: pullRequestIdInput.optional(),
      }),
      annotations: writeAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'link') {
          allowFields(input, ['id', 'revision', 'targetId', 'relationship']);
          return links.link(
            input.project,
            input.id,
            input.revision,
            required(input.targetId, 'targetId', input.action),
            required(input.relationship, 'relationship', input.action),
          );
        }
        allowFields(input, ['id', 'revision', 'repository', 'pullRequestId']);
        return links.linkPr(
          {
            project: input.project,
            repository: required(input.repository, 'repository', input.action),
            pullRequestId: required(
              input.pullRequestId,
              'pullRequestId',
              input.action,
            ),
          },
          input.id,
          input.revision,
        );
      }),
  );
}
