# v0.1 live acceptance: From MCP to Pull Request

**Current result: automated live stdio acceptance passed on 2026-10-04; the maintainer also reported successful Codex workflow testing on the same lab.** The compiled server and real MCP TypeScript SDK client completed all nine automated checks. Claude Code and other individual coding-client workflows remain unverified.

## Recorded live run

| Item              | Evidence                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server            | Azure DevOps Server Express 2022.2 Patch 12, build `19.235.37529.3`; patch tool and installed application assembly verified                                     |
| Database / host   | SQL Server 2022 Express; Windows 11 Pro 26H2, build 26300                                                                                                       |
| REST / runtime    | REST `7.0`; Node `24.21.0`; MCP TypeScript SDK client `2.3.0`                                                                                                   |
| Transport         | Compiled CLI over stdio, launched as a separate process                                                                                                         |
| Test resources    | Disposable project with allowed and unlisted repositories; remote `develop` and feature branches                                                                |
| Result            | All nine automated checks passed; one draft PR created and retained; its browser URL returned HTTP 200 using Windows authentication through the tailnet address |
| Discovery / reads | Five tools advertised; diagnostics, project/repository discovery, name/ID resolution, exact branch checks, PR get and filtered list passed                      |
| Writes            | PR creation, title/description edits, clearing description, and toggling draft state passed; final PR active and draft                                          |
| Rejections        | Unsupported completion/policy inputs, identical branches, missing branches, and unlisted repository reads/writes by name and ID rejected                        |
| Scope proof       | A direct lab-only REST read confirmed the PAT could access the unlisted repository; MCP calls still rejected it                                                 |
| Limitations       | REST 7.1 and other server editions/releases not yet tested; upstream product-version header absent                                                              |

The detailed report is saved locally as ignored `live-acceptance.local.json`. It contains local URLs and resource IDs and is not part of this public evidence summary. The PAT was not printed or included in the report. The created draft PR remains for inspection; no completion or cleanup ran.

Additional commit preparation on 2026-10-04 passed all 117 offline tests on Windows with Node 24.21.0 and Node 22.12.0. A fresh source install with Node 24 passed the full check; the packed runtime initialized and advertised all five tools with production dependencies only. `npm audit` reported zero known vulnerabilities. The separate read-only connection check and Windows-authenticated inventory script also passed against this lab. These checks did not create or edit another PR and do not establish the workplace server or an interactive coding-client workflow.

README registration commands were also checked in isolated temporary profiles using Codex CLI 0.160.0 and Claude Code 2.1.289. Both saved the stdio registration, and Claude's connection check reported Connected using a placeholder PAT and deny-all repository scope. This validates registration and MCP startup, not ADO authentication or an agent's PR workflow; normal user profiles were unchanged.

## Maintainer-reported coding-client run

On 2026-10-04, the maintainer reported that the provided Codex workflow tests passed against this lab and that the returned Azure DevOps PR URL was verified. This is a reported client result, separate from the automated evidence above. Exact versions for that interactive session and a saved transcript were not recorded in this public summary. Workplace validation remains pending. Native client PR tracking is separate from this MCP's verified browser URL.

Claude Code registration/startup was checked as described above, but its actual read/create/update workflow has not yet been tested. Do not claim that workflow or other server versions as verified.

Run this in a disposable test project/repository. All PR cleanup and installation changes remain manual. Do not use production credentials in test reports.

## Prepare

1. Record the exact Azure DevOps Server edition, release/update/build, Windows version, selected REST version, Node version, and MCP client/version.
2. Build with `npm ci` and `npm run check`.
3. Create a test Git repository with a `develop` branch. Make a commit on `feature/mcp-acceptance` and push both branches through Git.
4. Create a PAT with Code (Read & write) and Project and Team (Read), restricted to the test identity’s permissions.
5. Configure the MCP process with server root, collection, PAT, and `ADO_ALLOWED_REPOSITORIES` containing only the disposable test project/repository. Initially omit `ADO_PROJECT`. PR writes are disabled without a list.

## Verify discovery and diagnostics

- `server_info/get` succeeds with safe configuration and no credentials. The configured API version must not be mistaken for an automatically detected server version.
- Ask “List my projects.” The agent uses `server_info/list_projects` and selects the test project.
- List repositories, then inspect the test repository by name and ID.
- List branches and get `develop` and `feature/mcp-acceptance` exactly. If the installation has multiple pages, verify continuation tokens.

## Run the core acceptance prompt

For a disposable loopback lab, the repeatable stdio check is available as `npm run test:live` from a source checkout. Configure `.env` with the lab connection/PAT and `ADO_PROJECT`, then optionally set `ADO_TEST_REPOSITORY`, `ADO_TEST_SOURCE_BRANCH`, and `ADO_TEST_TARGET_BRANCH` (defaults: `mcp-acceptance`, `feature/mcp-acceptance`, and `develop`). Push those branches first. This command creates and edits a real draft PR; it rejects remote hosts and an existing active PR for the same branch pair. Use a fresh test branch for each run. It writes an ignored `live-acceptance.local.json` report; `ADO_LIVE_REPORT` can select another local path. The command does not complete or clean up the PR.

The automated live check validates the compiled stdio server. Still open its returned PR URL and run the natural-language prompt below to validate the actual agent/client workflow.

Optionally set `ADO_TEST_UNLISTED_REPOSITORY` to a second disposable repository in that same loopback lab project, excluded from the MCP allowlist. The runner verifies the PAT can read it directly and that every MCP repository read/write rejects it by both name and ID. This verifies the configured boundary independently of ADO's permissions. Use only lab resources you created for this check.

From the local test checkout on the pushed feature branch, ask:

> Create a pull request from my current feature branch into develop.

Confirm the agent identifies the correct project/repository from local Git, checks branches, calls `repo_pull_request_write/create`, and returns the actual PR number and usable browser URL. Open the URL and verify source/target, title, creator, status, and draft state. Confirm there was exactly one PR created.

## Verify reads and safe metadata writes

- Retrieve the created PR by ID and list active PRs.
- Filter by both short and full ref names; check paging when practical.
- Update title/description and toggle draft state; compare results to the server UI.
- Clear description with `""` and change draft state with `false`.
- Invalid/missing branch and identical source/target inputs must create no PR.
- Completion, autocomplete, and policy bypass inputs must be rejected.
- Confirm expired or insufficient-scope PATs yield safe errors without credential/error-body leakage.
- Verify a second, unlisted repository cannot be read or modified even when the PAT can access it. Discovery must show only allowed repositories and their projects. Removing the allowlist disables all PR writes; setting it to `[]` denies all repository access.

## Repeat client validation

Run the core prompt from each MCP client you plan to claim as supported. Protocol compatibility tests alone do not demonstrate the actual client setup or agent behavior.

## Record evidence

```text
Date:
Azure DevOps Server edition/release/update/build:
Windows version:
REST version:
Node version:
MCP client/version:
Discovery and diagnostics: pass/fail
PR creation and working URL: pass/fail
PR read/list/filter/pagination: pass/fail
Title/description/draft updates: pass/fail
Rejected unsafe inputs: pass/fail
Credential-safe failures: pass/fail
Known limitations:
```

Use anonymized results. Do not record tokens, internal hostnames, or identifying project/repository/user information. After testing, manually abandon/close test PRs, remove disposable resources if desired, and revoke the PAT.
