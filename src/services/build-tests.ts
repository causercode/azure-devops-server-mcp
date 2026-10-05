import type { AdoClient } from '../ado/client.js';
import { listSchema } from '../ado/types.js';
import {
  testRunSchema,
  testRunReferenceSchema,
  testResultSchema,
} from '../ado/build-types.js';
import { SafeError } from '../errors.js';
import { PipelineService, type PipelineContext } from './pipelines.js';

type TestInput = PipelineContext & {
  buildId: number;
  runId?: number | undefined;
  resultId?: number | undefined;
  top: number;
  skip: number;
  outcome?: string | undefined;
};
export class BuildTestService {
  constructor(
    private readonly client: AdoClient,
    private readonly pipelines: PipelineService,
  ) {}
  private async context(input: TestInput) {
    const repo = await this.pipelines.repository(input);
    await this.pipelines.buildIn(repo, input.buildId);
    return repo;
  }
  private validRun(
    run: ReturnType<typeof testRunSchema.parse>,
    projectId: string,
    buildId: number,
  ) {
    return (
      run.project.id.toLowerCase() === projectId.toLowerCase() &&
      run.isAutomated &&
      Number(run.build.id) === buildId
    );
  }
  private summarizeRun(run: ReturnType<typeof testRunSchema.parse>) {
    return { ...run, name: run.name?.slice(0, 400) };
  }
  async runs(input: TestInput) {
    const repo = await this.context(input);
    const { data } = await this.client.request(
      [repo.project.id, '_apis', 'test', 'runs'],
      listSchema(testRunReferenceSchema),
      {
        query: {
          buildUri: `vstfs:///Build/Build/${input.buildId}`,
          isAutomated: true,
          $top: input.top,
          $skip: input.skip,
        },
      },
    );
    const items = [];
    for (const reference of data.value.slice(0, input.top)) {
      const { data: run } = await this.client.request(
        [repo.project.id, '_apis', 'test', 'runs', String(reference.id)],
        testRunSchema,
      );
      if (run.id !== reference.id)
        throw new SafeError(
          'TEST_RUN_NOT_ALLOWED',
          'The server returned a different test run ID.',
        );
      if (this.validRun(run, repo.project.id, input.buildId))
        items.push(this.summarizeRun(run));
    }
    return {
      items,
      ...(data.value.length >= input.top
        ? { nextSkip: input.skip + input.top }
        : {}),
    };
  }
  async run(input: TestInput & { runId: number }) {
    const repo = await this.context(input);
    const { data } = await this.client.request(
      [repo.project.id, '_apis', 'test', 'runs', String(input.runId)],
      testRunSchema,
    );
    if (
      data.id !== input.runId ||
      !this.validRun(data, repo.project.id, input.buildId)
    )
      throw new SafeError(
        'TEST_RUN_NOT_ALLOWED',
        'The run is not an automated test run of the validated build/project.',
      );
    return this.summarizeRun(data);
  }
  private summarizeResult(
    result: ReturnType<typeof testResultSchema.parse>,
    projectId: string,
    runId: number,
    details = true,
  ) {
    if (
      result.project.id.toLowerCase() !== projectId.toLowerCase() ||
      Number(result.testRun.id) !== runId
    )
      throw new SafeError(
        'TEST_RESULT_NOT_ALLOWED',
        'The server returned a test result outside the validated project/run.',
      );
    return {
      ...result,
      testCaseTitle: result.testCaseTitle?.slice(0, 400),
      automatedTestName: result.automatedTestName?.slice(0, 400),
      errorMessage: result.errorMessage?.slice(0, details ? 4000 : 500),
      stackTrace: details ? result.stackTrace?.slice(0, 4000) : undefined,
      errorMessageTruncated:
        (result.errorMessage?.length ?? 0) > (details ? 4000 : 500),
      stackTraceTruncated:
        (result.stackTrace?.length ?? 0) > (details ? 4000 : 0),
    };
  }
  async results(input: TestInput & { runId: number }) {
    const run = await this.run(input);
    const { data } = await this.client.request(
      [run.project.id, '_apis', 'test', 'runs', String(run.id), 'results'],
      listSchema(testResultSchema),
      {
        query: { $top: input.top, $skip: input.skip, outcomes: input.outcome },
      },
    );
    // Validate the entire upstream page before returning any part.
    const items = data.value.map((r) =>
      this.summarizeResult(r, run.project.id, run.id, false),
    );
    return {
      items: items
        .filter(
          (r) => input.outcome === undefined || r.outcome === input.outcome,
        )
        .slice(0, input.top),
      ...(data.value.length >= input.top
        ? { nextSkip: input.skip + input.top }
        : {}),
    };
  }
  async result(input: TestInput & { runId: number; resultId: number }) {
    const run = await this.run(input);
    const { data } = await this.client.request(
      [
        run.project.id,
        '_apis',
        'test',
        'runs',
        String(run.id),
        'results',
        String(input.resultId),
      ],
      testResultSchema,
    );
    if (data.id !== input.resultId)
      throw new SafeError(
        'TEST_RESULT_NOT_ALLOWED',
        'The server returned a different test result ID.',
      );
    return this.summarizeResult(data, run.project.id, run.id);
  }
}
