#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [uri]$CollectionUrl,
    [string]$Project,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
if ($CollectionUrl.Scheme -notin @('http', 'https') -or $CollectionUrl.UserInfo -or $CollectionUrl.Query -or $CollectionUrl.Fragment) {
    throw 'Provide the collection URL without credentials, query parameters, or fragments.'
}
$collectionBase = $CollectionUrl.AbsoluteUri.TrimEnd('/')

function Get-AdoPage {
    param([string]$Path, [string]$Version, [string]$ContinuationToken)
    $query = 'api-version=' + [uri]::EscapeDataString($Version)
    if ($ContinuationToken) { $query += '&continuationToken=' + [uri]::EscapeDataString($ContinuationToken) }
    $response = Invoke-WebRequest -Uri "$collectionBase/$Path`?$query" -UseDefaultCredentials -UseBasicParsing -MaximumRedirection 0 -Headers @{ Accept = 'application/json' }
    if ($response.Headers['Content-Type'] -notmatch 'application/(?:[\w.+-]+\+)?json') { throw 'The server returned a login page or other non-JSON response.' }
    [pscustomobject]@{
        Data = ($response.Content | ConvertFrom-Json)
        ContinuationToken = $response.Headers['x-ms-continuationtoken']
        ProductVersion = $response.Headers['x-tfs-product-version']
    }
}

# Reads only. Never creates a PAT, project, repository, branch, or PR.
$firstPage = $null
$apiVersion = $null
foreach ($version in @('7.0', '6.0', '5.0')) {
    try {
        $firstPage = Get-AdoPage -Path '_apis/projects' -Version $version
        $apiVersion = $version
        break
    } catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        if ($status -ne 400) {
            throw "Collection request failed (HTTP $status). Check the collection URL, Windows sign-in, and access. Redirects are not followed."
        }
    }
}
if (-not $firstPage) { throw 'None of REST 7.0, 6.0, or 5.0 was accepted by the projects endpoint.' }

$projects = @($firstPage.Data.value)
$page = $firstPage
$seenTokens = @{}
while ($page.ContinuationToken) {
    if ($seenTokens.ContainsKey($page.ContinuationToken) -or $seenTokens.Count -ge 100) { throw 'Project pagination did not converge.' }
    $seenTokens[$page.ContinuationToken] = $true
    $page = Get-AdoPage -Path '_apis/projects' -Version $apiVersion -ContinuationToken $page.ContinuationToken
    $projects += @($page.Data.value)
}

$selectedProjects = if ($Project) {
    @($projects | Where-Object { $_.name -eq $Project -or $_.id -eq $Project })
} else { $projects }
if ($Project -and $selectedProjects.Count -eq 0) { throw 'The specified project was not found among projects visible to this identity.' }

$inventory = @(
    foreach ($item in $selectedProjects) {
        $repositories = Get-AdoPage -Path (([uri]::EscapeDataString($item.id)) + '/_apis/git/repositories') -Version $apiVersion
        [ordered]@{
            project = $item.name
            projectId = $item.id
            repositoryCount = @($repositories.Data.value).Count
            repositories = @($repositories.Data.value | ForEach-Object {
                [ordered]@{ name = $_.name; id = $_.id; defaultBranch = $_.defaultBranch }
            })
        }
    }
)

$report = [ordered]@{
    collectedAt = (Get-Date).ToUniversalTime().ToString('o')
    collectionUrl = $collectionBase
    windowsAuthenticationSucceeded = $true
    acceptedApiVersion = $apiVersion
    reportedProductVersion = $firstPage.ProductVersion
    visibleProjectCount = $projects.Count
    projects = $inventory
    notes = @(
        'API acceptance does not identify the exact Server release. Check Help/About in the web UI if no product version was reported.',
        'Only projects and repositories visible to this Windows identity are included.',
        'PAT availability and PR-create permissions are not tested. Check Personal access tokens and repository Security in the web UI.',
        'This report contains internal URLs and names. Redact those before sharing publicly.'
    )
}
$json = $report | ConvertTo-Json -Depth 8
if ($OutputPath) { Set-Content -LiteralPath $OutputPath -Value $json -Encoding UTF8 }
$json
