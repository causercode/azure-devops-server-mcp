import {
  API_VERSIONS,
  isApiVersion,
  type ApiVersion,
} from './ado/api-version.js';
import {
  defaultCredentialTarget,
  systemCredentialStore,
  type CredentialStore,
} from './ado/credential-store.js';
import { defaultServicePrincipal } from './ado/negotiate.js';
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

export type AuthSettings =
  | {
      authType: 'pat';
      tokenSource: 'env' | 'credential-manager';
      token: string;
    }
  | { authType: 'negotiate'; servicePrincipal: string };

export type Config = {
  serverUrl: string;
  collection: string;
  project?: string;
  allowedRepositories?: readonly AllowedRepository[];
  buildWriteRepositories?: readonly AllowedRepository[];
  buildWriteDefinitions?: readonly number[];
  allowedWorkItemProjects?: readonly string[];
  workItemWriteProjects?: readonly string[];
  apiVersion: ApiVersion;
  timeoutMs: number;
} & AuthSettings;

export interface ConfigDependencies {
  credentialStore?: () => CredentialStore;
}

function fail(message: string): never {
  throw new SafeError('CONFIGURATION_ERROR', message);
}

/** Server root and collection, shared by the MCP server and the auth CLI. */
export function loadLocation(env: NodeJS.ProcessEnv = process.env): {
  serverUrl: string;
  collection: string;
} {
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
  return { serverUrl: url.href.replace(/\/+$/u, ''), collection };
}

export type PatConfig = Extract<Config, { authType: 'pat' }>;

/** ADO_TOKEN is rejected by every other auth mode, so its presence implies a PAT config. */
export function loadConfig(
  env: NodeJS.ProcessEnv & { ADO_TOKEN: string },
  dependencies?: ConfigDependencies,
): PatConfig;
export function loadConfig(
  env?: NodeJS.ProcessEnv,
  dependencies?: ConfigDependencies,
): Config;
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ConfigDependencies = {},
): Config {
  const { serverUrl, collection } = loadLocation(env);
  const auth = loadAuth(env, serverUrl, collection, dependencies);
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
  let buildWriteRepositories: AllowedRepository[] = [];
  let buildWriteDefinitions: number[] = [];
  try {
    buildWriteRepositories = repositoryAllowlistSchema.parse(
      JSON.parse(env.ADO_BUILD_WRITE_REPOSITORIES ?? '[]'),
    );
    buildWriteDefinitions = z
      .array(z.number().int().positive().max(2147483647))
      .max(100)
      .parse(JSON.parse(env.ADO_BUILD_WRITE_DEFINITIONS ?? '[]'));
  } catch {
    fail(
      'ADO_BUILD_WRITE_REPOSITORIES must be an array of {project, repository}; ADO_BUILD_WRITE_DEFINITIONS must be an array of positive definition IDs (maximum 100). Both default to [].',
    );
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
    serverUrl,
    collection,
    ...(project ? { project } : {}),
    ...(allowedRepositories === undefined ? {} : { allowedRepositories }),
    ...(env.ADO_BUILD_WRITE_REPOSITORIES === undefined
      ? {}
      : { buildWriteRepositories }),
    ...(env.ADO_BUILD_WRITE_DEFINITIONS === undefined
      ? {}
      : { buildWriteDefinitions }),
    ...projectScopes,
    ...auth,
    apiVersion,
    timeoutMs,
  };
}

export function isValidToken(token: string): boolean {
  return token.length > 0 && !/[\u0000-\u0020\u007f]/u.test(token);
}

/** Credential store entry name; defaults to one entry per server and collection. */
export function credentialTarget(
  env: NodeJS.ProcessEnv,
  serverUrl: string,
  collection: string,
): string {
  const target = env.ADO_CREDENTIAL_TARGET?.trim();
  if (!target) return defaultCredentialTarget(serverUrl, collection);
  if (target.length > 256 || /[\u0000-\u001f\u007f]/u.test(target)) {
    fail(
      'ADO_CREDENTIAL_TARGET must be 1-256 characters without control characters.',
    );
  }
  return target;
}

function loadAuth(
  env: NodeJS.ProcessEnv,
  serverUrl: string,
  collection: string,
  dependencies: ConfigDependencies,
): AuthSettings {
  const authType = env.ADO_AUTH_TYPE?.trim() || 'pat';
  const tokenSource = env.ADO_TOKEN_SOURCE?.trim() || 'env';
  const token = env.ADO_TOKEN?.trim();
  if (authType === 'negotiate') {
    if (env.ADO_TOKEN !== undefined || env.ADO_TOKEN_SOURCE !== undefined) {
      fail(
        'ADO_TOKEN and ADO_TOKEN_SOURCE must not be set when ADO_AUTH_TYPE=negotiate.',
      );
    }
    const servicePrincipal =
      env.ADO_KERBEROS_SPN?.trim() || defaultServicePrincipal(serverUrl);
    if (!/^[A-Za-z]+[/@][A-Za-z0-9.-]+(?::\d{1,5})?$/u.test(servicePrincipal)) {
      fail(
        'ADO_KERBEROS_SPN must look like HTTP/host (Windows) or HTTP@host (GSSAPI).',
      );
    }
    return { authType, servicePrincipal };
  }
  if (authType !== 'pat') fail('ADO_AUTH_TYPE must be pat or negotiate.');
  if (tokenSource === 'credential-manager') {
    if (env.ADO_TOKEN !== undefined) {
      fail(
        'Set either ADO_TOKEN or ADO_TOKEN_SOURCE=credential-manager, not both.',
      );
    }
    const store = (dependencies.credentialStore ?? systemCredentialStore)();
    const stored = store.get(credentialTarget(env, serverUrl, collection));
    if (!stored || !isValidToken(stored)) {
      fail(
        'No valid PAT is stored in the OS credential store for this server and collection. Run `azure-devops-server-mcp auth set-token` with the same ADO_SERVER_URL, ADO_COLLECTION and ADO_CREDENTIAL_TARGET.',
      );
    }
    return { authType, tokenSource, token: stored };
  }
  if (tokenSource !== 'env') {
    fail('ADO_TOKEN_SOURCE must be env or credential-manager.');
  }
  if (!token || !isValidToken(token)) {
    fail(
      'ADO_TOKEN is required and must not contain whitespace or control characters.',
    );
  }
  return { authType, tokenSource, token };
}
