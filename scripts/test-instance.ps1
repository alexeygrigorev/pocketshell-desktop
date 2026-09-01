[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('build', 'start', 'stop', 'reset', 'status', 'logs', 'shell')]
    [string]$Action = 'start'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ComposeFile = Join-Path $RepoRoot 'tests-docker\docker-compose.instance.yml'
$ComposePrefix = @('--project-name', 'pocketshell-local', '--file', $ComposeFile)

function Invoke-Compose {
    param(
        [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    & docker compose @ComposePrefix @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose failed with exit code $LASTEXITCODE"
    }
}

switch ($Action) {
    'build' {
        Invoke-Compose build instance
    }
    'start' {
        Invoke-Compose up -d --build --wait instance
    }
    'stop' {
        Invoke-Compose stop instance
    }
    'reset' {
        Invoke-Compose down --volumes --remove-orphans
        Invoke-Compose up -d --build --wait instance
    }
    'status' {
        Invoke-Compose ps
    }
    'logs' {
        Invoke-Compose logs --follow instance
    }
    'shell' {
        Invoke-Compose exec --user testuser instance sh -l
    }
}
