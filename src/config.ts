import {
  API_VERSIONS,
  isApiVersion,
  type ApiVersion,
} from './ado/api-version.js';
import { SafeError } from './errors.js';
import { z } from 'zod';

const scopeIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !/[\\/\u0000-\u001f*?]/u.test(value) && !['.', '..'].includes(value),
  );
const repositoryAllowlistSchema = z
  .array(
    z.strictObject({
      project: scopeIdentifier,
      repository: scopeIdentifier,
    }),
  )
  .max(100);

export type AllowedRepository = z.infer<
  typeof repositoryAllowlistSchema
>[number];

export interface Config {
  serverUrl: string;
  collection: string;
  project?: string;
  allowedRepositories?: readonly AllowedRepository[];
  allowedWorkItemProjects?: readonly string[];
  workItemWriteProjects?: readonly string[];
  authType: 'pat';
  token: string;
  apiVersion: ApiVersion;
  timeoutMs: number;
}

function fail(message: string): never {
  throw new SafeError('CONFIGURATION_ERROR', message);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = env.ADO_SERVER_URL?.trim();
  if (!rawUrl) fail('ADO_SERVER_URL is required.');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    fail('ADO_SERVER_URL must be an absolute HTTP or HTTPS URL.');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail(
      'ADO_SERVER_URL must use HTTP(S), without credentials, query, or fragment.',
    );
  }
  const collection = env.ADO_COLLECTION?.trim();
  if (
    !collection ||
    /[\\/\u0000-\u001f]/u.test(collection) ||
    ['.', '..'].includes(collection)
  ) {
    fail('ADO_COLLECTION is required and must be a single collection name.');
  }
  const authType = env.ADO_AUTH_TYPE?.trim() || 'pat';
  if (authType !== 'pat') fail('ADO_AUTH_TYPE must be pat.');
  const token = env.ADO_TOKEN?.trim();
  if (!token || /[\u0000-\u0020\u007f]/u.test(token)) {
    fail(
      'ADO_TOKEN is required and must not contain whitespace or control characters.',
    );
  }
  const apiVersion = env.ADO_API_VERSION?.trim() || API_VERSIONS['2022'];
  if (!isApiVersion(apiVersion))
    fail('ADO_API_VERSION must be 7.0, 7.1, 6.0, or 5.0.');
  const rawTimeout = env.ADO_TIMEOUT_MS?.trim() || '30000';
  const timeoutMs = Number(rawTimeout);
  if (
    !/^\d+$/u.test(rawTimeout) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 120000
  ) {
    fail('ADO_TIMEOUT_MS must be an integer between 100 and 120000.');
  }
  const project = env.ADO_PROJECT?.trim();
  let allowedRepositories: AllowedRepository[] | undefined;
  if (env.ADO_ALLOWED_REPOSITORIES !== undefined) {
    try {
      allowedRepositories = repositoryAllowlistSchema.parse(
        JSON.parse(env.ADO_ALLOWED_REPOSITORIES),
      );
    } catch {
      fail(
        'ADO_ALLOWED_REPOSITORIES must be a JSON array of {project, repository} entries (names or IDs, no wildcards, maximum 100). Use [] to deny all repository access; omit it for reads only.',
      );
    }
  }
  const projectScopes: Partial<Config> = {};
  for (const [variable, property] of [
    ['ADO_ALLOWED_WORK_ITEM_PROJECTS', 'allowedWorkItemProjects'],
    ['ADO_WORK_ITEM_WRITE_PROJECTS', 'workItemWriteProjects'],
  ] as const) {
    if (env[variable] !== undefined) {
      try {
        projectScopes[property] = z
          .array(scopeIdentifier)
          .max(100)
          .parse(JSON.parse(env[variable]));
      } catch {
        fail(
          `${variable} must be a JSON array of project names or IDs (no wildcards, maximum 100). Omitted or [] denies access.`,
        );
      }
    }
  }
  return {
    serverUrl: url.href.replace(/\/+$/u, ''),
    collection,
    ...(project ? { project } : {}),
    ...(allowedRepositories === undefined ? {} : { allowedRepositories }),
    ...projectScopes,
    authType: 'pat',
    token,
    apiVersion,
    timeoutMs,
  };
}
