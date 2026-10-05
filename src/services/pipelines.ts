import type { AdoClient } from '../ado/client.js';
import type { Config } from '../config.js';
import { listSchema, type Repository } from '../ado/types.js';
import {
  buildSchema,
  definitionSchema,
  logSchema,
  timelineSchema,
  yamlRunSchema,
  type Build,
  type Definition,
} from '../ado/build-types.js';
import { SafeError } from '../errors.js';
import { BranchService, normalizeBranch } from './branches.js';
import { matchesIdentifier, type RepositoryService } from './repositories.js';
import { endpointVersion } from '../ado/api-version.js';
import { page, boundedText } from './bounds.js';

export interface PipelineContext {
  project?: string | undefined;
  repository: string;
}
export interface BuildFilters extends PipelineContext {
  definitionId?: number | undefined;
  branch?: string | undefined;
  commit?: string | undefined;
  status?: string | undefined;
  result?: string | undefined;
  top: number;
  continuationToken?: string | undefined;
}
export function buildPath(repo: Repository): string[] {
  return [repo.project.id, '_apis', 'build'];
}
function denied(): SafeError {
  return new SafeError(
    'BUILD_NOT_ALLOWED',
    'The build or definition is outside the selected project/repository or has an unsupported source.',
  );
}
function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export class PipelineService {
  constructor(
    private readonly client: AdoClient,
    private readonly repositories: RepositoryService,
    private readonly branches: BranchService,
    private readonly config: Pick<
      Config,
      'apiVersion' | 'buildWriteRepositories' | 'buildWriteDefinitions'
    >,
  ) {}

  async repository(context: PipelineContext): Promise<Repository> {
    if (!endpointVersion(this.config.apiVersion, 'phase3'))
      throw new SafeError(
        'UNSUPPORTED_API_VERSION',
        'Pipeline and automated test tools require configured REST 7.0 or 7.1.',
      );
    return this.repositories.get(context.project, context.repository);
  }
  matches(resource: Build | Definition, repo: Repository): boolean {
    return (
      same(resource.project.id, repo.project.id) &&
      same(resource.repository.id, repo.id) &&
      resource.repository.type === 'TfsGit'
    );
  }
  async definitionIn(
    repo: Repository,
    id: number,
    revision?: number,
  ): Promise<Definition> {
    const { data } = await this.client.request(
      [...buildPath(repo), 'definitions', String(id)],
      definitionSchema,
      { query: { revision } },
    );
    if (data.id !== id || !this.matches(data, repo) || data.type !== 'build')
      throw denied();
    return data;
  }
  private async validateBuildSource(
    build: Build,
    repo: Repository,
  ): Promise<void> {
    const definition = await this.definitionIn(
      repo,
      build.definition.id,
      build.definition.revision,
    );
    if (
      build.definition.revision !== undefined &&
      definition.revision !== build.definition.revision
    )
      throw denied();
    if (definition.process?.type === 1) return;
    if (definition.process?.type !== 2) throw denied();
    // YAML may include other repositories even though Build.repository shows only self.
    const { data: run } = await this.client.request(
      [
        repo.project.id,
        '_apis',
        'pipelines',
        String(definition.id),
        'runs',
        String(build.id),
      ],
      yamlRunSchema,
    );
    const sources = Object.entries(run.resources.repositories);
    const self = run.resources.repositories.self;
    if (
      run.id !== build.id ||
      run.pipeline.id !== definition.id ||
      Object.keys(run.resources.pipelines ?? {}).length !== 0 ||
      sources.length !== 1 ||
      !self ||
      self.repository.type !== 'azureReposGit' ||
      !same(self.repository.id, repo.id) ||
      self.refName !== build.sourceBranch ||
      !same(self.version, build.sourceVersion)
    )
      throw new SafeError(
        'BUILD_SOURCE_UNSUPPORTED',
        'YAML diagnostics require a verified single self repository matching the build. Multiple or unknown repository resources are not supported.',
      );
  }
  async definition(context: PipelineContext, id: number) {
    return this.definitionIn(await this.repository(context), id);
  }
  summarizeDefinition(value: Definition) {
    return {
      id: value.id,
      name: value.name.slice(0, 400),
      revision: value.revision,
      type: value.type,
      queueStatus: value.queueStatus ?? null,
      sourceAssociation:
        'primary TfsGit repository; external YAML/template resources are not enumerated',
      processType: value.process?.type ?? null,
      yamlPath: value.process?.yamlFilename?.slice(0, 1024) ?? null,
    };
  }
  async definitions(
    input: PipelineContext & {
      top: number;
      continuationToken?: string | undefined;
      name?: string | undefined;
    },
  ) {
    const repo = await this.repository(input);
    const response = await this.client.request(
      [...buildPath(repo), 'definitions'],
      listSchema(definitionSchema),
      {
        query: {
          repositoryId: repo.id,
          repositoryType: 'TfsGit',
          includeAllProperties: true,
          name: input.name,
          $top: input.top,
          continuationToken: input.continuationToken,
        },
      },
    );
    return {
      items: response.data.value
        .filter((item) => this.matches(item, repo) && item.type === 'build')
        .slice(0, input.top)
        .map((item) => this.summarizeDefinition(item)),
      ...(response.continuationToken
        ? { continuationToken: response.continuationToken }
        : {}),
    };
  }
  async buildIn(repo: Repository, id: number): Promise<Build> {
    const { data } = await this.client.request(
      [...buildPath(repo), 'builds', String(id)],
      buildSchema,
    );
    if (data.id !== id || !this.matches(data, repo)) throw denied();
    await this.validateBuildSource(data, repo);
    return data;
  }
  async build(context: PipelineContext, id: number) {
    return this.buildIn(await this.repository(context), id);
  }
  summarizeBuild(build: Build) {
    return {
      ...build,
      repository: { id: build.repository.id, type: build.repository.type },
      project: { id: build.project.id, name: build.project.name.slice(0, 400) },
      status: build.status.slice(0, 64),
      result: build.result?.slice(0, 64),
      sourceBranch: build.sourceBranch.slice(0, 1024),
      sourceVersion: build.sourceVersion.slice(0, 256),
      buildNumber: build.buildNumber?.slice(0, 400),
      definition: {
        id: build.definition.id,
        name: build.definition.name?.slice(0, 400),
      },
    };
  }
  async builds(input: BuildFilters) {
    const repo = await this.repository(input);
    if (input.definitionId !== undefined)
      await this.definitionIn(repo, input.definitionId);
    const branch =
      input.branch === undefined ? undefined : normalizeBranch(input.branch);
    const response = await this.client.request(
      [...buildPath(repo), 'builds'],
      listSchema(buildSchema),
      {
        query: {
          repositoryId: repo.id,
          repositoryType: 'TfsGit',
          definitions: input.definitionId,
          branchName: branch,
          statusFilter: input.status,
          resultFilter: input.result,
          $top: input.top,
          continuationToken: input.continuationToken,
          queryOrder: 'queueTimeDescending',
        },
      },
    );
    const candidates = response.data.value
      .filter(
        (b) =>
          this.matches(b, repo) &&
          (input.definitionId === undefined ||
            b.definition.id === input.definitionId) &&
          (branch === undefined || b.sourceBranch === branch) &&
          (input.commit === undefined || same(b.sourceVersion, input.commit)) &&
          (input.status === undefined || b.status === input.status) &&
          (input.result === undefined || b.result === input.result),
      )
      .slice(0, input.top);
    for (const candidate of candidates)
      await this.validateBuildSource(candidate, repo);
    return {
      items: candidates.map((b) => this.summarizeBuild(b)),
      ...(response.continuationToken
        ? { continuationToken: response.continuationToken }
        : {}),
    };
  }
  async timeline(
    context: PipelineContext,
    buildId: number,
    top: number,
    skip: number,
  ) {
    const repo = await this.repository(context);
    await this.buildIn(repo, buildId);
    const { data } = await this.client.request(
      [...buildPath(repo), 'builds', String(buildId), 'timeline'],
      timelineSchema,
    );
    const selected = page(data.records, top, skip);
    let issueCharacters = 16000;
    let issueCount = 40;
    return {
      ...selected,
      items: selected.items.map((r) => {
        const issues = [];
        for (const issue of (r.issues ?? []).slice(0, 20)) {
          if (issueCount === 0 || issueCharacters === 0) break;
          const message = boundedText(
            issue.message,
            Math.min(2000, issueCharacters),
          );
          issues.push({
            type: issue.type.slice(0, 64),
            message: message.text,
            truncated: message.truncated,
          });
          issueCharacters -= message.text.length;
          issueCount--;
        }
        return {
          ...r,
          name: r.name?.slice(0, 400),
          issues,
          issuesTruncated: (r.issues?.length ?? 0) > issues.length,
        };
      }),
    };
  }
  async logs(
    context: PipelineContext,
    buildId: number,
    top: number,
    skip: number,
  ) {
    const repo = await this.repository(context);
    await this.buildIn(repo, buildId);
    const { data } = await this.client.request(
      [...buildPath(repo), 'builds', String(buildId), 'logs'],
      listSchema(logSchema),
    );
    return page(data.value, top, skip);
  }
  async log(
    context: PipelineContext,
    buildId: number,
    logId: number,
    startLine: number,
    maxLines: number,
    startColumn = 0,
  ) {
    const repo = await this.repository(context);
    await this.buildIn(repo, buildId);
    const { data: logs } = await this.client.request(
      [...buildPath(repo), 'builds', String(buildId), 'logs'],
      listSchema(logSchema),
    );
    const metadata = logs.value.find((l) => l.id === logId);
    if (!metadata)
      throw new SafeError(
        'LOG_NOT_FOUND',
        'Log ID is not present in the validated build.',
      );
    const { data } = await this.client.requestText(
      [...buildPath(repo), 'builds', String(buildId), 'logs', String(logId)],
      {
        query: { startLine: startLine - 1, endLine: startLine + maxLines - 2 },
        maxBytes: 65536,
      },
    );
    const lines = data.replace(/\r\n/gu, '\n').replace(/\n$/u, '').split('\n');
    const selected = data.length === 0 ? [] : lines.slice(0, maxLines);
    if (selected.length && startColumn > selected[0]!.length)
      throw new SafeError(
        'INVALID_ARGUMENT',
        'startColumn exceeds the first selected line length.',
      );
    if (selected.length) selected[0] = selected[0]!.slice(startColumn);
    const content = selected.join('\n').slice(0, 16000);
    const characterTruncated = selected.join('\n').length > 16000;
    // Continue within a partially exposed line without skipping text or looping.
    const lineCount = characterTruncated
      ? content.split('\n').length - 1
      : selected.length;
    const more =
      characterTruncated ||
      lines.length > maxLines ||
      (metadata.lineCount === undefined
        ? selected.length === maxLines
        : startLine - 1 + selected.length < metadata.lineCount);
    return {
      buildId,
      logId,
      startLine,
      content,
      lineCount,
      truncated: more,
      characterTruncated,
      ...(more && selected.length
        ? {
            nextStartLine: startLine + lineCount,
            nextStartColumn: characterTruncated
              ? lineCount === 0
                ? startColumn + content.length
                : content.split('\n').at(-1)!.length
              : 0,
          }
        : {}),
    };
  }
  async queue(
    input: PipelineContext & {
      definitionId: number;
      branch: string;
      commit: string;
    },
  ) {
    const entries = this.config.buildWriteRepositories ?? [];
    if (
      !this.repositories.restricted ||
      entries.length === 0 ||
      !(this.config.buildWriteDefinitions ?? []).includes(input.definitionId)
    )
      throw new SafeError(
        'BUILD_WRITE_SCOPE_REQUIRED',
        'Queueing requires ADO_ALLOWED_REPOSITORIES, ADO_BUILD_WRITE_REPOSITORIES and ADO_BUILD_WRITE_DEFINITIONS in process configuration.',
      );
    const repo = await this.repository(input);
    if (
      !entries.some(
        (e) =>
          matchesIdentifier(e.project, repo.project) &&
          matchesIdentifier(e.repository, repo),
      )
    )
      throw new SafeError(
        'BUILD_WRITE_NOT_ALLOWED',
        'The selected repository is not approved for build execution.',
      );
    const definition = await this.definitionIn(repo, input.definitionId);
    if (definition.queueStatus !== 'enabled' || definition.process?.type !== 1)
      throw new SafeError(
        'UNSUPPORTED_PIPELINE_QUEUE',
        'Only enabled, explicitly reviewed classic build definitions are queueable. YAML and unknown execution processes are not supported.',
      );
    const branch = normalizeBranch(input.branch);
    const ref = await this.branches.getInRepository(repo, branch);
    if (!same(ref.objectId, input.commit))
      throw new SafeError(
        'COMMIT_MISMATCH',
        'The explicit commit must match the current remote branch HEAD. Refresh branch context before queueing.',
      );
    const response = await this.client.request(
      [...buildPath(repo), 'builds'],
      buildSchema,
      {
        method: 'POST',
        body: {
          definition: { id: definition.id, revision: definition.revision },
          sourceBranch: branch,
          sourceVersion: input.commit,
        },
        recovery:
          'inspect builds for this definition and commit before retrying',
      },
    );
    const build = response.data;
    if (
      !this.matches(build, repo) ||
      build.definition.id !== definition.id ||
      build.definition.revision !== definition.revision ||
      build.sourceBranch !== branch ||
      !same(build.sourceVersion, input.commit)
    )
      throw new SafeError(
        'QUEUE_VERIFICATION_FAILED',
        'The queue response could not be verified. Inspect builds for this definition and commit before retrying; do not blindly queue again.',
      );
    return {
      queueAccepted: true,
      completionVerified: false,
      build: this.summarizeBuild(build),
    };
  }
}
