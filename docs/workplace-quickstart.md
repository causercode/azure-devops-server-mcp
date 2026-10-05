# Try the MCP on a workplace computer

Start with a read-only check of one repository you approve. The home lab configuration and PAT should stay on the home computer; create a separate local configuration and PAT for the workplace server.

## 1. Install and build

Obtain this source checkout through Git or a source archive, open PowerShell in its directory, and run:

```powershell
node --version
npm ci
npm run check
node .\dist\index.js --version
```

Node 22.12+ is required; the recorded live lab run used Node 24. If PowerShell blocks `npm.ps1`, use `npm.cmd` for these commands. The offline tests use only local fixtures and make no requests to a workplace server.

## 2. Identify the server and repository

Use the [configuration inspection guide](workplace-configuration.md) to identify the server root, collection, exact server build, and project/repository IDs. The optional inventory script uses Windows authentication and may list all repositories visible in the selected project; it is separate from the MCP allowlist.

For a web URL with the shape `https://devops.example.com/tfs/DefaultCollection/SharedProject/_git/MyRepo`, use server root `https://devops.example.com/tfs`, collection `DefaultCollection`, and project `SharedProject`. Keep identifying workplace details in local configuration only.

## 3. Configure one approved repository

```powershell
Copy-Item -LiteralPath .env.example -Destination .env.work.local
notepad .env.work.local
```

Edit the file locally. These values are placeholders:

```dotenv
ADO_SERVER_URL=https://devops.example.com/tfs
ADO_COLLECTION=DefaultCollection
ADO_PROJECT=SharedProject
ADO_ALLOWED_REPOSITORIES='[{"project":"11111111-1111-1111-1111-111111111111","repository":"22222222-2222-2222-2222-222222222222"}]'
ADO_AUTH_TYPE=pat
ADO_TOKEN=replace-with-a-workplace-PAT
ADO_API_VERSION=7.0
ADO_TIMEOUT_MS=30000
```

Replace both fictional GUIDs with the actual project and repository IDs. Initially include just one repository. A shared project is not permission to modify all its repositories; the configured list restricts all repository reads and writes through this MCP.

For the first check, create a PAT scoped to **Code (Read)** and **Project and Team (Read)**. Browser Windows sign-in is separate from PAT authentication. Use REST 7.0 for Server 2022, 6.0 for experimental Server 2020, or 5.0 for untested Server 2019; do not interpret a successful request as proof of every tool's compatibility.

The file is ignored by Git. Treat it as a credential file and keep it private. Environment variables already set by the parent process take precedence over Node's env file; clear stale `ADO_*` values or use a fresh terminal before switching between servers. For a company CA, obtain an approved PEM file and add `NODE_EXTRA_CA_CERTS=C:/path/to/company-ca.pem`. Keep certificate verification enabled.

## 4. Run the read-only connection check

```powershell
node --env-file=.env.work.local .\scripts\check-connection.mjs
```

This starts the compiled MCP server over stdio, verifies the five tools, and reads diagnostics, project discovery, the first allowed repository, one page of branches, and one page of PRs. It never calls a write tool or creates test resources. A success result includes `passed: true` and `readOnly: true`; it does not establish write permissions. Its output includes internal repository names and IDs, so keep it private. The check is supplied in source checkouts, not the npm runtime package.

Do not run `npm run test:live` at work. That separate runner creates and edits a real PR and is restricted to a disposable loopback lab.

## 5. Connect your coding client

Follow the README's [Codex](../README.md#codex) or [Claude Code](../README.md#claude-code) registration instructions for your selected client. In the shared PowerShell setup, set `$mcpEnvFile = Join-Path $mcpDirectory '.env.work.local'` so both registrations use the workplace configuration prepared above. They can share one built MCP program and env file, with separate stdio processes.

Use the configuration directory selected by your client: Codex's `CODEX_HOME` or Claude's `CLAUDE_CONFIG_DIR` if customized. Paths refer to the computer/environment running that client and must be absolute. The PAT stays in the local env file. For Codex, the README also shows an optional `enabled_tools` filter for the four read tools. Keep the first PAT read-only whichever client you choose.

Start a fresh client session in your actual repository checkout, then ask:

> Use the Azure DevOps Server MCP to check connectivity, inspect my repository, and list its branches. Do not make changes.

Confirm that the agent actually has and calls our MCP tools. If they are missing, verify the client's configuration directory, absolute paths, new session, and startup diagnostics. Successfully running the standalone check does not prove your client has loaded the server. Native source-control features are separate from MCP registration. Verify the natural-language workflow with this check and the PR prompt.

## 6. Create a draft PR when reads are verified

Replace the PAT with one scoped to **Code (Read & write)** and **Project and Team (Read)**. Keep the same repository allowlist. If you added Codex's optional `enabled_tools` filter, remove it or add `repo_pull_request_write`. Start a fresh session in the provider you registered.

Use an existing suitable change in your approved repository, or a disposable repository/branch. Confirm the target branch and push the feature branch using Git. From that checkout, ask:

> Create a draft pull request from my current feature branch into develop. Use the Azure DevOps Server MCP. Return the PR number and URL.

Replace `develop` with your actual target. Verify the repository, source/target branches, draft state, title, and exactly one PR in the browser. Do not retry blindly after an uncertain write; inspect the PR list first. PR completion/merge remains manual.

Record the server build, REST version, Node/client versions, and pass/fail results privately. Only anonymized results belong in [live acceptance evidence](live-acceptance.md). The lab's Codex workflow passed according to the maintainer. Use the browser URL returned by this MCP; validate workplace connectivity and any native client PR tracking separately.
