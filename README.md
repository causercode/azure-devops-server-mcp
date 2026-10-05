# azure-devops-server-mcp

Connect MCP-compatible AI coding agents to **self-hosted Azure DevOps Server repositories, pull request review, and work items**.

The original **From MCP to Pull Request** workflow remains available:

> “Create a pull request from my current feature branch into develop.”

The agent reads its local Git context, finds the Azure DevOps project and repository, and calls this server. The server resolves the repository, verifies both remote branches, creates the PR, and returns its number and browser URL.

**Status:** v0.2 adds PR changed-file review, pinned text reads, discussions, reviewers, and independently authorized work items/queries/comments/links. [Live stdio acceptance](docs/live-acceptance.md) passed against Azure DevOps Server Express 2022.2 Patch 12 / REST 7.0. PR review works without enabling work items. The maintainer confirmed the original v0.1 Codex workflow; interactive Phase 2 workflows, Claude Code, REST 7.1 and other servers remain unverified. This package has not been published to npm. Independently implemented; not affiliated with Microsoft.

## Requirements and compatibility

- Node.js **22.12+** (CI is configured for Node 22 and 24 on Windows and Linux).
- Network access to the Azure DevOps Server collection.
- A PAT and an identity with access to the projects/repositories you want to use.

| Azure DevOps Server             | REST version                       | Project status                                                           |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| Express 2022.2 Patch 12         | `7.0`                              | Live stdio acceptance passed; build `19.235.37529.3`                     |
| 2022 / 2022.1 and other updates | `7.0`, optionally `7.1` on 2022.1+ | Primary target; these exact installations and REST 7.1 remain unverified |
| 2020                            | `6.0`                              | Experimental; untested against a live server                             |
| 2019                            | `5.0`                              | Configurable; not yet tested or supported                                |

