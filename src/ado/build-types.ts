import { z } from 'zod';
import { projectSchema } from './types.js';

const id = z.number().int().positive().max(2147483647);
const source = z.object({
  id: z.string().min(1),
  type: z.string(),
  name: z.string().optional(),
});
export const definitionSchema = z.object({
  id,
  name: z.string(),
  revision: z.number().int(),
  project: projectSchema,
  type: z.string(),
  queueStatus: z.string().optional(),
  repository: source,
  process: z
    .object({ type: z.number().int(), yamlFilename: z.string().optional() })
    .optional(),
});
export const buildSchema = z.object({
  id,
  project: projectSchema,
  repository: source,
  definition: z.object({
    id,
    name: z.string().optional(),
    revision: z.number().int().positive().optional(),
  }),
  buildNumber: z.string().optional(),
  status: z.string(),
  result: z.string().nullish(),
  sourceBranch: z.string(),
  sourceVersion: z.string(),
  queueTime: z.string().optional(),
  startTime: z.string().nullish(),
  finishTime: z.string().nullish(),
});
export const logSchema = z.object({
  id,
  lineCount: z.number().int().nonnegative().optional(),
  createdOn: z.string().optional(),
  lastChangedOn: z.string().optional(),
});
export const timelineSchema = z.object({
  records: z.array(
    z.object({
      id: z.string(),
      parentId: z.string().nullish(),
      name: z.string().optional(),
      type: z.string().optional(),
      state: z.string().optional(),
      result: z.string().nullish(),
      startTime: z.string().nullish(),
      finishTime: z.string().nullish(),
      errorCount: z.number().optional(),
      warningCount: z.number().optional(),
      log: z.object({ id }).nullish(),
      issues: z
        .array(z.object({ type: z.string(), message: z.string() }))
        .optional(),
    }),
  ),
});
export const testRunSchema = z.object({
  id,
  name: z.string().optional(),
  project: projectSchema,
  isAutomated: z.boolean(),
  build: z.object({ id: z.union([id, z.string().regex(/^\d+$/u)]) }),
  state: z.string().optional(),
  totalTests: z.number().optional(),
  passedTests: z.number().optional(),
  unanalyzedTests: z.number().optional(),
  incompleteTests: z.number().optional(),
  startedDate: z.string().optional(),
  completedDate: z.string().optional(),
});
// Server list responses can omit project/build linkage; resolve every ID before exposure.
export const testRunReferenceSchema = z.object({ id });
export const testResultSchema = z.object({
  id,
  project: z.object({ id: z.string(), name: z.string().optional() }),
  testRun: z.object({ id: z.union([id, z.string().regex(/^\d+$/u)]) }),
  testCaseTitle: z.string().optional(),
  automatedTestName: z.string().optional(),
  outcome: z.string(),
  state: z.string().optional(),
  durationInMs: z.number().optional(),
  errorMessage: z.string().nullish(),
  stackTrace: z.string().nullish(),
});
export type Definition = z.infer<typeof definitionSchema>;
export type Build = z.infer<typeof buildSchema>;
export const yamlRunSchema = z.object({
  id,
  pipeline: z.object({ id }),
  resources: z.object({
    pipelines: z.record(z.string(), z.unknown()).optional(),
    repositories: z.record(
      z.string(),
      z.object({
        repository: z.object({ id: z.string(), type: z.string() }),
        refName: z.string(),
        version: z.string(),
      }),
    ),
  }),
});
