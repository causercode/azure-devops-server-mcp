import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { authSecrets, createSecretRedactor } from '../dist/ado/auth.js';
import { loadConfig } from '../dist/config.js';
import { SafeError } from '../dist/errors.js';

// Reads only: never calls repo_pull_request_write or creates test resources.
let stage = 'configuration';
let redact = (value) => value;
let client;
let transport;

try {
  if (process.argv.length > 2) {
    throw new SafeError(
      'INVALID_ARGUMENT',
      'This check takes no arguments. Load configuration with node --env-file=/path/to/local.env scripts/check-connection.mjs.',
    );
  }
  const config = loadConfig();
  redact = createSecretRedactor(authSecrets(config));
  const entry = config.allowedRepositories?.[0];
  if (!entry) {
    throw new SafeError(
      'REPOSITORY_SCOPE_REQUIRED',
      'Configure a non-empty ADO_ALLOWED_REPOSITORIES list. This read-only check inspects its first repository.',
    );
  }

  client = new Client({ name: 'ado-connection-check', version: '0.1.0' });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value !== undefined &&
          (key.startsWith('ADO_') ||
            [
              'NODE_EXTRA_CA_CERTS',
              'NODE_USE_SYSTEM_CA',
              'NODE_USE_ENV_PROXY',
              'HTTP_PROXY',
              'HTTPS_PROXY',
              'NO_PROXY',
            ].includes(key)),
      ),
    ),
    stderr: 'pipe',
  });
  // Discard arbitrary child diagnostics; report only safe errors below.
  transport.stderr?.on('data', () => {});
  stage = 'MCP startup';
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  const expected = [
    'repo_repository',
    'repo_branch',
    'repo_pull_request',
    'repo_pull_request_write',
    'server_info',
  ];
  if (expected.some((name) => !tools.includes(name))) {
    throw new SafeError(
      'INVALID_RESPONSE',
      'The server did not advertise the expected five tools.',
    );
  }

  async function call(name, args) {
    stage = `${name}/${args.action ?? 'get'}`;
    const result = await client.callTool({ name, arguments: args });
    const data =
      result.structuredContent ??
      JSON.parse(
        result.content.find((item) => item.type === 'text')?.text ?? 'null',
      );
    if (result.isError || !data) {
      // Error messages from our server already use its safe error contract.
      throw new SafeError(
        data?.error?.code ?? 'MCP_ERROR',
        data?.error?.message ?? 'The MCP request failed.',
      );
    }
    return data;
  }

  const diagnostics = await call('server_info', {});
  const projects = await call('server_info', {
    action: 'list_projects',
    top: 1,
  });
  const repository = await call('repo_repository', {
    action: 'get',
    project: entry.project,
    repository: entry.repository,
  });
  const selector = {
    project: repository.project.id,
    repository: repository.id,
  };
  const branches = await call('repo_branch', {
    action: 'list',
    ...selector,
    top: 1,
  });
  const pullRequests = await call('repo_pull_request', {
    action: 'list',
    ...selector,
    status: 'all',
    top: 1,
  });
  console.log(
    redact(
      JSON.stringify(
        {
          passed: true,
          readOnly: true,
          connected: diagnostics.connected,
          authType: diagnostics.authType,
          apiVersion: diagnostics.apiVersion,
          reportedProductVersion: diagnostics.reportedProductVersion,
          repositoryAccess: diagnostics.repositoryAccess,
          projectDiscoverySucceeded: Array.isArray(projects.items),
          repository: {
            project: repository.project,
            id: repository.id,
            name: repository.name,
            defaultBranch: repository.defaultBranch,
          },
          firstBranchPageCount: branches.items.length,
          firstPullRequestPageCount: pullRequests.items.length,
          writePermissionsTested: false,
          note: 'Read-only check passed for the first allowed repository. No PR was created or edited. Output contains internal repository names and IDs; keep it private.',
        },
        null,
        2,
      ),
    ),
  );
} catch (error) {
  const code =
    error instanceof SafeError ? error.code : 'CONNECTION_CHECK_FAILED';
  const message =
    error instanceof SafeError
      ? error.message
      : 'Unable to complete the MCP check. Verify the build, configuration, connectivity, and certificate trust.';
  console.error(
    redact(JSON.stringify({ passed: false, stage, error: { code, message } })),
  );
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
}
