#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
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
      `${SERVER_NAME} ${SERVER_VERSION}\n\nRuns an MCP server over stdio. Configure ADO_SERVER_URL, ADO_COLLECTION, and ADO_TOKEN.\nPR writes require ADO_ALLOWED_REPOSITORIES, a JSON array of {project, repository} entries. When configured, it restricts reads and writes.\nOptional: ADO_PROJECT, ADO_AUTH_TYPE=pat, ADO_API_VERSION=7.0, ADO_TIMEOUT_MS=30000.\nSee README.md for client setup.\n`,
    );
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