Version mappings follow [Microsoft’s REST API compatibility table](https://learn.microsoft.com/en-us/rest/api/azure/devops/). Selecting a version does not prove compatibility. There is no automatic negotiation or fallback. New Phase 2 endpoints require `7.0` or `7.1`; selecting `6.0`/`5.0` retains only the original v0.1 capabilities. Azure DevOps Services (cloud), TFVC, and Windows/NTLM/Kerberos MCP authentication are outside this target. Preview versions for comments and identity lookup are selected centrally; see [Phase 2 contracts](docs/phase-2.md).

## Build and configure

For an existing workplace installation, the [read-only configuration inspection guide](docs/workplace-configuration.md) explains how to identify its collection/project layout, authentication, and version.

For a first workplace trial, follow the [workplace quickstart](docs/workplace-quickstart.md): build, configure one approved repository, run a read-only MCP connection check, and register the server with your coding client before trying a draft PR.

From a source checkout:

```sh
npm ci
npm run build
```

Configure the environment of the MCP process:

```dotenv
ADO_SERVER_URL=https://devops.example.com/tfs
ADO_COLLECTION=DefaultCollection
ADO_PROJECT=MyProject
ADO_ALLOWED_REPOSITORIES='[{"project":"MyProject","repository":"MyRepo"}]'
ADO_AUTH_TYPE=pat
ADO_TOKEN=your-personal-access-token
```

`ADO_SERVER_URL` is the server root, including any virtual directory such as `/tfs`, **without** the collection or project. The collection is appended separately and may contain spaces. Installations hosted directly at a hostname can use `https://devops.example.com`. Trailing slashes are accepted. URLs containing credentials, query parameters, or fragments are rejected.

| Variable                         | Required                      | Default / meaning                                                              |
| -------------------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| `ADO_SERVER_URL`                 | Yes                           | Server root and optional virtual directory                                     |
| `ADO_COLLECTION`                 | Yes                           | Collection name                                                                |
| `ADO_TOKEN`                      | Yes                           | PAT owned by the MCP process                                                   |
| `ADO_AUTH_TYPE`                  | No                            | `pat`; the only implementation                                                 |
| `ADO_PROJECT`                    | No                            | Default project; tool calls may override it                                    |
| `ADO_ALLOWED_REPOSITORIES`       | Required for writes           | JSON array of `{project, repository}` entries; restricts all repository access |
| `ADO_ALLOWED_WORK_ITEM_PROJECTS` | Required for work-item reads  | JSON array of project names/GUIDs; omitted or `[]` denies work-item access     |
| `ADO_WORK_ITEM_WRITE_PROJECTS`   | Required for work-item writes | JSON array of projects also in the read list; omitted or `[]` disables writes  |
| `ADO_API_VERSION`                | No                            | `7.0`; accepts `7.1`, `6.0`, or `5.0`                                          |
| `ADO_TIMEOUT_MS`                 | No                            | `30000` per HTTP request; range `100`–`120000`                                 |

Use the **Code (Read & write)** PAT scope to create or edit PRs, plus **Project and Team (Read)** for project discovery and connectivity diagnostics. For a read-only installation, use **Code (Read)** instead. Server administrators may restrict PAT availability; PAT scopes do not grant repository permissions that the identity lacks. See [PAT documentation](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops) and [PR API scopes](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create?view=azure-devops-rest-7.1).

The CLI reads process environment variables. It does **not** automatically load `.env`. For development, copy `.env.example` to `.env`, edit locally, and run `npm run dev`. To run a built server with an env file:

```sh
node --env-file=/absolute/path/to/.env /absolute/path/to/azure-devops-server-mcp/dist/index.js
```

Do not commit credentials or provide them in an agent prompt.

Work-item reads need **Work Items (Read)**; fields, comments and links need **Work Items (Read & write)**. Reviewer person lookup needs **Identity (Read)**. Configure only the features you use; Code access and repository permission do not grant work-item permission. PAT scopes supplement the identity’s ADO permissions.

### Repository access

**PR writes are disabled by default.** Each user must explicitly configure `ADO_ALLOWED_REPOSITORIES` before the MCP can create or edit a PR. A default project, broad PAT permissions, repository discovery, or an agent's choice of repository does not grant write access.

The allowlist is generic: entries select a project and repository by name or ID, within the configured collection. Multiple repositories and projects are supported (up to 100 entries). For example:

```dotenv
ADO_ALLOWED_REPOSITORIES='[{"project":"SharedProject","repository":"MyApplication"},{"project":"SharedProject","repository":"MyLibrary"}]'
```

When configured, it restricts **reads and writes** across repository, branch, file, identity-context and PR tools, including discussions and reviewers. Discovery queries only the configured repositories and shows only their projects. Supplying another project, repository ID, or PR ID cannot override the restriction. The server checks a PR's repository before new review operations. Scope is configured by the person launching the process; tools cannot change it.

### Independent work-item access

Work-item reads and writes default to deny-all. Enable only approved projects in the MCP process:

```dotenv
ADO_ALLOWED_WORK_ITEM_PROJECTS='["MyProject"]'
ADO_WORK_ITEM_WRITE_PROJECTS='["MyProject"]'
```

Prefer project GUIDs for stable identity. Writes require the selected project to resolve in **both** lists. `ADO_PROJECT`, repository permissions and broad PAT scopes do not grant this access. Work-item tools operate independently of Git access; repository discovery continues to show repository-approved projects only. Supply the approved work-item project explicitly or through `ADO_PROJECT`.

ID-based reads, batches and query results verify each actual `System.TeamProject`; an unauthorized batch returns no partial data. Parent/child/related links require both tickets in the same authorized project. Linking to a PR additionally requires that PR’s repository write authorization in the same project. Link inspection exposes only authorized supported links. No arbitrary artifact URLs are accepted. See [examples and limits](docs/phase-2.md).

Use project and repository **GUIDs** to pin identities across renames. Name entries authorize whatever repository currently has that name; deleting/recreating it can change its identity. Tool callers can use the current names or IDs of a repository resolved from an allowed entry. Matching is case-insensitive; wildcards and unknown configuration fields are rejected. A malformed allowlist stops startup. `[]` denies all repository access. Omission permits reads according to ADO permissions but still disables all PR writes.

The MCP does not infer who "owns" a repository. Effective access is the configured allowlist intersected with the PAT identity's ADO permissions. This restriction applies to this MCP process; an agent's separate Git, shell, or other integrations have their own access.

## Connect an MCP client

Build **one local copy** of this program, then register it separately in each coding provider's configuration. Codex and Claude Code can both point to the same `dist/index.js` and local env file; each connecting client starts its own stdio process. Authentication to the coding provider is separate from the ADO PAT used by this server.

Switching coding clients does not transfer MCP registration. Accounts sharing one client configuration can share its registration; separate configuration directories need their own registration.

### Prepare the shared program and configuration

The following commands use PowerShell. Run them from this MCP's source directory, after `npm ci` and `npm run build`. Create `.env.local` from `.env.example` if it does not already exist, then edit it locally with your connection, PAT, and explicit repository allowlist. Use `.env.work.local` instead if following the [workplace quickstart](docs/workplace-quickstart.md).

```powershell
$mcpDirectory = (Get-Location).Path
$nodeExecutable = (Get-Command node -CommandType Application).Source
$mcpEnvFile = Join-Path $mcpDirectory '.env.local'
$mcpEntryPoint = Join-Path $mcpDirectory 'dist/index.js'
if (-not (Test-Path -LiteralPath $mcpEnvFile)) {
  Copy-Item -LiteralPath .env.example -Destination $mcpEnvFile
}
notepad $mcpEnvFile
```

For `.env.work.local`, change the `$mcpEnvFile` assignment above. Keep the env file private; neither registration below stores the PAT in the agent configuration or command history. Existing parent-process `ADO_*` variables take precedence over Node's env file, so clear stale values when switching servers. For the first workplace trial, use a Code (Read) PAT, then upgrade to Code (Read & write) when you are ready to create a draft PR.

Run the read-only check before registering:

```powershell
& $nodeExecutable "--env-file=$mcpEnvFile" (Join-Path $mcpDirectory 'scripts/check-connection.mjs')
```

Paths must refer to the machine running the coding provider. For macOS/Linux, use the same Node command and absolute arguments with your platform's paths and shell syntax.

### Codex

If you use a custom Codex configuration directory, set `$env:CODEX_HOME` to that path in this terminal before registering; otherwise use Codex's normal default. Use the same profile when verifying the registration.

```powershell
codex mcp add azure-devops-server -- $nodeExecutable "--env-file=$mcpEnvFile" $mcpEntryPoint
codex mcp list
```

Alternatively, append this table to that Codex home's `config.toml` (normally `~/.codex/config.toml`), replacing the absolute paths. Use either the CLI command or the table, and preserve existing configuration:

```toml
[mcp_servers.azure-devops-server]
command = "C:/Program Files/nodejs/node.exe"
args = [
  "--env-file=C:/path/to/azure-devops-server-mcp/.env.local",
  "C:/path/to/azure-devops-server-mcp/dist/index.js"
]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

The CLI writes the basic command/args registration; the table also shows optional timeouts. Codex may show `Auth: Unsupported` for this stdio registration: there is no MCP OAuth login, and the ADO PAT is handled inside our process. For a read-only client configuration, add `enabled_tools = ["server_info", "repo_repository", "repo_branch", "repo_pull_request"]` to this table. Remove that filter or add `repo_pull_request_write` before trying PR writes. See [OpenAI's MCP configuration documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### Claude Code

Register with user scope so the server is available across your local checkouts:

```powershell
claude mcp add --transport stdio --scope user azure-devops-server -- $nodeExecutable "--env-file=$mcpEnvFile" $mcpEntryPoint
claude mcp get azure-devops-server
```

If you use a custom Claude Code configuration directory, set `$env:CLAUDE_CONFIG_DIR` to that path in this terminal before registering and verifying. Leave it unset for the normal configuration. `--scope user` makes the registration available across projects, while this MCP's repository allowlist still limits ADO access. Default local scope would register only for the current checkout. See [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).

### Verify the tools in the selected client

Start a fresh client session using the configured profile, in the repository you want to work on. In the Codex or Claude Code CLI, `/mcp` shows MCP status. Then ask:

> Use the Azure DevOps Server MCP to check connectivity, inspect my repository, and list its branches. Do not make changes.

Confirm the agent actually calls this server's tools. `codex mcp list` confirms registration; `claude mcp get` checks connection status, but neither proves the tools are loaded in your active session. If tools are missing, check the client's configuration directory, absolute Node/env/script paths, and startup errors. A client's native source-control features and PR tracking are separate from this MCP registration. Verify each client's setup with this check and the PR acceptance prompt; see the [recorded client results](docs/live-acceptance.md).

### Other MCP clients

For clients that use an `mcpServers` JSON configuration, register the same stdio command and env file:

```json
{
  "mcpServers": {
    "azure-devops-server": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/azure-devops-server-mcp/.env.local",
        "/absolute/path/to/azure-devops-server-mcp/dist/index.js"
      ]
    }
  }
}
```

On Windows, use a path such as `C:/Users/you/code/azure-devops-server-mcp/dist/index.js`. Your client may instead offer a server configuration form or another config format; use the same command, arguments, and environment variables. Prefer the client’s protected environment/secret mechanism when available.

Keep stdout dedicated to MCP. Startup errors go to stderr. Running `npm start` manually waits for a client on stdin; it does not open a web page. `node dist/index.js --help` and `--version` work without credentials.

## Tools

| Tool                             | Actions                                                                                   | Purpose                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `repo_repository`                | `get`, `list`                                                                             | Inspect Git repositories in a project                                        |
| `repo_branch`                    | `get`, `list`                                                                             | Inspect exact remote branches or list branch prefixes                        |
| `repo_pull_request`              | `get`, `list`, `get_changes`, `list_reviewers`, `get_work_items`                          | PR reads, changed files with pinned commits, votes and ticket links          |
| `repo_pull_request_write`        | `create`, `update`, `update_reviewers`                                                    | PR metadata and explicit person reviewer add/remove                          |
| `server_info`                    | `get`, `list_projects`                                                                    | Connectivity diagnostics and project discovery                               |
| `repo_file`                      | `get_content`                                                                             | Bounded text content at an explicit commit                                   |
| `core_identity`                  | `search`, `get`                                                                           | Active person candidates and explicit ID resolution in approved repo context |
| `repo_pull_request_thread`       | `list`, `list_comments`                                                                   | Paged discussion reads                                                       |
| `repo_pull_request_thread_write` | `create`, `reply`, `update_status`                                                        | Comment and resolve/reopen discussions                                       |
| `wit_work_item`                  | `get`, `get_batch`, `get_type`, `list_types`, `list_fields`, `list_comments`, `get_links` | Project-checked tickets, metadata, comments and authorized links             |
| `wit_work_item_write`            | `create`, `update`                                                                        | Explicit field changes; update requires revision                             |
| `wit_work_item_comment_write`    | `add`                                                                                     | Comment as the PAT identity                                                  |
| `wit_query`                      | `list`, `get`, `get_results`, `wiql`                                                      | Saved query discovery and bounded flat WIQL                                  |
| `wit_work_item_link_write`       | `link`, `link_to_pull_request`                                                            | Revision-checked same-project work-item/PR links                             |

Tool names are inspired by [Microsoft’s Azure DevOps MCP](https://github.com/microsoft/azure-devops-mcp); inputs and features are a deliberately smaller, independent contract, not a drop-in replacement.

All repository operations accept `project` as a name or ID. It can be omitted when `ADO_PROJECT` is configured. `repository` accepts a name or ID and is required except for repository listing. Branch names are case-sensitive and accept either `feature/foo` or `refs/heads/feature/foo`.

When no default project is configured, start with:

```json
{ "action": "list_projects" }
```

Call this on `server_info`, select an accessible project, then use `repo_repository` with `{ "action": "list", "project": "Website" }`.

Create a PR with `repo_pull_request_write`:

```json
{
  "action": "create",
  "project": "Website",
  "repository": "intranet",
  "sourceBranch": "feature/search",
  "targetBranch": "develop",
  "title": "Improve search caching",
  "description": "Cache repeated search queries.",
  "isDraft": true
}
```

The response includes `pullRequestId`, `url`, `title`, `status`, short branch names, project/repository IDs and names, and draft state. Results are available as both JSON text and MCP `structuredContent`.

For an update, supply `action: "update"`, `repository`, `pullRequestId`, and at least one of `title`, `description`, or `isDraft`. An empty description clears it; `isDraft: false` publishes a draft for review. Titles are limited to 400 characters and descriptions to 4000. Source and target branches cannot be changed on update.

For `repo_pull_request/get`, supply `pullRequestId`. For `repo_branch/get`, supply `branch`. Listing PRs defaults to `status: "active"`; also accepts `completed`, `abandoned`, or `all`, with optional `sourceBranch` and `targetBranch` filters. Branch listing accepts `prefix`, such as `feature/`.

### Pagination

List operations return `{ "items": [...] }` and accept `top` (default 25, maximum 100).

- Projects and branches: pass the returned `continuationToken` to the next call, preserving filters and page size. Stop when no token is returned. With an allowlist, project pagination uses only the projects resolved from allowed repositories.
- Repositories: use `skip`/`nextSkip`. Without an allowlist, the REST endpoint returns the repository inventory; the service pages it locally. With an allowlist, only configured repositories are queried and then paged locally.
- PRs: use `skip`/`nextSkip`. A full page indicates a possible next page; the final call may return an empty array.
- PR changes: keep the returned `iterationId` and `compareTo` fixed; use `nextSkip` for the next page. `compareTo: 0` compares to the common ancestor. Results are changed-file metadata; use `repo_file/get_content` at `baseCommit` and `sourceCommit` for text review.
- Threads, thread comments, metadata and saved-query discovery: `skip`/`nextSkip` pages bounded full REST inventories locally. Work-item comments use the server’s `continuationToken`. File reads use `nextStartLine`, up to 200 lines/32000 characters per result.
- WIQL: at most 100 verified ID references; `possiblyMore` signals a full result page. Narrow WHERE or use an ID boundary for additional results. No offset/continuation is invented. Reviewer lists and work-item relation inspection cap at 100; inspect larger resources on the server.

### Local Git and write outcomes

The MCP server does not inspect the agent’s checkout, run Git, or push commits. The agent identifies its branch and remote using local tools, selects the matching Azure DevOps project/repository, and pushes the source branch through Git before calling this server.

Branch lookups verify **exact** ref names, even though ADO’s refs API applies a prefix filter. PR creation rejects identical source/target branches and verifies both exist remotely. Branches may change between the checks and creation; the server remains authoritative.

Writes are never automatically retried. A timeout, connection failure, or HTTP 5xx can leave the outcome unknown. Inspect the relevant PR, threads, reviewers, work item, comments or links before retrying. Work-item updates/links require the observed revision and a server `test /rev`; after a conflict, read current state and review the intended change. Errors set `isError` and provide a safe `error.code` and message; raw REST error bodies are withheld. Read-only WIQL/batch POSTs receive read error guidance.

## Security boundaries

v0.2 exposes no repository/branch deletion, push, merge, PR completion, autocomplete, approval votes, rule/policy bypass, permissions, pipelines, or administrative operations. Metadata/field/link writes use explicit contracts; arbitrary JSON Patch and artifact URLs are excluded. Reviewer assignment requires an explicit verified person GUID; searches do not choose ambiguous identities. Input schemas reject unknown/action-inappropriate fields; read and write tools have MCP safety annotations. Client approval behavior is controlled by the client.

The PAT remains inside the MCP process. Tools do not return environment variables, auth headers, raw responses, or arbitrary exception messages. Known raw and encoded forms of the configured PAT are redacted from tool output as defence in depth. Remote project/repository names, PR titles, and descriptions remain **untrusted data**, not instructions.

Prefer HTTPS. HTTP is accepted for installations and local labs that require it, but carries the PAT without transport encryption. Redirects are rejected; configure the final collection URL. No TLS verification bypass is provided. For an internal CA, configure Node’s trust with `NODE_EXTRA_CA_CERTS=/absolute/path/to/company-ca.pem` before launching the process. See [Node TLS configuration](https://nodejs.org/api/cli.html#node_extra_ca_certsfile).

See [SECURITY.md](SECURITY.md) for reporting guidance.

## Development and release validation

For a real server away from the workplace, see the [free Express test lab guide](docs/local-test-lab.md).

```sh
npm ci
npm run check
npm pack --dry-run
```

`npm run check` runs formatting verification, strict typechecking, the production build, and all tests. Unit tests cover config/auth, URL construction, safe errors, bounded responses, and exact branch lookup. Integration tests use a local HTTP fixture and real MCP transports, including a compiled stdio child process and a legacy MCP 2025 client. They require no corporate server, PAT, or network access beyond loopback.

The offline suite validates implementation against fixtures; the separate live stdio run provides evidence for the tested Express 2022.2 Patch 12 / REST 7.0 configuration. The maintainer also reported successful Codex workflow testing on this lab. These results do not establish every server version or coding-client workflow. Use the [live acceptance checklist](docs/live-acceptance.md) when testing another client or expanding compatibility claims. [CONTRIBUTING.md](CONTRIBUTING.md) explains the architecture and contribution checks.

## License

[MIT](LICENSE).
