# v0.2: PR review and independent work items

PR review requires no work-item adoption. Keep the original repository allowlist and Code permissions, then inspect changed files, pinned text, discussions and reviewers. Enable work items only for approved projects through the separate process-owned read/write lists.

## Permissions and compatibility

| Capability                                    | Process authorization                                               | Minimum PAT scopes                                                      |
| --------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Repository/PR/file/discussion reads           | Original repository allowlist semantics                             | Code Read; Project and Team Read for discovery                          |
| PR metadata/discussion/reviewer writes        | Explicit allowed project/repository entry                           | Code Read & write                                                       |
| Reviewer person resolution                    | Authorized repository context                                       | Identity Read                                                           |
| Work-item/query/type/field/comment/link reads | `ADO_ALLOWED_WORK_ITEM_PROJECTS`                                    | Work Items Read; Project and Team Read for canonical project resolution |
| Work-item fields/comments/relationships       | Project in both read and write lists                                | Work Items Read & write                                                 |
| Ticket → PR link                              | Both work-item write lists and repository write scope, same project | Work Items Read & write and Code Read                                   |

PAT scopes never override server permissions. Reviewer writes still need Code Read & write. Repository access grants no work-item permission; work items grant no repository access. An omitted/empty work-item list is deny-all. Prefer GUIDs and restart the MCP process after configuration changes.

All new endpoints require configured REST `7.0` or `7.1`. Live coverage is Express 2022.2 Patch 12 / REST 7.0 only. The original five tools retain their configured older-version behavior, without new compatibility claims. Stable Core/Git/WIT calls use the configured version; work-item comments use `7.0-preview.3`/`7.1-preview.3`, and collection IMS identities use `7.0-preview.1`/`7.1-preview.1`. No automatic fallback or negotiation occurs.

