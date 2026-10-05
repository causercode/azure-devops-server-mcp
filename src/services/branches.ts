import type { AdoClient } from '../ado/client.js';
import {
  listSchema,
  refSchema,
  type GitRef,
  type Page,
  type Repository,
} from '../ado/types.js';
import { SafeError } from '../errors.js';
import { repositoryPath, type RepositoryService } from './repositories.js';

export function normalizeBranch(branch: string): string {
  const name = branch.startsWith('refs/heads/') ? branch.slice(11) : branch;
  if (
    !name ||
    (branch.startsWith('refs/') && !branch.startsWith('refs/heads/')) ||
    name.startsWith('-') ||
    name.endsWith('.') ||
    /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(name) ||
    name.includes('..') ||
    name.includes('@{') ||
    name
      .split('/')
      .some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  ) {
    throw new SafeError(
      'INVALID_BRANCH',
      'Provide a valid Git branch name or refs/heads/... ref. Tags and remote refs are not supported.',
    );
  }
  return `refs/heads/${name}`;
}

export class BranchService {
  constructor(
    private readonly client: AdoClient,
    private readonly repositories: RepositoryService,
  ) {}

  async list(
    project: string | undefined,
    repository: string,
    top: number,
    prefix = '',
    continuationToken?: string,
  ): Promise<Page<GitRef>> {
    const resolved = await this.repositories.get(project, repository);
    if (prefix.startsWith('refs/') && !prefix.startsWith('refs/heads/')) {
      throw new SafeError(
        'INVALID_BRANCH',
        'Branch prefixes must refer to refs/heads/.',
      );
    }
    const result = await this.client.request(
      [...repositoryPath(resolved), 'refs'],
      listSchema(refSchema),
      {
        query: {
          filter: `heads/${prefix.replace(/^refs\/heads\//u, '')}`,
          $top: top,
          continuationToken,
        },
      },
    );
    return {
      items: result.data.value.filter((ref) =>
        ref.name.startsWith('refs/heads/'),
      ),
      ...(result.continuationToken
        ? { continuationToken: result.continuationToken }
        : {}),
    };
  }

  async get(
    project: string | undefined,
    repository: string,
    branch: string,
  ): Promise<GitRef> {
    const refName = normalizeBranch(branch);
    return this.getInRepository(
      await this.repositories.get(project, repository),
      refName,
    );
  }

  async getInRepository(
    repository: Repository,
    branch: string,
  ): Promise<GitRef> {
    const refName = normalizeBranch(branch);
    let continuationToken: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const result = await this.client.request(
        [...repositoryPath(repository), 'refs'],
        listSchema(refSchema),
        { query: { filter: refName.slice(5), $top: 1000, continuationToken } },
      );
      // ADO's filter is a prefix match. feature/foo must never resolve to feature/foobar.
      const ref = result.data.value.find((item) => item.name === refName);
      if (ref && !/^0+$/u.test(ref.objectId)) return ref;
      continuationToken = result.continuationToken;
      if (!continuationToken)
        throw new SafeError(
          'BRANCH_NOT_FOUND',
          'Branch not found in the remote repository. Check its spelling and push the branch before creating a pull request.',
        );
      if (seen.has(continuationToken)) break;
      seen.add(continuationToken);
    }
    throw new SafeError(
      'PAGINATION_ERROR',
      'Branch lookup exceeded its pagination limit or received a repeated continuation token. Narrow the branch name and try again.',
    );
  }
}

export function summarizeBranch(ref: GitRef) {
  return {
    name: ref.name.replace(/^refs\/heads\//u, ''),
    refName: ref.name,
    commitId: ref.objectId,
    isLocked: ref.isLocked ?? false,
  };
}
