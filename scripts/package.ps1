<#
.SYNOPSIS
    PocketShell Desktop Packaging Script (Windows PowerShell)

.DESCRIPTION
    Packages the VS Code fork build into a Windows NSIS installer using
    electron-builder. Optionally signs the installer with a code-signing
    certificate.

.PARAMETER Target
    Build target. Default: auto-detect (win32-x64 on Windows).
    Valid values: win32-x64, win32-arm64

.PARAMETER SkipBuild
    Skip the build step and use existing build output.

.PARAMETER Publish
    Publish the artifact to GitHub Release (requires GITHUB_TOKEN env var).

.PARAMETER CertificatePath
    Path to a PFX code-signing certificate. Optional.

.PARAMETER CertificatePassword
    Password for the PFX certificate. Can also be set via
    CSC_KEY_PASSWORD env var.

.EXAMPLE
    .\scripts\package.ps1
    .\scripts\package.ps1 -Target win32-arm64 -SkipBuild
    .\scripts\package.ps1 -CertificatePath C:\certs\codesign.pfx
#>

[CmdletBinding()]
param(
    [ValidateSet("win32-x64", "win32-arm64")]
    [string]$Target = "",

    [switch]$SkipBuild = $false,

    [switch]$Publish = $false,

    [string]$CertificatePath = "",

    [string]$CertificatePassword = ""
)

$ErrorActionPreference = "Stop"

# --- Helper functions ---
function Write-Info($msg)  { Write-Host "[INFO] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Step($msg)  { Write-Host "[STEP] $msg" -ForegroundColor Cyan }
function Write-Fail($msg)  {
    Write-Host "[ERROR] $msg" -ForegroundColor Red
    exit 1
}

# --- Resolve paths ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path (Join-Path $ScriptDir "..")
$BuildDir = Join-Path $ProjectRoot "build"
$DistDir = Join-Path $ProjectRoot "dist"
$VscDir = Join-Path $ProjectRoot "vendor\vscode"

Set-Location $ProjectRoot

# --- Read version ---
$Version = "0.0.0"
if (Test-Path "package.json") {
    $PkgJson = Get-Content "package.json" | ConvertFrom-Json
    $Version = $PkgJson.version
}
Write-Info "PocketShell Desktop v$Version"

# --- Check prerequisites ---
Write-Info "Checking prerequisites..."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "Node.js is not installed. Install Node.js v24+."
}

$NodeVersion = (node -v)
$NodeMajor = [int]($NodeVersion -replace '^v(\d+).*', '$1')
if ($NodeMajor -lt 24) {
    Write-Fail "Node.js v24+ required, found $NodeVersion."
}
Write-Info "Node.js $NodeVersion OK"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Fail "npm is not installed."
}
$NpmVersion = (npm -v)
Write-Info "npm v$NpmVersion OK"

# --- Detect platform ---
if ($Target -eq "") {
    $Arch = if ([System.Environment]::Is64BitOperatingSystem) { "x64" } else { "arm64" }
    # Check for ARM64 Windows
    if ((Get-CimInstance Win32_OperatingSystem).OSArchitecture -match "ARM") {
        $Arch = "arm64"
    }
    $Target = "win32-$Arch"
}
Write-Info "Packaging target: $Target"

# --- Run build if needed ---
if (-not $SkipBuild) {
    Write-Step "Running build..."
    & bash "$ScriptDir\build.sh"
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Build failed with exit code $LASTEXITCODE"
    }
} else {
    Write-Step "Skipping build (-SkipBuild)"
}

# --- Verify build output ---
$BuildFound = $false
@(
    (Join-Path $VscDir ".build\electron"),
    (Join-Path $VscDir ".build\win32"),
    (Join-Path $VscDir "out")
) | ForEach-Object {
    if ((Test-Path $_) -and -not $BuildFound) {
        $BuildFound = $true
        Write-Info "Build output found: $_"
    }
}

if (-not $BuildFound) {
    Write-Fail "No build output found. Run '.\scripts\build.sh' first."
}

# --- Ensure electron-builder is available ---
Write-Step "Ensuring electron-builder is available..."

$EbInstalled = $false
try {
    $EbVersion = & npx electron-builder --version 2>$null
    if ($LASTEXITCODE -eq 0) {
        $EbInstalled = $true
    }
} catch {}

if (-not $EbInstalled) {
    Write-Info "Installing electron-builder..."
    & npm install --save-dev electron-builder
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Failed to install electron-builder"
    }
    $EbVersion = & npx electron-builder --version 2>$null
}
Write-Info "electron-builder $EbVersion"

# --- Configure code signing ---
if ($CertificatePath -ne "") {
    if (-not (Test-Path $CertificatePath)) {
        Write-Fail "Certificate not found: $CertificatePath"
    }
    Write-Info "Code signing enabled: $CertificatePath"
    $env:CSC_LINK = (Resolve-Path $CertificatePath).Path
    if ($CertificatePassword -ne "") {
        $env:CSC_KEY_PASSWORD = $CertificatePassword
    }
} elseif (Test-Path env:CSC_LINK) {
    Write-Info "Code signing configured via CSC_LINK env var"
} else {
    Write-Info "No code-signing certificate specified (unsigned build)"
}

# --- Run electron-builder ---
Write-Step "Packaging $Target as NSIS installer..."

$DistDirCreated = $false
if (-not (Test-Path $DistDir)) {
    New-Item -ItemType Directory -Path $DistDir | Out-Null
    $DistDirCreated = $true
}

$EbArgs = @(
    "--config", (Join-Path $BuildDir "electron-builder.yml"),
    "--win",
    "--publish", "never"
)

# Set architecture
$TargetArch = $Target.Split("-")[1]
if ($TargetArch -eq "arm64") {
    $EbArgs += "--arm64"
} else {
    $EbArgs += "--x64"
}

if ($Publish) {
    # Override publish mode
    $EbArgs = @(
        "--config", (Join-Path $BuildDir "electron-builder.yml"),
        "--win",
        "--publish", "always"
    )
    if ($TargetArch -eq "arm64") {
        $EbArgs += "--arm64"
    } else {
        $EbArgs += "--x64"
    }
}

Write-Info "Running electron-builder..."
& npx electron-builder @EbArgs

if ($LASTEXITCODE -ne 0) {
    Write-Fail "electron-builder failed with exit code $LASTEXITCODE"
}

# --- Report results ---
Write-Step "Packaging complete!"
Write-Info "Output directory: $DistDir"

$Artifacts = Get-ChildItem -Path $DistDir -File
$ArtifactCount = 0
foreach ($Artifact in $Artifacts) {
    $SizeMB = [math]::Round($Artifact.Length / 1MB, 1)
    Write-Host ("  {0}  ({1} MB)" -f $Artifact.Name, $SizeMB)
    $ArtifactCount++
}

if ($ArtifactCount -eq 0) {
    Write-Warn "No artifacts found in $DistDir"
} else {
    Write-Info "$ArtifactCount artifact(s) produced"
}

# --- Cleanup env ---
if ($CertificatePath -ne "") {
    Remove-Item env:CSC_LINK -ErrorAction SilentlyContinue
    Remove-Item env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
}
