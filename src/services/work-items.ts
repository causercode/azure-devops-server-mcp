import { z } from 'zod';
import type { AdoClient } from '../ado/client.js';
import { listSchema, type Project } from '../ado/types.js';
import {
  fieldSchema,
  typeSchema,
  workItemSchema,
  workItemCommentSchema,
  type WorkItem,
} from '../ado/phase2-types.js';
import type { WorkItemScope } from './work-item-scope.js';
import { SafeError } from '../errors.js';
import { boundedText, page } from './bounds.js';

export const DEFAULT_FIELDS = [
  'System.Id',
  'System.TeamProject',
  'System.WorkItemType',
  'System.Title',
  'System.State',
  'System.AssignedTo',
  'System.Description',
];
export type FieldValues = Record<string, string | number | boolean | null>;
export function witPath(project: Project): string[] {
  return [project.id, '_apis', 'wit'];
}
const recovery = 'read the work item, its links and comments before retrying';

export class WorkItemService {
  constructor(
    private readonly client: AdoClient,
    readonly scope: WorkItemScope,
  ) {}

  async verified(
    project: Project,
    id: number,
    fields = DEFAULT_FIELDS,
    relations = false,
  ): Promise<WorkItem> {
    const item = (
      await this.client.request(
        [...witPath(project), 'workitems', String(id)],
        workItemSchema,
        {
          endpoint: 'phase2',
          query: relations
            ? { $expand: 'Relations' }
            : {
                fields: [...new Set([...fields, 'System.TeamProject'])].join(
                  ',',
                ),
              },
        },
      )
    ).data;
    this.verify(item, project, id);
    return item;
  }
  private verify(item: WorkItem, project: Project, id: number) {
    this.scope.verify(project, item.fields['System.TeamProject']);
    if (item.id !== id)
      throw new SafeError(
        'INVALID_RESPONSE',
        'The server returned a different work item ID.',
      );
  }
  async get(project: string | undefined, id: number, fields?: string[]) {
    const resolved = await this.scope.resolve(project);
    return this.summarize(await this.verified(resolved, id, fields), fields);
  }
  async batchVerified(
    project: Project,
    ids: number[],
    fields = DEFAULT_FIELDS,
  ) {
    if (new Set(ids).size !== ids.length)
      throw new SafeError('INVALID_ARGUMENT', 'Work item IDs must be unique.');
    const result = (
      await this.client.request(
        [...witPath(project), 'workitemsbatch'],
        listSchema(workItemSchema),
        {
          endpoint: 'phase2',
          method: 'POST',
          readOnly: true,
          body: {
            ids,
            fields: [...new Set([...fields, 'System.TeamProject'])],
            errorPolicy: 'Fail',
          },
        },
      )
    ).data.value;
    if (
      result.length !== ids.length ||
      new Set(result.map((item) => item.id)).size !== ids.length
    )
      throw new SafeError(
        'INVALID_RESPONSE',
        'The server returned an incomplete or duplicate work item batch.',
      );
    for (const item of result) {
      if (!ids.includes(item.id))
        throw new SafeError(
          'INVALID_RESPONSE',
          'The server returned an unrequested work item ID.',
        );
      this.verify(item, project, item.id);
    }
    return result;
  }
  async getBatch(
    project: string | undefined,
    ids: number[],
    fields?: string[],
  ) {
    const resolved = await this.scope.resolve(project);
    return {
      items: (await this.batchVerified(resolved, ids, fields)).map((item) =>
        this.summarize(item, fields),
      ),
    };
  }
  summarize(item: WorkItem, fields = DEFAULT_FIELDS) {
    const selected: Record<string, unknown> = {};
    const truncatedFields: string[] = [];
    for (const field of [...new Set([...fields, 'System.TeamProject'])]) {
      const value = item.fields[field];
      if (value === undefined) continue;
      if (typeof value === 'string') {
        selected[field] = value.slice(0, 4000);
        if (value.length > 4000) truncatedFields.push(field);
      } else if (
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
      )
        selected[field] = value;
      else {
        const identity = z
          .object({
            id: z.string().optional(),
            displayName: z.string().optional(),
            uniqueName: z.string().optional(),
          })
          .safeParse(value);
        if (identity.success)
          selected[field] = Object.fromEntries(
            Object.entries(identity.data).map(([key, entry]) => [
              key,
              entry?.slice(0, 256),
            ]),
          );
      }
    }
    return {
      id: item.id,
      revision: item.rev,
      fields: selected,
      ...(truncatedFields.length ? { truncatedFields } : {}),
    };
  }
  async metadata(
    project: string | undefined,
    action: 'list_types' | 'get_type' | 'list_fields',
    type: string | undefined,
    top: number,
    skip: number,
  ) {
    const resolved = await this.scope.resolve(project);
    if (action === 'get_type') {
      const item = (
        await this.client.request(
          [...witPath(resolved), 'workitemtypes', type!],
          typeSchema,
          { endpoint: 'phase2' },
        )
      ).data;
      return { ...item, description: item.description?.slice(0, 4000) ?? '' };
    }
    if (action === 'list_types') {
      const result = await this.client.request(
        [...witPath(resolved), 'workitemtypes'],
        listSchema(typeSchema),
        { endpoint: 'phase2' },
      );
      return page(
        result.data.value.map((item) => ({
          ...item,
          description: item.description?.slice(0, 4000) ?? '',
        })),
        top,
        skip,
      );
    }
    const path = type
      ? [...witPath(resolved), 'workitemtypes', type, 'fields']
      : [...witPath(resolved), 'fields'];
    return page(
      (
        await this.client.request(path, listSchema(fieldSchema), {
          endpoint: 'phase2',
        })
      ).data.value,
      top,
      skip,
    );
  }
  async create(project: string | undefined, type: string, fields: FieldValues) {
    const resolved = await this.scope.resolve(project, true);
    const patch = this.fieldPatch(resolved, fields);
    if (
      typeof fields['System.Title'] !== 'string' ||
      !fields['System.Title'].trim()
    )
      throw new SafeError(
        'INVALID_ARGUMENT',
        'Creating a work item requires a non-empty System.Title field.',
      );
    const result = (
      await this.client.request(
        [...witPath(resolved), 'workitems', `$${type}`],
        workItemSchema,
        {
          endpoint: 'phase2',
          method: 'POST',
          contentType: 'application/json-patch+json',
          body: patch,
          recovery,
        },
      )
    ).data;
    try {
      this.scope.verify(resolved, result.fields['System.TeamProject']);
    } catch {
      throw new SafeError(
        'WORK_ITEM_PROJECT_NOT_ALLOWED',
        `The write response is outside the selected work-item project; ${recovery}.`,
      );
    }
    return this.summarize(result, Object.keys(fields));
  }
  async update(
    project: string | undefined,
    id: number,
    revision: number,
    fields: FieldValues,
  ) {
    const resolved = await this.scope.resolve(project, true);
    const patch = this.fieldPatch(resolved, fields);
    const existing = await this.verified(resolved, id);
    this.requireRevision(existing, revision);
    return this.summarize(
      await this.patch(resolved, id, revision, patch),
      Object.keys(fields),
    );
  }
  private fieldPatch(project: Project, fields: FieldValues) {
    if (!Object.keys(fields).length)
      throw new SafeError('INVALID_ARGUMENT', 'Provide at least one field.');
    return Object.entries(fields).map(([name, value]) => {
      if (
        !/^[A-Za-z][A-Za-z0-9_.]{0,255}$/u.test(name) ||
        [
          'system.id',
          'system.rev',
          'system.teamproject',
          'system.workitemtype',
          'system.history',
          'system.createdby',
          'system.changedby',
          'system.createddate',
          'system.changeddate',
          'system.authorizedas',
          'system.authorizeddate',
        ].includes(name.toLowerCase())
      )
        throw new SafeError(
          'INVALID_ARGUMENT',
          'A field is protected or has an invalid reference name. Use comment and link tools for those changes.',
        );
      if (
        ['system.areapath', 'system.iterationpath'].includes(
          name.toLowerCase(),
        ) &&
        (typeof value !== 'string' ||
          !(
            value.toLowerCase() === project.name.toLowerCase() ||
            value.toLowerCase().startsWith(`${project.name.toLowerCase()}\\`)
          ))
      )
        throw new SafeError(
          'WORK_ITEM_PROJECT_NOT_ALLOWED',
          'Area and iteration paths must belong to the selected project.',
        );
      return { op: 'add', path: `/fields/${name}`, value };
    });
  }
  requireRevision(item: WorkItem, revision: number) {
    if (item.rev !== revision)
      throw new SafeError(
        'REVISION_CONFLICT',
        'The work item changed. Read its current fields/revision and review the intended update before retrying.',
      );
  }
  async patch(
    project: Project,
    id: number,
    revision: number,
    operations: { op: string; path: string; value: unknown }[],
  ) {
    const result = (
      await this.client.request(
        [...witPath(project), 'workitems', String(id)],
        workItemSchema,
        {
          endpoint: 'phase2',
          method: 'PATCH',
          contentType: 'application/json-patch+json',
          recovery,
          body: [{ op: 'test', path: '/rev', value: revision }, ...operations],
        },
      )
    ).data;
    try {
      this.verify(result, project, id);
    } catch {
      throw new SafeError(
        'WORK_ITEM_PROJECT_NOT_ALLOWED',
        `The write response did not match the selected work item/project; ${recovery}.`,
      );
    }
    return result;
  }
  async comments(
    project: string | undefined,
    id: number,
    top: number,
    continuationToken?: string,
  ) {
    const resolved = await this.scope.resolve(project);
    await this.verified(resolved, id);
    const result = (
      await this.client.request(
        [...witPath(resolved), 'workitems', String(id), 'comments'],
        z.object({
          comments: z.array(workItemCommentSchema),
          continuationToken: z.union([z.string(), z.number()]).optional(),
        }),
        {
          endpoint: 'workItemComments',
          query: { $top: top, continuationToken, order: 'asc' },
        },
      )
    ).data;
    if (
      result.comments.length > top ||
      result.comments.some((comment) => comment.workItemId !== id)
    )
      throw new SafeError(
        'INVALID_RESPONSE',
        'The comments response did not match the requested work item/page.',
      );
    return {
      items: result.comments.map((comment) => this.summarizeComment(comment)),
      ...(result.continuationToken !== undefined
        ? { continuationToken: String(result.continuationToken) }
        : {}),
    };
  }
  private summarizeComment(comment: z.infer<typeof workItemCommentSchema>) {
    return {
      id: comment.id,
      workItemId: comment.workItemId,
      version: comment.version,
      ...boundedText(comment.text),
      createdBy: comment.createdBy?.displayName?.slice(0, 256) ?? null,
      createdDate: comment.createdDate ?? null,
    };
  }
  async addComment(project: string | undefined, id: number, text: string) {
    const resolved = await this.scope.resolve(project, true);
    await this.verified(resolved, id);
    const comment = (
      await this.client.request(
        [...witPath(resolved), 'workitems', String(id), 'comments'],
        workItemCommentSchema,
        {
          endpoint: 'workItemComments',
          method: 'POST',
          body: { text },
          recovery,
        },
      )
    ).data;
    if (comment.workItemId !== id)
      throw new SafeError(
        'INVALID_RESPONSE',
        `The comment response did not match this work item; ${recovery}.`,
      );
    return this.summarizeComment(comment);
  }
}
