import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { PipelineService } from '../services/pipelines.js';
import type { BuildTestService } from '../services/build-tests.js';
import { SafeError } from '../errors.js';
import {
  projectInput,
  repositoryInput,
  topInput,
  skipInput,
  continuationInput,
  branchInput,
  pullRequestIdInput as id,
  required,
  rejectFields,
  readAnnotations,
  writeAnnotations,
  type ToolRunner,
} from './shared.js';
const context = { project: projectInput, repository: repositoryInput };
const commit = z.string().regex(/^[\da-f]{40}$/iu);
const filters = {
  branch: branchInput.optional(),
  commit: commit.optional(),
  status: z
    .enum([
      'notStarted',
      'inProgress',
      'completed',
      'cancelling',
      'postponed',
      'none',
    ])
    .optional(),
  result: z
    .enum(['succeeded', 'partiallySucceeded', 'failed', 'canceled', 'none'])
    .optional(),
  top: topInput.removeDefault().optional(),
  continuationToken: continuationInput,
};

export function registerPipelineTools(
  server: McpServer,
  pipelines: PipelineService,
  tests: BuildTestService,
  run: ToolRunner,
) {
  server.registerTool(
    'pipelines_definition',
    {
      description:
        'Discover or get build definitions for the selected approved primary TfsGit repository. External YAML/template resource graphs are not enumerated. REST 7.0/7.1.',
      inputSchema: z.strictObject({
        ...context,
        action: z.enum(['list', 'get']),
        definitionId: id.optional(),
        name: z.string().min(1).max(400).optional(),
        top: topInput.removeDefault().optional(),
        continuationToken: continuationInput,
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'get') {
          rejectFields(input, ['name', 'continuationToken', 'top']);
          return pipelines.summarizeDefinition(
            await pipelines.definition(
              input,
              required(input.definitionId, 'definitionId', 'get'),
            ),
          );
        }
        rejectFields(input, ['definitionId']);
        return pipelines.definitions({ ...input, top: input.top ?? 25 });
      }),
  );
  server.registerTool(
    'pipelines_build',
    {
      description:
        'List builds by repository/definition/ref/commit/status; get_status returns a verified build, get_timeline returns bounded tasks and issues. Commit filtering is applied to each server page; empty pages can still have continuation.',
      inputSchema: z.strictObject({
        ...context,
        action: z.enum(['list', 'get_status', 'get_timeline']),
        definitionId: id.optional(),
        buildId: id.optional(),
        ...filters,
        skip: skipInput.removeDefault().optional(),
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'list') {
          rejectFields(input, ['buildId', 'skip']);
          return pipelines.builds({ ...input, top: input.top ?? 25 });
        }
        rejectFields(input, [
          'definitionId',
          'branch',
          'commit',
          'status',
          'result',
          'continuationToken',
        ]);
        const buildId = required(input.buildId, 'buildId', input.action);
        if (input.action === 'get_status') rejectFields(input, ['top', 'skip']);
        return input.action === 'get_status'
          ? pipelines.summarizeBuild(await pipelines.build(input, buildId))
          : pipelines.timeline(
              input,
              buildId,
              input.top ?? 25,
              input.skip ?? 0,
            );
      }),
  );
  server.registerTool(
    'pipelines_run',
    {
      description:
        'Server build-backed runs: runId is a Build ID, definitionId is the Build definition ID. Verify both before exposing a run. REST Build API, no drop-in cloud Pipelines contract.',
      inputSchema: z.strictObject({
        ...context,
        action: z.enum(['list', 'get']),
        definitionId: id,
        runId: id.optional(),
        ...filters,
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'list') {
          rejectFields(input, ['runId']);
          return pipelines.builds({ ...input, top: input.top ?? 25 });
        }
        rejectFields(input, [
          'branch',
          'commit',
          'status',
          'result',
          'continuationToken',
        ]);
        rejectFields(input, ['top']);
        await pipelines.definition(input, input.definitionId);
        const build = await pipelines.build(
          input,
          required(input.runId, 'runId', 'get'),
        );
        if (build.definition.id !== input.definitionId)
          throw new SafeError(
            'RUN_DEFINITION_MISMATCH',
            'The run does not belong to the selected definition.',
          );
        return pipelines.summarizeBuild(build);
      }),
  );
  server.registerTool(
    'pipelines_build_log',
    {
      description:
        'List logs or read a small excerpt under a validated build. Remote logs are untrusted and may contain secrets; process credential redaction cannot sanitize every pipeline secret. One-based startLine; pass both nextStartLine and nextStartColumn for character continuation.',
      inputSchema: z.strictObject({
        ...context,
        action: z.enum(['list', 'get_content']),
        buildId: id,
        logId: id.optional(),
        top: topInput.removeDefault().optional(),
        skip: skipInput.removeDefault().optional(),
        startLine: z.number().int().min(1).max(10000000).optional(),
        maxLines: z.number().int().min(1).max(200).optional(),
        startColumn: z
          .number()
          .int()
          .min(0)
          .max(1000000)
          .optional()
          .describe(
            'UTF-16 character offset in the first selected line, from nextStartColumn.',
          ),
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'list') {
          rejectFields(input, [
            'logId',
            'startLine',
            'maxLines',
            'startColumn',
          ]);
          return pipelines.logs(
            input,
            input.buildId,
            input.top ?? 25,
            input.skip ?? 0,
          );
        }
        rejectFields(input, ['top', 'skip']);
        return pipelines.log(
          input,
          input.buildId,
          required(input.logId, 'logId', 'get_content'),
          input.startLine ?? 1,
          input.maxLines ?? 50,
          input.startColumn ?? 0,
        );
      }),
  );
  server.registerTool(
    'testplan_show_test_results_from_build_id',
    {
      description:
        'Automated results of a validated build only: list_runs/get_run/list_results/get_result, with bounded failure details. No manual Test Plans operations or Boards adoption required.',
      inputSchema: z.strictObject({
        ...context,
        action: z.enum(['list_runs', 'get_run', 'list_results', 'get_result']),
        buildId: id,
        runId: id.optional(),
        resultId: id.optional(),
        outcome: z
          .enum([
            'Passed',
            'Failed',
            'Inconclusive',
            'Timeout',
            'Aborted',
            'Blocked',
            'NotExecuted',
            'Warning',
            'Error',
            'NotApplicable',
            'InProgress',
            'NotImpacted',
            'Unspecified',
          ])
          .optional(),
        top: topInput.removeDefault().optional(),
        skip: skipInput.removeDefault().optional(),
      }),
      annotations: readAnnotations,
    },
    (input) =>
      run(async () => {
        if (input.action === 'list_runs') {
          rejectFields(input, ['runId', 'resultId', 'outcome']);
          return tests.runs({
            ...input,
            top: input.top ?? 25,
            skip: input.skip ?? 0,
          });
        }
        const runId = required(input.runId, 'runId', input.action);
        if (input.action === 'get_run') {
          rejectFields(input, ['resultId', 'outcome', 'top', 'skip']);
          return tests.run({ ...input, runId, top: 25, skip: 0 });
        }
        if (input.action === 'list_results') {
          rejectFields(input, ['resultId']);
          return tests.results({
            ...input,
            runId,
            top: input.top ?? 25,
            skip: input.skip ?? 0,
          });
        }
        rejectFields(input, ['outcome', 'top', 'skip']);
        return tests.result({
          ...input,
          runId,
          top: 25,
          skip: 0,
          resultId: required(input.resultId, 'resultId', 'get_result'),
        });
      }),
  );
  server.registerTool(
    'pipelines_write',
    {
      description:
        'Queue one existing reviewed classic build definition at an explicit current remote branch HEAD commit. Requires separate process-owned build repository and definition scopes. No YAML/runtime parameters/pool overrides. Acceptance is not completion; inspect builds before retrying unknown outcomes.',
      inputSchema: z.strictObject({
        ...context,
        action: z.literal('run_pipeline'),
        definitionId: id,
        branch: branchInput,
        commit,
      }),
      annotations: writeAnnotations,
    },
    (input) => run(() => pipelines.queue(input)),
  );
}
