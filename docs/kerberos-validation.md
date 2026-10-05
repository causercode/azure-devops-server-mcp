# Validating Kerberos (`ADO_AUTH_TYPE=negotiate`) on a workplace computer

> **This runs against a real, shared Azure DevOps Server under your own full identity.** Kerberos has no PAT scopes, so the process can do anything your account can. Keep this to the few **read-only** steps below. Run each step once. If a step fails, stop, record the error code, and do not retry in a loop. Do not create PRs, work items, comments or builds, and do not run `npm run test:live` or any `scripts/live-*.mjs` runner (they are for the loopback lab and refuse other servers). Follow your organization's rules for running scripts against internal systems.

Home-lab status: the credential-store PAT passed the connection check and a client `server_info` call. Kerberos could only be checked for its failure path there: the workgroup lab offered NTLM, which was refused with `NEGOTIATE_NTLM_UNSUPPORTED` before any request was sent. A successful Kerberos sign-in is still unverified.

## 0. Prerequisites (no traffic to Azure DevOps)

```powershell
whoami /upn          # a domain account, e.g. you@corp.example
klist                # should list a krbtgt/<REALM> ticket; if empty, sign out and back in
node --version       # 22.12+
```

If `whoami /upn` fails or `klist` has no `krbtgt` ticket, this machine cannot use Kerberos. Stop here.

## 1. Get the branch and build

```powershell
git clone https://github.com/causercode/azure-devops-server-mcp.git   # or: git fetch, in an existing clone
cd azure-devops-server-mcp
git checkout feature/auth-hardening
npm ci
npm run build
node -e "require('kerberos'); console.log('kerberos binding OK')"
```

`npm ci` builds the `kerberos` native binding because this repository approves its install script. If the last command fails, the binding is missing; record that and stop.

## 2. Check the SPN with the domain controller only

This asks the domain controller for a service ticket. It sends **nothing** to the Azure DevOps server. Use the host from your server URL:

```powershell
klist get HTTP/devops.example.com
```

- **Ticket returned:** the default SPN will work. Continue.
- **Error such as `0x7` (`KDC_ERR_S_PRINCIPAL_UNKNOWN`):** no SPN is registered for that name; the URL is probably an alias (DNS CNAME or load balancer). Try the server's real FQDN, if you know it, with `klist get HTTP/<real-host>`. If that works, set `ADO_KERBEROS_SPN=HTTP/<real-host>` in step 3. If nothing works, Kerberos is not configured for this server. Stop and use the PAT.

## 3. Create a Kerberos env file from your work configuration

Start from your existing `.env.work.local` (see [workplace quickstart](workplace-quickstart.md)). Remove the PAT, switch the auth type, and keep exactly **one** approved repository in the allowlist:

```powershell
Get-Content .env.work.local |
  Where-Object { $_ -notmatch '^ADO_(TOKEN|TOKEN_SOURCE|AUTH_TYPE)=' } |
  Set-Content .env.work-kerberos.local
Add-Content .env.work-kerberos.local 'ADO_AUTH_TYPE=negotiate'
# Only if step 2 needed a different host:
# Add-Content .env.work-kerberos.local 'ADO_KERBEROS_SPN=HTTP/real-host.corp.example'
notepad .env.work-kerberos.local
```

In the editor, confirm `ADO_ALLOWED_REPOSITORIES` lists a single repository you are allowed to read. Make sure `ADO_WORK_ITEM_WRITE_PROJECTS`, `ADO_BUILD_WRITE_REPOSITORIES` and `ADO_BUILD_WRITE_DEFINITIONS` are **absent**. In a fresh terminal, clear any inherited values: `Remove-Item Env:ADO_* -ErrorAction SilentlyContinue`.

## 4. Run the read-only connection check once

```powershell
node --env-file=.env.work-kerberos.local .\scripts\check-connection.mjs
```

This makes about five GET requests: diagnostics, one project page, the allowed repository, one branch page and one PR page. It never writes.

**Pass:** `"passed": true`, `"readOnly": true`. Then confirm the server ticket was used:

```powershell
klist | Select-String 'HTTP/'
```

**Fail:** record the `code` and stop.

| Code                         | Meaning                                                  | Next step                                                                                                                      |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `NEGOTIATE_UNAVAILABLE`      | Native `kerberos` binding missing                        | Repeat step 1's `npm ci`; if it persists, record npm's output                                                                  |
| `NEGOTIATE_FAILED`           | Windows could not create a ticket                        | Recheck step 0 (`klist`) and the SPN format                                                                                    |
| `NEGOTIATE_NTLM_UNSUPPORTED` | No Kerberos ticket for that SPN, so Windows offered NTLM | Revisit step 2; nothing was sent to the server                                                                                 |
| `HTTP_401`                   | The server rejected a valid Kerberos ticket              | Server-side IIS/SPN configuration (e.g. app-pool identity vs. SPN account). Not fixable from the client; stop and use the PAT. |
| `HTTP_403` / `HTTP_404`      | Authenticated, but your identity lacks access            | Pick a repository you can read in the browser                                                                                  |

## 5. Optional: one read-only prompt in a coding client

Only after step 4 passes. Register a **separate**, read-only entry pointing at this checkout. For Codex, use the README's `enabled_tools` read-only filter. Claude Code has no per-tool filter, so rely on the single-repository allowlist and the absent write lists, and decline any write tool call. Ask exactly one question:

> Use the Azure DevOps Server MCP to check connectivity and list the branches of my repository. Do not make changes.

`server_info` must report `authType: "negotiate"`. Remove the test registration afterwards.

## 6. Clean up and report back

Delete `.env.work-kerberos.local` if you won't keep using it; it contains no secret. Report anonymized results only, with no hostnames, SPNs or repository names:

```text
Date / Windows version / Node version:
Azure DevOps Server release (if known):
Step 2 klist get: default SPN | needed ADO_KERBEROS_SPN | failed
Step 4 connection check: pass | error code
Step 5 client prompt (optional): pass | fail | skipped
```
