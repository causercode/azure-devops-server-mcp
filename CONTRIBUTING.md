# Contributing

Use Node.js 22.12+ and npm. Install dependencies with `npm ci`, then run `npm run check`. Run `npm run format` before submitting changes. `npm test` builds the CLI and runs all tests; `npm run test:watch` builds once and watches tests. Rebuild after changing CLI sources during watch mode.

## Architecture

```text
MCP client → stdio → tools → services → ADO REST client → Azure DevOps Server
```

- `src/index.ts`: CLI startup, configuration, stdio transport, shutdown.
- `src/server.ts`: dependency construction and tool registration.
- `src/config.ts`: environment validation. Credentials are process-owned.
- `src/ado/`: auth providers, version mapping, response schemas, and HTTP/JSON client. This layer must not import MCP APIs.
- `src/services/`: repository name/ID resolution, branch normalization/checks, PR payload allowlists, and output summaries.
- `src/tools/`: agent-facing schemas, safety annotations, action dispatch, and safe result/error encoding.
- `tests/unit/`: configuration, credentials, HTTP boundary, and branch edge cases.
- `tests/integration/`: local ADO fixture, MCP tool calls, and actual stdio subprocesses.

Preserve the v0.1 boundary: metadata-only PR writes, no completion/merge or administrative operations. Do not spread API-version literals across endpoints or couple the REST client to MCP.

## Validation

Add meaningful tests for behavior changes, especially new write paths, authentication handling, pagination, and compatibility differences. Do not use real credentials in tests or fixtures. Tests should remain runnable without access to an Azure DevOps installation.

Document any live validation using the template in [docs/live-acceptance.md](docs/live-acceptance.md), excluding private hostnames, project names, identities, and credentials. Claims of server/client support require live evidence.

## Releases

Before a source commit, pass `npm run check` and review the Git contents. Local env files, workplace inventories, private client configurations, and live reports must stay out of Git. Use the [workplace quickstart](docs/workplace-quickstart.md) for a read-only first trial. The home lab's PAT and configuration are not transferable to a workplace server.

Before making the GitHub repository public, enable private vulnerability reporting and add the actual repository URLs to package metadata. Keep compatibility claims limited to recorded evidence; the initial source may be shared as a v0.1 candidate while coding-client acceptance remains pending.

Before tagging a v0.1 release, complete live acceptance on the primary target including the actual coding-client prompt. Before publishing to npm, also inspect `npm pack --dry-run`, smoke-test the packed runtime, and confirm package name/ownership on npm. Update `package.json` and the compatibility/status documentation. `npm pack`/`npm publish` builds the production package through `prepack`; publication and tagging are maintainer actions.

The npm package includes built code, TypeScript declarations, README, license, security policy, and the placeholder env example. It excludes tests, local env files, and development dependencies.

Report vulnerabilities using [SECURITY.md](SECURITY.md), not a public issue containing private data.
