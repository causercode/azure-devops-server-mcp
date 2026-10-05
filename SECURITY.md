# Security policy

v0.4 is a development line with recorded local Express / REST 7.0 acceptance. No npm release or broad server compatibility claim has been made.

## Report a vulnerability

Use [GitHub's private vulnerability reporting form](https://github.com/causercode/azure-devops-server-mcp/security/advisories/new). Maintainers must enable that facility before publishing source code to the public repository. If private reporting is unavailable, open an issue asking for a private contact channel without describing the vulnerability. Do not include a real PAT, private source code, internal server details, or vulnerability details in a public issue.

## Credential and access model

- The MCP process owns the credential. Supported modes: a PAT sent as Basic authentication with an empty username, read from `ADO_TOKEN` or the OS credential store (`ADO_TOKEN_SOURCE=credential-manager`); or Windows integrated Kerberos (`ADO_AUTH_TYPE=negotiate`), which stores no secret.
- A PAT is a bearer secret: anyone who copies it can use it from any machine until it expires. Prefer the OS credential store over plaintext env files or client configuration, short lifetimes, and the minimum scopes and repository permissions needed. The identity determines access; this server does not bypass policies or permissions.
- OS credential storage protects configuration files, but processes running as the same user can still retrieve the PAT. The Linux keyring binding may fall back from Secret Service to a volatile in-memory kernel keyring; persistent encrypted storage is not guaranteed on every platform. `auth status` reports presence only, not whether the PAT is valid at the server.
- `negotiate` removes the stored secret but grants this process the signed-in user's **full** Azure DevOps rights, with no scope restriction. The process-owned repository, work-item and build allowlists then become the main restriction; keep them narrow. NTLM is refused rather than attempted. Generated authorization values and their encoded forms are captured within each tool call and redacted from its results/errors. They are released after that call, not retained in a growing process-wide ticket list; use HTTPS.
- Repository writes (including discussions/reviewers) require an explicit `ADO_ALLOWED_REPOSITORIES` list in process configuration. Without it, writes fail before repository HTTP requests. When configured, every repository read/write and discovery operation is restricted to allowed entries; `[]` denies all repository access. Scope cannot be overridden by MCP tool arguments. There is no automatic ownership inference.
- Work items use independent `ADO_ALLOWED_WORK_ITEM_PROJECTS` and `ADO_WORK_ITEM_WRITE_PROJECTS` process-owned lists. Both default to deny-all; writes require membership in both. ADO_PROJECT, repository authorization and PAT scopes grant no work-item permission. Each ID/batch/query result is checked against the canonical selected project. An unauthorized batch returns no partial data.
- Links require same-project authorization on both sides. PR linking additionally requires repository write scope and a verified PR. No arbitrary artifact/hyperlink/attachment URLs can be written or followed. Link inspection suppresses unsupported/out-of-scope relations; unknown targets are not exposed.
- Build queueing additionally requires `ADO_BUILD_WRITE_REPOSITORIES` and `ADO_BUILD_WRITE_DEFINITIONS`; both default to deny-all, with explicit repository read approval also required. Only reviewed enabled classic definitions at an explicit branch HEAD commit are queueable. PR/work-item permissions and broad PAT scopes do not authorize builds. Build/definition IDs verify the actual project/TfsGit source; YAML diagnostics verify a single resolved self repository. Logs/tests validate their enclosing build/run before exposure.
- Pin project/repository GUIDs for a stable identity boundary. Name-based entries follow the current name, which can be reassigned after deletion/recreation. The allowlist supplements ADO permissions and applies only to this MCP server, not separate Git/shell access or another integration.
- Tools expose capabilities, never a credential retrieval endpoint. Safe diagnostics use an allowlist.
- Raw HTTP error bodies and arbitrary exception messages do not reach clients. Known raw, URL-encoded, JSON-escaped, and Basic-encoded forms of the configured PAT are redacted in tool responses. The `auth` CLI never prints a stored PAT.
- The configured request timeout bounds authentication acquisition as well as HTTP traffic. A timed-out native ticket operation may finish in the background, but its late result cannot dispatch a request. Authentication timeouts report that no HTTP request was sent; dispatched write timeouts retain uncertain-outcome recovery guidance.
- HTTP redirects are not followed. Configure the final server root/collection and use HTTPS where possible.
- TLS verification remains enabled. Configure your CA using Node’s supported trust mechanisms.
- Do not commit `.env` or client configurations containing credentials, or put credentials in prompts. A local client or agent that can read process environments or secret files still has that access independently of this MCP server.

## Write boundary

Writes include PR creation/metadata, discussions and reviewer add/remove, work-item fields/comments, same-project work-item/PR links, and separately approved classic build queueing. Reviewer assignment accepts an explicit verified active-person GUID; searches never choose among ambiguous names. Re-adding an existing reviewer preserves their vote. Completion, merge, autocomplete, approval voting, deletion, force push, rule/policy bypass, permissions, definition creation/editing, arbitrary parameters/YAML execution, stage control, release/deployment operations, manual test management, and administrative APIs are not exposed. Unknown and action-inappropriate input fields are rejected. MCP annotations describe intent; the client controls confirmations and trust policy.

PR update checks the selected repository's PR before issuing PATCH. Returned PRs must belong to the selected project's repository; unrelated PR data is withheld. All repository selection passes through the same configured scope resolver, which queries only configured entries when restricted.

Work-item fields and link updates require the observed source revision, checked before writing and with `test /rev` on the server to catch races. Protected project/ID/type/audit fields cannot be changed. Area/iteration paths must stay in the selected project. Concurrent changes on the other side of a link are not an atomic transaction; server rules and permissions remain authoritative.

WIQL is a limited flat read query, normalized to ID projection with an injected project condition around the whole WHERE expression. Returned IDs are independently project-verified. Recursive/link/ASOF queries and saved-query mutations are excluded. WIQL and batch read POSTs are identified as reads in transport errors.

After uncertain writes, inspect the relevant PR, thread, reviewer list, work item, comments, links or builds for the same definition/ref/commit before retrying. No HTTP write retries run automatically. Revision conflicts require a fresh read and review of the intended change. Do not reuse a stale revision blindly.

## Untrusted remote data

The v0.4 MCP prompts return local guidance only. Retrieving a prompt does not contact Azure DevOps, authorize writes or change any process-owned scopes. Workflow selectors are JSON data, not shell commands. All remote operations still pass through the existing scoped tools. Local Git, implementation and tests remain client-owned. Missing CI, stale commits, incomplete review and lack of human approval must be reported explicitly; a prompt never authorizes merge/completion or automatic write retries.

Project/repository names, titles, descriptions, and other remote text may contain misleading instructions. Clients must treat returned content as data. Output normalization limits fields; it does not establish the trustworthiness of their text.

Build log text is read through constructed API paths with bounded excerpts and streamed byte limits; server-provided download URLs and redirects are never followed. Automated failure lists expose short summaries; explicit detail reads remain bounded. Logs and failure messages can contain secrets beyond the process PAT, so clients should request minimal content. Output redaction cannot establish that arbitrary build content is secret-free. See [pipeline contracts](docs/pipelines.md).
