import { z } from 'zod';

// Schemas deliberately strip unrelated upstream fields before they reach an agent.
export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  state: z.string().optional(),
});

export const repositorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  project: projectSchema,
  defaultBranch: z.string().nullish(),
  remoteUrl: z.string().nullish(),
  webUrl: z.string().nullish(),
  isDisabled: z.boolean().optional(),
});

export const refSchema = z.object({
  name: z.string().min(1),
  objectId: z.string().min(1),
  isLocked: z.boolean().optional(),
});

export const pullRequestSchema = z.object({
  pullRequestId: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable().optional(),
  status: z.enum(['active', 'abandoned', 'completed', 'notSet']),
  isDraft: z.boolean().optional(),
  sourceRefName: z.string(),
  targetRefName: z.string(),
  repository: repositorySchema,
  creationDate: z.string().optional(),
  createdBy: z.object({ displayName: z.string().optional() }).optional(),
});

export function listSchema<T extends z.ZodType>(item: T) {
  return z.object({ value: z.array(item) });
}

export type Project = z.infer<typeof projectSchema>;
export type Repository = z.infer<typeof repositorySchema>;
export type GitRef = z.infer<typeof refSchema>;
export type PullRequest = z.infer<typeof pullRequestSchema>;

export interface Page<T> {
  items: T[];
  continuationToken?: string;
  nextSkip?: number;
}
