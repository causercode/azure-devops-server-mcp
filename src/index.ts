#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { runAuthCommand } from './cli/auth.js';
import { loadConfig } from './config.js';
import { SafeError } from './errors.js';
import { SERVER_NAME, SERVER_VERSION } from './metadata.js';
import { createServer } from './server.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--version') {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      `${SERVER_NAME} ${SERVER_VERSION}\n\nRuns an MCP server over stdio. Configure ADO_SERVER_URL, ADO_COLLECTION, and a PAT in ADO_TOKEN or the OS credential store (ADO_TOKEN_SOURCE=credential-manager; see auth --help).\nPR writes require ADO_ALLOWED_REPOSITORIES, a JSON array of {project, repository} entries. When configured, it restricts reads and writes.\nWork-item reads/writes separately require ADO_ALLOWED_WORK_ITEM_PROJECTS/ADO_WORK_ITEM_WRITE_PROJECTS; both default deny-all.\nBuild queueing also requires ADO_BUILD_WRITE_REPOSITORIES and ADO_BUILD_WRITE_DEFINITIONS; both default deny-all.\nPhase 2/3 tools require REST 7.0 or 7.1.\nOptional: ADO_PROJECT, ADO_AUTH_TYPE=pat, ADO_TOKEN_SOURCE=env, ADO_CREDENTIAL_TARGET, ADO_API_VERSION=7.0, ADO_TIMEOUT_MS=30000.\nSee README.md, docs/phase-2.md and docs/pipelines.md for client setup and execution boundaries.\n`,
    );
    return;
  }
  if (args[0] === 'auth') {
    process.exitCode = await runAuthCommand(args.slice(1), {
      env: process.env,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    return;
  }
  if (args.length)
    throw new SafeError(
      'INVALID_ARGUMENT',
      'Unsupported command-line arguments. Use --help for configuration.',
    );
  const server = createServer(loadConfig());
  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // Never serialize arbitrary errors, environment variables, or request headers.
  const message =
    error instanceof SafeError ? error.message : 'Unable to start MCP server.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
