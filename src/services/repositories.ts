import type { Config } from '../config.js';
import { SafeError } from '../errors.js';
import type { AdoClient, AdoResponse } from '../ado/client.js';
import {
  listSchema,
  repositorySchema,
  type Repository,
  type Page,
} from '../ado/types.js';

export class RepositoryService {
  private readonly allowlist;

  constructor(
    private readonly client: AdoClient,
    private readonly config: Pick<Config, 'project' | 'allowedRepositories'>,
  ) {
    this.allowlist = config.allowedRepositories?.map((entry) => ({ ...entry }));
  }

  get restricted(): boolean {
    return this.allowlist !== undefined;
  }

  requireWriteAccess(): void {
    if (!this.restricted) {
      throw new SafeError(
        'REPOSITORY_SCOPE_REQUIRED',
        'PR writes require ADO_ALLOWED_REPOSITORIES in the MCP process configuration. No repositories are approved for writes by default.',
      );
    }
  }

  /** Resolve only process-configured entries; never enumerate a shared project. */
  async allowedInventory(): Promise<AdoResponse<Repository[]>> {
    const items = new Map<string, Repository>();
    let productVersion: string | undefined;
    for (const entry of this.allowlist ?? []) {
      const response = await this.client.request(
        [entry.project, '_apis', 'git', 'repositories', entry.repository],
        repositorySchema,
      );
      if (
        !matchesIdentifier(entry.project, response.data.project) ||
        !matchesIdentifier(entry.repository, response.data)
      ) {
        throw new SafeError(
          'REPOSITORY_NOT_ALLOWED',
          'The server returned a repository outside the configured allowlist.',
        );
      }
      productVersion ??= response.productVersion;
      if (!response.data.isDisabled) {
        items.set(
          `${response.data.project.id.toLowerCase()}/${response.data.id.toLowerCase()}`,
          response.data,
        );
      }
    }
    return {
      data: [...items.values()],
      ...(productVersion ? { productVersion } : {}),
    };
  }

  project(project?: string): string {
    const value = project?.trim() || this.config.project;
    if (!value) {
      throw new SafeError(
        'PROJECT_REQUIRED',
        'Provide project or configure ADO_PROJECT. Use server_info with action list_projects to discover accessible projects.',
      );
    }
    return value;
  }

  async get(
    project: string | undefined,
    repository: string,
  ): Promise<Repository> {
    const selectedProject = this.project(project);
    if (this.restricted) {
      const { data } = await this.allowedInventory();
      const result = data.find(
        (item) =>
          matchesIdentifier(selectedProject, item.project) &&
          matchesIdentifier(repository, item),
      );
      if (!result) throw notAllowed();
      return result;
    }
    const result = await this.client.request(
      [selectedProject, '_apis', 'git', 'repositories', repository],
      repositorySchema,
    );
    if (result.data.isDisabled)
      throw new SafeError(
        'REPOSITORY_DISABLED',
        'This repository is disabled.',
      );
    return result.data;
  }

  async list(
    project: string | undefined,
    top: number,
    skip: number,
  ): Promise<Page<Repository>> {
    const selectedProject = this.project(project);
    if (this.restricted) {
      const { data } = await this.allowedInventory();
      const repositories = data.filter((item) =>
        matchesIdentifier(selectedProject, item.project),
      );
      if (!repositories.length) throw notAllowed();
      return page(repositories, top, skip);
    }
    // The repositories endpoint has no documented $top/$skip parameters.
    const result = await this.client.request(
      [selectedProject, '_apis', 'git', 'repositories'],
      listSchema(repositorySchema),
    );
    return page(result.data.value, top, skip);
  }
}

export function matchesIdentifier(
  selector: string,
  value: { id: string; name: string },
): boolean {
  // GUID selectors pin identity rather than matching an identically named repository.
  const field = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(selector)
    ? value.id
    : value.name;
  return selector.toLowerCase() === field.toLowerCase();
}

function notAllowed(): SafeError {
  return new SafeError(
    'REPOSITORY_NOT_ALLOWED',
    'This project/repository is outside ADO_ALLOWED_REPOSITORIES. Change the MCP process configuration to grant access.',
  );
}

function page(
  items: Repository[],
  top: number,
  skip: number,
): Page<Repository> {
  return {
    items: items.slice(skip, skip + top),
    ...(skip + top < items.length ? { nextSkip: skip + top } : {}),
  };
}

export function repositoryPath(repository: Repository): string[] {
  return [repository.project.id, '_apis', 'git', 'repositories', repository.id];
}

export function summarizeRepository(repository: Repository) {
  return {
    id: repository.id,
    name: repository.name,
    project: { id: repository.project.id, name: repository.project.name },
    defaultBranch:
      repository.defaultBranch?.replace(/^refs\/heads\//u, '') ?? null,
    remoteUrl: repository.remoteUrl ?? null,
    webUrl: repository.webUrl ?? null,
    isDisabled: repository.isDisabled ?? false,
  };
}
