# A free local Azure DevOps Server test lab

Research checked against Microsoft documentation on 2026-10-04. A local Express 2022.2 installation with Patch 12 and SQL Express has been configured successfully. All nine automated live stdio MCP checks passed using REST 7.0; the maintainer also reported successful Codex workflow testing. See the [recorded acceptance results](live-acceptance.md). Claude Code and other client workflows remain unverified.

## Recommended software

**Azure DevOps Server Express 2022.2 + SQL Server Express** on an existing, appropriately licensed Windows PC is the simplest durable personal lab. Microsoft describes Azure DevOps Server Express as free, with the same features as full Server and a licensing limit of five or fewer active users. The [official download matrix](https://learn.microsoft.com/en-us/azure/devops/server/download/azuredevopsserver?view=azure-devops) still lists Express 2022.2.

- [Express 2022.2 installer](https://go.microsoft.com/fwlink/?LinkId=2269947)
- [Express 2022.2 ISO](https://go.microsoft.com/fwlink/?LinkId=2269846)
- [2022.2 release notes and current patches](https://learn.microsoft.com/en-us/azure/devops/server/release-notes/azuredevops2022u2?view=azure-devops)

Choose **Express**, not the full Server evaluation installer. Follow the product’s license terms; this lab uses a single person and small disposable test repositories.

## Operating system and database

Microsoft’s [requirements](https://learn.microsoft.com/en-us/azure/devops/server/requirements?view=azure-devops-server) list Windows 11 **24H2** for Server 2022 personal/evaluation installs, and Windows Server 2019/2022 for server installs. The table does not establish support for every newer Windows client release. Check the PC’s exact Windows version before choosing direct installation.

SQL Server Express is a supported edition and is recommended for personal/evaluation use. A single server can run in a workgroup; an Active Directory domain is not required. Microsoft's general single-server recommendation is 8 cores, 16 GB RAM, and an SSD, sized for a much larger deployment than this lab; it is not a stated minimum for a one-user Express installation.

If you want a disposable VM without buying a Windows Server license, [Windows Server 2022 Evaluation](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-server-2022) is a temporary alternative: its evaluation expires after **180 days** and must be activated within the first ten days. The VM’s OS evaluation period is separate from Express licensing. It is not a permanent free Windows license.

## Installation outline

1. On the chosen Windows machine or VM, install Express 2022.2 and apply the current matching patches.
2. Select **New Deployment — Basic** in the configuration wizard.
3. Select the wizard’s option to install **SQL Server Express**. Skip optional search components for this repository/PR-only lab.
4. Record the final web URL and collection name shown by the wizard. Do not assume a particular port or `/tfs` path.
5. Open the web UI, create a test project and a Git repository, and push `develop` and a feature branch with a test commit.

The Basic deployment and automatic SQL Express option are documented in Microsoft’s [single-server setup guide](https://learn.microsoft.com/en-us/azure/devops/server/install/single-server?view=azure-devops-server).

## Connect this MCP server

Create a collection-scoped PAT for the test identity with Code (Read & write) and Project and Team (Read). Microsoft documents [PAT creation and REST authentication](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops). That page also notes that enabling **IIS Basic Authentication** invalidates PAT usage; do not enable IIS Basic Authentication to make a Basic-encoded PAT header work.

Set these process environment variables, replacing the URL/collection with the actual installation:

```dotenv
ADO_SERVER_URL=http://localhost:8080/tfs
ADO_COLLECTION=DefaultCollection
ADO_PROJECT=TestProject
ADO_ALLOWED_REPOSITORIES='[{"project":"TestProject","repository":"test-repository"}]'
ADO_AUTH_TYPE=pat
ADO_TOKEN=your-local-lab-PAT
ADO_API_VERSION=7.0
```

A workgroup lab cannot exercise `ADO_AUTH_TYPE=negotiate`: without a domain, Windows offers NTLM, which this server refuses. It can exercise `ADO_TOKEN_SOURCE=credential-manager`.

The URL above is an example, not a promised installer default. Local HTTP avoids initial certificate setup but sends the credential without encryption; keep this lab local or configure HTTPS.

Start with `7.0` to exercise the v0.1 default. Server 2022.2 can also use `7.1`; [Microsoft’s version mapping](https://learn.microsoft.com/en-us/rest/api/azure/devops/) says newer server releases support APIs from earlier mapped releases. Repeat with `7.1` if you want to validate both versions.

Build and register the stdio server following [README.md](../README.md), then run the [live acceptance checklist](live-acceptance.md). That gives us independent evidence of repository discovery, branch checks, PR creation, metadata updates, and a usable PR URL without connecting to a workplace server.

For v0.2, use an independent env file rather than changing an active registration. Add Work Items (Read & write) and Identity (Read) to a separate lab PAT, and configure both work-item project lists. Use unique `phase2-mcp-` resources and private reports. A second disposable project permits cross-project rejection checks without account ACL changes. The [Phase 2 guide](phase-2.md) describes permissions; the [acceptance runner](live-acceptance.md#repeat-phase-2-acceptance) leaves resources inspectable. Do not restart shared services or delete peer test resources during parallel work.
