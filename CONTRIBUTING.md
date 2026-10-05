# Contributing

Use Node.js 22.12+ and npm. Install dependencies with `npm ci`, then run `npm run check`. Run `npm run format` before submitting changes. `npm test` builds the CLI and runs all tests; `npm run test:watch` builds once and watches tests. Rebuild after changing CLI sources during watch mode.

## Architecture

```text
MCP client → stdio → tools → services → ADO REST client → Azure DevOps Server
```

- `src/index.ts`: CLI startup, configuration, stdio transport, shutdown.
- `src/server.ts`: dependency construction and tool registration.
- `src/config.ts`: environment validation. Credentials are process-owned.
- `src/ado/`: auth providers, central endpoint/version mapping, selected response schemas, and bounded HTTP JSON/text transport. This layer must not import MCP APIs.
- `src/services/`: repository and independent work-item project authorization, branch/PR checks, review discussions/reviewers, guarded WIQL, revision-checked fields/links, and bounded summaries.
- `src/tools/`: agent-facing schemas, safety annotations, action dispatch, and safe result/error encoding.
- `tests/unit/`: configuration, credentials, HTTP boundary, and branch edge cases.
- `tests/integration/`: local ADO fixture, MCP tool calls, and actual stdio subprocesses.

Preserve the original repository scope semantics and separate default-deny work-item permissions. All new PR reads/writes verify the actual PR repository; work-item IDs, batches, query results and links verify the actual project. Updates and links require a source revision plus a server `test /rev`. Do not accept arbitrary JSON Patch, link URLs, project moves, approval votes, completion/merge or administrative operations. Do not spread API-version literals across endpoints or couple the REST client to MCP. Read-only POSTs must set `readOnly: true`; mutations supply resource-specific recovery instructions and must never retry automatically.

## Validation

Add meaningful tests for behavior changes, especially new write paths, authentication handling, pagination, and compatibility differences. Do not use real credentials in tests or fixtures. Tests should remain runnable without access to an Azure DevOps installation.

Document any live validation using the template in [docs/live-acceptance.md](docs/live-acceptance.md), excluding private hostnames, project names, identities, and credentials. Claims of server/client support require live evidence.

The source-only `scripts/live-acceptance-phase2.mjs` is a write-capable, loopback-only stdio harness. It requires independent explicit repository and work-item scopes, a fresh `phase2-mcp-` branch, and a verified disposable person ID. It records each created resource before continuing and leaves resources inspectable. Keep setup, credentials and identifying reports local; see [Phase 2 contracts](docs/phase-2.md) and the acceptance guide. CI runs the same harness against the stateful HTTP fixture through a real child process, without lab credentials.

## Releases

Before a source commit, pass `npm run check` and review the Git contents. Local env files, workplace inventories, private client configurations, and live reports must stay out of Git. Use the [workplace quickstart](docs/workplace-quickstart.md) for a read-only first trial. The home lab's PAT and configuration are not transferable to a workplace server.

Before publishing source code to a public GitHub repository, enable private vulnerability reporting and add the actual repository URLs to package metadata. Keep compatibility claims limited to recorded evidence; v0.2 expands features without claiming an interactive Phase 2 coding-client workflow.

Before tagging a release, complete live acceptance on the primary target including the actual coding-client prompt. Before publishing to npm, also inspect `npm pack --dry-run`, smoke-test the packed runtime, and confirm package name/ownership on npm. Update `package.json` and the compatibility/status documentation. `npm pack`/`npm publish` builds the production package through `prepack`; publication and tagging are maintainer actions.

The npm package includes built code, TypeScript declarations, README, license, security policy, and the placeholder env example. It excludes tests, local env files, and development dependencies.

Report vulnerabilities using [SECURITY.md](SECURITY.md), not a public issue containing private data.
