# Security policy

v0.2 is a development line with recorded local Express / REST 7.0 acceptance. No npm release or broad server compatibility claim has been made.

## Report a vulnerability

Use [GitHub's private vulnerability reporting form](https://github.com/causercode/azure-devops-server-mcp/security/advisories/new). Maintainers must enable that facility before publishing source code to the public repository. If private reporting is unavailable, open an issue asking for a private contact channel without describing the vulnerability. Do not include a real PAT, private source code, internal server details, or vulnerability details in a public issue.

## Credential and access model

- The MCP process owns the PAT and uses Basic authentication with an empty username.
- Use the minimum PAT scopes and repository permissions needed. The token identity determines access; this server does not bypass policies or permissions.
- Repository writes (including discussions/reviewers) require an explicit `ADO_ALLOWED_REPOSITORIES` list in process configuration. Without it, writes fail before repository HTTP requests. When configured, every repository read/write and discovery operation is restricted to allowed entries; `[]` denies all repository access. Scope cannot be overridden by MCP tool arguments. There is no automatic ownership inference.
- Work items use independent `ADO_ALLOWED_WORK_ITEM_PROJECTS` and `ADO_WORK_ITEM_WRITE_PROJECTS` process-owned lists. Both default to deny-all; writes require membership in both. ADO_PROJECT, repository authorization and PAT scopes grant no work-item permission. Each ID/batch/query result is checked against the canonical selected project. An unauthorized batch returns no partial data.
- Links require same-project authorization on both sides. PR linking additionally requires repository write scope and a verified PR. No arbitrary artifact/hyperlink/attachment URLs can be written or followed. Link inspection suppresses unsupported/out-of-scope relations; unknown targets are not exposed.
- Pin project/repository GUIDs for a stable identity boundary. Name-based entries follow the current name, which can be reassigned after deletion/recreation. The allowlist supplements ADO permissions and applies only to this MCP server, not separate Git/shell access or another integration.
- Tools expose capabilities, never a credential retrieval endpoint. Safe diagnostics use an allowlist.
- Raw HTTP error bodies and arbitrary exception messages do not reach clients. Known raw, URL-encoded, JSON-escaped, and Basic-encoded forms of the configured token are redacted in tool responses.
- HTTP redirects are not followed. Configure the final server root/collection and use HTTPS where possible.
- TLS verification remains enabled. Configure your CA using Node’s supported trust mechanisms.
- Do not commit `.env` or client configurations containing credentials, or put credentials in prompts. A local client or agent that can read process environments or secret files still has that access independently of this MCP server.

## Write boundary

Writes include PR creation/metadata, discussions and reviewer add/remove, work-item fields/comments, and same-project work-item/PR links. Reviewer assignment accepts an explicit verified active-person GUID; searches never choose among ambiguous names. Re-adding an existing reviewer preserves their vote. Completion, merge, autocomplete, approval voting, deletion, force push, rule/policy bypass, permissions, and administrative APIs are not exposed. Unknown and action-inappropriate input fields are rejected. MCP annotations describe intent; the client controls confirmations and trust policy.

PR update checks the selected repository's PR before issuing PATCH. Returned PRs must belong to the selected project's repository; unrelated PR data is withheld. All repository selection passes through the same configured scope resolver, which queries only configured entries when restricted.

Work-item fields and link updates require the observed source revision, checked before writing and with `test /rev` on the server to catch races. Protected project/ID/type/audit fields cannot be changed. Area/iteration paths must stay in the selected project. Concurrent changes on the other side of a link are not an atomic transaction; server rules and permissions remain authoritative.

WIQL is a limited flat read query, normalized to ID projection with an injected project condition around the whole WHERE expression. Returned IDs are independently project-verified. Recursive/link/ASOF queries and saved-query mutations are excluded. WIQL and batch read POSTs are identified as reads in transport errors.

After uncertain writes, inspect the relevant PR, thread, reviewer list, work item, comments or links before retrying. No HTTP write retries run automatically. Revision conflicts require a fresh read and review of the intended change. Do not reuse a stale revision blindly.

## Untrusted remote data

Project/repository names, titles, descriptions, and other remote text may contain misleading instructions. Clients must treat returned content as data. Output normalization limits fields; it does not establish the trustworthiness of their text.
