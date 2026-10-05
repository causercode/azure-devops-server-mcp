# Inspecting a workplace Azure DevOps Server

The hierarchy is **server → collection → project → Git repository → branches/PRs**. Many companies keep all Git repositories in one shared project. That arrangement fits this MCP server: set the collection once, use `ADO_PROJECT` as the default, and select each repository by name or ID.

`ADO_PROJECT` is a default, not an access boundary. For a shared project, configure `ADO_ALLOWED_REPOSITORIES` with only the repositories you approve. Prefer the project/repository IDs from the inventory report:

```dotenv
ADO_ALLOWED_REPOSITORIES='[{"project":"11111111-1111-1111-1111-111111111111","repository":"22222222-2222-2222-2222-222222222222"}]'
```

Those are fictional IDs; replace them with your actual project/repository IDs. Each user chooses their own list. The MCP does not infer ownership. Without a configured list, reads follow ADO permissions but all PR writes are disabled; with a list, all repository reads and writes are restricted to its entries. The standalone inventory script below is separate and can list all visible repositories in the selected project.

Before connecting at work, collect:

1. **Collection URL.** From a repository web URL like `https://devops.example.com/tfs/DefaultCollection/SharedProject/_git/MyRepo`, the server root is `https://devops.example.com/tfs`, collection is `DefaultCollection`, project is `SharedProject`, and repository is `MyRepo`. Installations can have another virtual-directory path or none at all.
2. **Server version/update/build.** Check Help/About in the web UI. Record the exact build if shown; API acceptance alone does not establish the server release.
3. **Authentication.** Check whether User settings → Personal access tokens is available. If it is, use a PAT, preferably stored with `auth set-token` (see [Authentication options](../README.md#authentication-options)). If PATs are disabled, `ADO_AUTH_TYPE=negotiate` can use Windows sign-in, but only via Kerberos: a successful browser sign-in may have used NTLM and does not prove Kerberos works.
4. **Permissions.** Confirm that your identity can read repositories/branches and create/edit PRs. PAT scopes cannot exceed the identity's repository permissions. No merge or administrative permissions are needed for the MCP tools.
5. **Network/TLS.** Note whether access requires VPN and whether the server's certificate is issued by an internal CA. Node may need the CA configured separately from Windows/browser trust.
6. **Branch conventions.** Record the actual target branch, such as `develop`, `main`, or a release branch, and whether your source branch must first be pushed to the server.

## Read-only inventory script

On the work computer, run the supplied script with your normal Windows identity:

```powershell
.\scripts\inspect-ado-server.ps1 `
  -CollectionUrl 'https://devops.example.com/tfs/DefaultCollection' `
  -Project 'SharedProject' `
  -OutputPath "$env:TEMP\ado-configuration.json"
```

You only need a copy of `scripts/inspect-ado-server.ps1`; Node, npm, and the MCP server do not need to be installed to run it. Omit `-Project` to inventory all projects visible to your identity.

The script performs GET requests using Windows integrated authentication, tries REST 7.0/6.0/5.0 on version rejection, follows project pagination, and returns a limited project/repository inventory. It uses no PAT and makes no writes. Redirects are rejected. It does not return auth headers, cookies, or raw exception bodies.

Run it within your organization's normal rules for scripts and internal data; an authentication or execution-policy failure should be recorded rather than worked around. The generated report contains internal hostnames and repository names, so redact those before sharing outside your organization. The useful summary for this project is server build, URL structure, one-project versus multiple-project layout, PAT availability, and branch conventions.