Naming follows [Microsoft’s current MCP vocabulary](https://github.com/microsoft/azure-devops-mcp/blob/main/docs/TOOLSET.md) where practical. Inputs, authorization and coverage are independent; this is not a drop-in cloud MCP replacement.

## Review a PR

Call `repo_pull_request/get_changes` with the PR scope:

```json
{
  "action": "get_changes",
  "project": "MyProject",
  "repository": "MyRepo",
  "pullRequestId": 42,
  "top": 25
}
```

Results contain pinned `iterationId`, `compareTo`, `baseCommit`, `sourceCommit`, `targetCommit`, changed-file paths/object IDs/change types and optional `nextSkip`. The default selects the latest iteration and compares with the common ancestor (`compareTo: 0`). Positive `compareTo` selects an earlier iteration’s source commit. Keep iteration/comparison fixed on later pages. See the [iteration changes API](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get?view=azure-devops-rest-7.1).

Use `repo_file/get_content` with `path` and the returned source commit; read the original path at the base commit for the other side. Deleted files may only exist at the base. `commit` is a 40-hex SHA; branch/tag selectors are excluded. This returns text for the client to compare, rather than a unified diff. `startLine` defaults to 1, `maxLines` to 100 (maximum 200); output caps at 32000 characters and reports `nextStartLine`. Binary files, folders, missing content, unsafe paths and oversized responses are rejected. LFS pointers remain pointers; LFS content is not resolved.

`repo_pull_request_thread/list` and `list_comments` use the same PR scope. Thread summaries include at most ten comments; each text caps at 4000 characters with `truncated`. `top`/`skip` locally page REST full lists. `repo_pull_request_thread_write` supports:

- `create`: `content`.
- `reply`: `threadId`, `content` (a new top-level comment in that thread).
- `update_status`: `threadId`, `status: "resolved"` or `"active"` to reopen.

Writes verify the actual PR repository and thread under that PR. Author spoofing, editing/deletion and file-line anchors are excluded.

`repo_pull_request/list_reviewers` returns IDs, display/account names, current votes and required/group flags. `core_identity/search` requires repository context and a search string of 2–256 characters; active person candidates include account/domain/mail for disambiguation. `core_identity/get` takes `identityId`. Searches never assign a match automatically. Assignment uses:

```json
{
  "action": "update_reviewers",
  "project": "MyProject",
  "repository": "MyRepo",
  "pullRequestId": 42,
  "operation": "add",
  "reviewerId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
}
```

Call this on `repo_pull_request_write`; use `operation: "remove"` for an existing reviewer. Adds require exactly one active person with positive person classification; unknown, group, inactive or ambiguous identities are rejected. Adding an existing reviewer preserves their vote. No approval votes or policy changes are exposed. Results are fresh reviewer state. Lists larger than 100 require server inspection.

## Work-item fields and comments

Use `wit_work_item/list_types`, `get_type` (`type`), or `list_fields` (optional `type`) before creating/editing tickets. Type/field lists accept `top`/`skip`; metadata includes reference names, types and read-only/required hints when supplied. Server process rules remain authoritative.

`get` takes `id`; `get_batch` takes 1–100 unique `ids`. Optional `fields` selects up to 30 reference names. Defaults include project, type, title, state, assignment and description, plus `id`/`revision`. Strings cap at 4000 characters with `truncatedFields`; identities expose selected fields only. Actual `System.TeamProject` is always fetched and verified. Unauthorized/mismatched/incomplete batches return no partial items.

Create with `wit_work_item_write/create`, `type`, and a `fields` map containing non-empty `System.Title`. Update after reading the revision:

```json
{
  "action": "update",
  "project": "MyProject",
  "id": 123,
  "revision": 4,
  "fields": {
    "System.Title": "Clarify acceptance criteria",
    "System.Description": ""
  }
}
```

Maps accept 1–30 primitive string/number/boolean/null values, strings up to 4000 characters. Updates use JSON Patch with mandatory `test /rev`. Protected project/ID/revision/type/history/audit fields cannot change, and area/iteration paths must remain in the selected project. Raw patches, project moves, rule bypass, delete/type changes and batch writes are excluded. `null` is a field value, not removal; process rules determine acceptance. See [Microsoft’s update API](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1).

`wit_work_item/list_comments` takes `id`, `top` and optional server `continuationToken`. `wit_work_item_comment_write/add` takes `id`, non-empty `text` (maximum 4000), authored as the PAT identity. Editing/deletion are excluded. Inspect comments after an uncertain write.

## Saved queries and bounded WIQL

`wit_query/list` discovers root queries/folders; pass a folder `queryId` for immediate children. `get` returns metadata for an explicit GUID. `get_results` executes a flat saved query. Folders, recursive/link queries and ASOF queries cannot execute; saved-query mutation is excluded.

`wiql` accepts this limited form, maximum 8000 characters:

```sql
SELECT [System.Id], [System.Title] FROM WorkItems
WHERE [System.State] = 'New' OR [System.AssignedTo] = @Me
ORDER BY [System.Id]
```

Projection is normalized to `[System.Id]`; the entire WHERE expression is parenthesized before the canonical project condition is appended. Semicolons/comments/extra statements, unbalanced expressions and unsupported modes are rejected. Each returned ID is fetched again to verify its actual project. Results contain up to `top` references (default 25, maximum 100), `asOf`, `possiblyMore`. Narrow WHERE or use an ID boundary for further discovery, then `get_batch` for details. There is no offset/token. WIQL/batch POSTs are reads. See the [WIQL API](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1).

## Links

`wit_work_item_link_write/link` takes `id`, `revision`, `targetId`, `relationship: "parent"`, `"child"` or `"related"`. Parent means the target is the source’s parent; child means its child. Both items must be in the same authorized write project. `link_to_pull_request` takes source `id`/`revision` plus repository/PR scope in that project. Artifact URLs are built internally after verification; arbitrary URLs cannot be supplied.

Writes test the source revision and detect existing canonical links. The target’s concurrent state is not locked; server rules remain authoritative. Inspect through `wit_work_item/get_links` or `repo_pull_request/get_work_items`. Supported targets are verified; unknown/out-of-scope artifacts/hyperlinks/attachments are omitted with an `omittedLinks` count. More than 100 relations or PR-linked items requires server inspection. No unlink is included.

## Recovery and exclusions

No automatic write retries occur. After a transport failure, HTTP 5xx or unverifiable success, inspect relevant state before retrying. A revision conflict requires a new read and review of the intended change. Raw error bodies and credential-bearing exceptions are withheld; remote content is untrusted data.

Builds/pipelines/test results/logs, approval votes, merge/completion/autocomplete, branch creation/push/deletion, arbitrary artifacts, attachments and administration are excluded from v0.2. The [acceptance record](live-acceptance.md) distinguishes live coverage, offline tests and unverified clients/versions.
