import type { Config } from '../config.js';
import type { AdoClient } from '../ado/client.js';
import { SafeError } from '../errors.js';
import type { RepositoryService } from './repositories.js';
import {
  listSchema,
  projectSchema,
  type Page,
  type Project,
} from '../ado/types.js';

export class ServerInfoService {
  constructor(
    private readonly client: AdoClient,
    private readonly config: Pick<
      Config,
      'serverUrl' | 'collection' | 'project' | 'apiVersion' | 'authType'
    >,
    private readonly repositories: RepositoryService,
  ) {}

  async get() {
    const response = this.repositories.restricted
      ? await this.repositories.allowedInventory()
      : await this.client.request(
          ['_apis', 'projects'],
          listSchema(projectSchema),
          { query: { $top: 1 } },
        );
    if (
      this.repositories.restricted &&
      Array.isArray(response.data) &&
      response.data.length === 0
    ) {
      throw new SafeError(
        'REPOSITORY_NOT_ALLOWED',
        'No enabled repositories are allowed. Connectivity diagnostics require at least one allowed repository.',
      );
    }
    return {
      connected: true,
      serverUrl: this.config.serverUrl,
      collection: this.config.collection,
      defaultProject: this.config.project ?? null,
      authType: this.config.authType,
      apiVersion: this.config.apiVersion,
      repositoryAccess: this.repositories.restricted
        ? 'allowlist'
        : 'unrestricted',
      pullRequestWritesEnabled: this.repositories.restricted,
      reportedProductVersion: response.productVersion ?? null,
      versionNote:
        'API version is configured, not auto-detected. Product version is reported only when the server supplies x-tfs-product-version.',
    };
  }

  async listProjects(
    top: number,
    continuationToken?: string,
  ): Promise<Page<Project>> {
    if (this.repositories.restricted) {
      if (
        continuationToken !== undefined &&
        !/^\d+$/u.test(continuationToken)
      ) {
        throw new SafeError(
          'INVALID_ARGUMENT',
          'Invalid project continuation token.',
        );
      }
      const offset = Number(continuationToken ?? 0);
      if (!Number.isSafeInteger(offset) || offset > 1000000) {
        throw new SafeError(
          'INVALID_ARGUMENT',
          'Invalid project continuation token.',
        );
      }
      const { data } = await this.repositories.allowedInventory();
      const projects = [
        ...new Map(
          data.map((repo) => [repo.project.id.toLowerCase(), repo.project]),
        ).values(),
      ];
      return {
        items: projects.slice(offset, offset + top),
        ...(offset + top < projects.length
          ? { continuationToken: String(offset + top) }
          : {}),
      };
    }
    const response = await this.client.request(
      ['_apis', 'projects'],
      listSchema(projectSchema),
      { query: { $top: top, continuationToken } },
    );
    return {
      items: response.data.value,
      ...(response.continuationToken
        ? { continuationToken: response.continuationToken }
        : {}),
    };
  }
}
