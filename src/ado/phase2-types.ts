import { z } from 'zod';

export const identityRefSchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  uniqueName: z.string().optional(),
  isContainer: z.boolean().optional(),
  vote: z.number().optional(),
  isRequired: z.boolean().optional(),
});
export const identitySchema = z.object({
  id: z.string(),
  providerDisplayName: z.string().optional(),
  customDisplayName: z.string().nullish(),
  isActive: z.boolean(),
  isContainer: z.boolean().optional(),
  properties: z
    .record(z.string(), z.object({ $value: z.unknown() }))
    .optional(),
});
export const commentSchema = z.object({
  id: z.number().int(),
  parentCommentId: z.number().int().optional(),
  content: z.string().nullish(),
  commentType: z.union([z.string(), z.number()]).optional(),
  author: identityRefSchema.optional(),
  publishedDate: z.string().optional(),
  isDeleted: z.boolean().optional(),
});
export const threadSchema = z.object({
  id: z.number().int(),
  status: z.union([z.string(), z.number()]).optional(),
  comments: z.array(commentSchema).optional(),
  isDeleted: z.boolean().optional(),
});
export const relationSchema = z.object({
  rel: z.string(),
  url: z.string(),
  attributes: z.object({ name: z.string().optional() }).optional(),
});
export const workItemSchema = z.object({
  id: z.number().int().positive(),
  rev: z.number().int().positive(),
  fields: z.record(z.string(), z.unknown()),
  relations: z.array(relationSchema).optional(),
});
export const workItemCommentSchema = z.object({
  id: z.number().int(),
  workItemId: z.number().int(),
  text: z.string(),
  version: z.number().optional(),
  createdBy: identityRefSchema.optional(),
  createdDate: z.string().optional(),
});
export const fieldSchema = z.object({
  name: z.string(),
  referenceName: z.string(),
  type: z.string().optional(),
  readOnly: z.boolean().optional(),
  alwaysRequired: z.boolean().optional(),
});
export const typeSchema = z.object({
  name: z.string(),
  referenceName: z.string().optional(),
  description: z.string().optional(),
});
export const savedQuerySchema = z.object({
  id: z.string(),
  name: z.string(),
  isFolder: z.boolean().optional(),
  queryType: z.string().optional(),
  wiql: z.string().optional(),
  children: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        isFolder: z.boolean().optional(),
        queryType: z.string().optional(),
      }),
    )
    .optional(),
});
export const queryResultSchema = z.object({
  queryType: z.string(),
  asOf: z.string().optional(),
  workItems: z.array(z.object({ id: z.number().int().positive() })).optional(),
});
export const commitSchema = z.object({
  commitId: z.string().regex(/^[a-f\d]{40}$/iu),
});
export const iterationSchema = z.object({
  id: z.number().int().positive(),
  sourceRefCommit: commitSchema,
  targetRefCommit: commitSchema,
  commonRefCommit: commitSchema.optional(),
});
export const changesSchema = z.object({
  changeEntries: z.array(
    z.object({
      changeId: z.number().int().optional(),
      changeTrackingId: z.number().int().optional(),
      changeType: z.union([z.string(), z.number()]),
      originalPath: z.string().optional(),
      item: z.object({
        path: z.string(),
        objectId: z.string().optional(),
        originalObjectId: z.string().optional(),
        gitObjectType: z.string().optional(),
      }),
    }),
  ),
  nextSkip: z.number().int().nonnegative().optional(),
  nextTop: z.number().int().nonnegative().optional(),
});
export type WorkItem = z.infer<typeof workItemSchema>;
export type Thread = z.infer<typeof threadSchema>;
