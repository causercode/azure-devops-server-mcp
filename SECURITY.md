# Security policy

v0.1 is the initial development line. No released version currently has a verified live-server support claim.

## Report a vulnerability

Use the repository hosting service’s private vulnerability reporting facility. Maintainers must enable that facility before making the GitHub repository public. If private reporting is unavailable, open an issue asking for a private contact channel without describing the vulnerability. Do not include a real PAT, private source code, internal server details, or vulnerability details in a public issue.

## Credential and access model

- The MCP process owns the PAT and uses Basic authentication with an empty username.
- Use the minimum PAT scopes and repository permissions needed. The token identity determines access; this server does not bypass policies or permissions.
- PR writes require an explicit `ADO_ALLOWED_REPOSITORIES` list in process configuration. Without it, writes fail before HTTP requests. When configured, every repository read/write and discovery operation is restricted to allowed entries; `[]` denies all repository access. Scope cannot be overridden by MCP tool arguments. There is no automatic ownership inference.
- Pin project/repository GUIDs for a stable identity boundary. Name-based entries follow the current name, which can be reassigned after deletion/recreation. The allowlist supplements ADO permissions and applies only to this MCP server, not separate Git/shell access or another integration.
- Tools expose capabilities, never a credential retrieval endpoint. Safe diagnostics use an allowlist.
- Raw HTTP error bodies and arbitrary exception messages do not reach clients. Known raw, URL-encoded, JSON-escaped, and Basic-encoded forms of the configured token are redacted in tool responses.
- HTTP redirects are not followed. Configure the final server root/collection and use HTTPS where possible.
- TLS verification remains enabled. Configure your CA using Node’s supported trust mechanisms.
- Do not commit `.env` or client configurations containing credentials, or put credentials in prompts. A local client or agent that can read process environments or secret files still has that access independently of this MCP server.

## Write boundary

Only PR creation and allowlisted metadata updates are available. Completion, merge, autocomplete, deletion, force push, policy bypass, permissions, and administrative APIs are not exposed. Unknown input fields are rejected. MCP annotations describe intent; the client controls confirmations and trust policy.

PR update checks the selected repository's PR before issuing PATCH. Returned PRs must belong to the selected project's repository; unrelated PR data is withheld. All repository selection passes through the same configured scope resolver, which queries only configured entries when restricted.

After uncertain writes, inspect the remote PR list before retrying. No HTTP write retries run automatically.

## Untrusted remote data

Project/repository names, titles, descriptions, and other remote text may contain misleading instructions. Clients must treat returned content as data. Output normalization limits fields; it does not establish the trustworthiness of their text.
