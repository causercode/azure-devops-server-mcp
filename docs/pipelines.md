# Pipeline, build and automated-test diagnostics

These tools help diagnose CI failures without adopting Boards. They use Azure DevOps Server's Build and Test REST APIs and require configured REST **7.0 or 7.1**. Earlier configured versions retain the original repository/PR tools. Naming follows Microsoft's [current toolset](https://github.com/microsoft/azure-devops-mcp/blob/main/docs/TOOLSET.md) where practical; this is an independent contract.

## Permissions and source boundaries

Use Code Read, Project and Team Read, Build Read (`vso.build`) and Test Management Read (`vso.test`) for diagnostics. Queueing needs Build Read & execute (`vso.build_execute`). PAT scopes and server ACLs both apply; with `ADO_AUTH_TYPE=negotiate` only server ACLs and the process-owned approvals below apply. See the [Build API](https://learn.microsoft.com/en-us/rest/api/azure/devops/build/builds/queue?view=azure-devops-rest-7.1) and [Test API](https://learn.microsoft.com/en-us/rest/api/azure/devops/test/results/list?view=azure-devops-rest-7.1).

`ADO_ALLOWED_REPOSITORIES` restricts all pipeline/build/log/test reads when configured. Every tool selects a repository by name or GUID and an optional project; `ADO_PROJECT` supplies the default. Definition and build IDs are checked against their actual project and TfsGit repository. Logs and timelines are read only under a validated build. Automated runs must belong to that build and project; each result must belong to the validated run and project.

Classic build diagnostics verify the definition's source, using its recorded revision when available. YAML diagnostics additionally verify the run's resolved repository resources: exactly one `self` Azure Repos Git resource must match the selected repository, branch and commit. Multiple repositories, TFVC, GitHub, unknown execution processes or unverifiable YAML resources fail closed. Definition discovery reports primary-source metadata only; it does not authorize reading a run with additional resources. Scripts may access other systems outside declared repository resources; these checks do not inspect every task's behavior.

## Tools and inputs

All inputs reject unknown fields and arguments irrelevant to the selected action. IDs are positive int32 values. Each tool requires `repository`; `project` is optional.

| Tool                                       | Actions                                              | Additional inputs                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipelines_definition`                     | `list`, `get`                                        | List: optional `name`, `top`, `continuationToken`. Get: `definitionId`.                                                                                                    |
| `pipelines_build`                          | `list`, `get_status`, `get_timeline`                 | List: optional `definitionId`, `branch`, `commit`, `status`, `result`, `top`, `continuationToken`. Get: `buildId`. Timeline: `buildId`, optional `top`, `skip`.            |
| `pipelines_run`                            | `list`, `get`                                        | `definitionId` required. List uses build filters and paging. Get also requires `runId`.                                                                                    |
| `pipelines_build_log`                      | `list`, `get_content`                                | `buildId` required. List: optional `top`, `skip`. Content: `logId`, optional `startLine`, `startColumn`, `maxLines`.                                                       |
| `testplan_show_test_results_from_build_id` | `list_runs`, `get_run`, `list_results`, `get_result` | `buildId` required. Run/result actions require `runId`; get_result also requires `resultId`. List actions accept `top`, `skip`; list_results optionally filters `outcome`. |
| `pipelines_write`                          | `run_pipeline`                                       | `definitionId`, `branch`, `commit` required; existing reviewed classic definitions only.                                                                                   |

`pipelines_run` uses Server Build IDs as run IDs and Build definition IDs as pipeline IDs. Its output matches the build summary; it does not emulate the cloud Pipelines response. Build summaries include status/result, definition, source branch/commit, project/repository IDs and available timestamps. Definition summaries omit variables and executable process payloads. Timeline output includes task states/results, selected issues and log IDs.

Build `status`: `notStarted`, `inProgress`, `completed`, `cancelling`, `postponed`, `none`. Build `result`: `succeeded`, `partiallySucceeded`, `failed`, `canceled`, `none`. Test `outcome` supports Passed/Failed and the other documented Test result outcomes shown in the advertised input schema. A run may have no results yet.

For example, diagnose a selected build:

```json
{ "action": "get_status", "repository": "MyApplication", "buildId": 123 }
```

Call `pipelines_build/get_timeline` to locate a failed task's log ID, then:

```json
{
  "action": "get_content",
  "repository": "MyApplication",
  "buildId": 123,
  "logId": 5,
  "startLine": 1,
  "maxLines": 50
}
```

## Paging and output limits

List `top` defaults to 25, range 1–100. Definition/build/run lists preserve the server's `continuationToken`; keep all filters unchanged. Commit filtering is applied within each server page, so an empty page can still have a token. Timeline/log inventories use local `skip`/`nextSkip`; automated Test lists use REST `$skip`/`$top`. A full Test page may advertise a final empty page. `skip` is limited to 1,000,000 and opaque tokens to 4096 characters.

Log `startLine` is one-based; `maxLines` defaults to 50, range 1–200. Content is limited to 16,000 UTF-16 characters and a 64 KiB streamed REST response. Pass both `nextStartLine` and `nextStartColumn` to continue a partial line. `characterTruncated` distinguishes character clipping; `truncated` also covers later lines. Oversized responses fail explicitly; reduce `maxLines`. A single line exceeding the transport byte budget cannot be read through this tool. No download URLs or redirects are followed.

Timeline issues are limited to 20 per record and 2000 characters per message, with a page budget of 40 issues and 16,000 message characters and explicit truncation flags. Test lists expose error summaries of at most 500 characters and omit stack text; get_result exposes error and stack details of at most 4000 characters each, with separate truncation flags. Ordinary labels are shortened to 400 characters. JSON transport responses have an 8 MiB maximum. This is diagnostic text access, not artifact or attachment downloading.

## Explicit build execution

Queueing is denied by default. Configure **all three** process-owned lists:

```dotenv
ADO_ALLOWED_REPOSITORIES='[{"project":"MyProject","repository":"MyApplication"}]'
ADO_BUILD_WRITE_REPOSITORIES='[{"project":"MyProject","repository":"MyApplication"}]'
ADO_BUILD_WRITE_DEFINITIONS=[42]
```

Review each approved classic definition's tasks, credentials, agents and side effects before adding its ID. Read access is still required and the actual definition source must match the selected repository. Broad PAT permissions, PR write permission and work-item permission do not authorize build execution. Tool arguments cannot change these lists.

```json
{
  "action": "run_pipeline",
  "repository": "MyApplication",
  "definitionId": 42,
  "branch": "feature/example",
  "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

The commit must match the current remote branch HEAD. The queue request supplies the validated definition ID/revision and explicit ref/commit. There are no runtime/template parameters, YAML overrides, pool overrides, demands or script arguments. Only enabled classic build processes are supported for queueing. YAML queueing needs further source/template review and is outside this initial contract.

The response separates `queueAccepted: true` from `completionVerified: false`. Poll `pipelines_build/get_status` to establish completion. The server never automatically retries a queue request. After a timeout, connection failure, HTTP 5xx or unverifiable successful response, list builds for the same definition/ref/commit before considering another queue request. Definitions or branches can change between preflight and queueing; ADO remains authoritative.

Definition creation/editing, agent/pool administration, release/deployment operations, stage cancellation/retry, manual test-plan execution and binary artifacts are outside these tools.

## Live acceptance

Build the CLI and run the guarded script with your **ignored local** lab env file:

```powershell
npm run build
node --env-file=C:/private/lab.env scripts/live-pipelines.mjs
```

Set `ADO_PHASE3_REPOSITORY` to exactly one disposable approved repository. Optional `ADO_PHASE3_EXCLUDED_REPOSITORY` checks denial. Without a build ID, the runner verifies discovery only. Set `ADO_PHASE3_BUILD_ID` to inspect an existing build, plus `ADO_PHASE3_EXPECT_TEST_RESULTS=1` when it should contain an intentional automated failure. Reports default to ignored `live-pipelines.local.json`; they contain check names and IDs, never raw logs or test messages.

To test queueing, configure the separate build scopes above, `ADO_PHASE3_QUEUE=1`, `ADO_PHASE3_DEFINITION_ID`, `ADO_PHASE3_BRANCH`, `ADO_PHASE3_COMMIT`, and `ADO_PHASE3_AGENT_READY=1` after confirming the disposable agent is online. Queueing and an existing build ID are mutually exclusive. The runner queues once and saves the accepted ID immediately. Default completion wait is 180 seconds; `ADO_PHASE3_WAIT_MS` changes it. Resume a failed verification using the saved build ID with queueing disabled. Do not requeue to recover a verification failure.

The runner refuses non-loopback servers and never creates definitions, installs agents, edits policies or configures credentials. Existing reviewed fixtures and user-managed agents are prerequisites. Offline HTTP/MCP/stdio tests exercise the runner and failure boundaries without a real PAT.

Live stdio acceptance passed on Azure DevOps Server Express 2022.2 Patch 12 / REST 7.0. One reviewed disposable classic build was queued at an explicit branch/commit and completed with an intentional test failure. Nine resumed diagnostic groups passed against that same build: tool discovery, repository names/GUIDs, definition/build discovery, excluded-repository denial, status, definition/run mapping, bounded timeline, bounded log text/continuation and automated run linkage/failure details. No duplicate queue was used to recover validation. The initial run exposed sparse Server test-run lists; each listed ID is now resolved before checking actual project/build association. REST 7.1, YAML live diagnostics and other server installations remain unverified. The original v0.1 PR acceptance remains recorded separately in [live-acceptance.md](live-acceptance.md).
