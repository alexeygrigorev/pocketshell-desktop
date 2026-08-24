<#
.SYNOPSIS
  Puts a PocketShell shortcut on the Windows desktop, pointing at this checkout.

.DESCRIPTION
  This is a DEVELOPMENT shortcut, not an install. It launches the repo's own
  Electron binary against the built output in out/, which is what `npm run
  build` produces and what `electron-vite preview` runs. That means:

    - it starts the last build, not the current sources — rebuild to update it;
    - it breaks if the checkout is moved or node_modules is removed;
    - it is not the same thing as `npm run dist`, which produces a real NSIS
      installer that registers an uninstall entry and its own Start Menu item.

  The point is to launch the app the way a user would — from the desktop,
  windowed, with the real icon in the taskbar — without installing anything.
  Electron is a GUI subsystem binary, so no console window appears.

  Re-running overwrites the existing shortcut in place; it is idempotent.

.PARAMETER Name
  Shortcut filename, without the .lnk extension. Defaults to PocketShell.

.PARAMETER Force
  Skip the "out/ is missing" guard and create the shortcut anyway.

.EXAMPLE
  npm run build
  powershell -ExecutionPolicy Bypass -File scripts/install-desktop-shortcut.ps1
#>
[CmdletBinding()]
param(
  [string] $Name = 'PocketShell',
  [switch] $Force
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $repo 'build\icon.ico'
$entry = Join-Path $repo 'out\main\index.js'

if (-not (Test-Path $electron)) {
  throw "Electron binary not found at $electron. Run 'npm install' first."
}

# The icon is generated, not committed as the shortcut's only copy — regenerate
# rather than failing, so a fresh clone needs one command instead of two.
if (-not (Test-Path $icon)) {
  Write-Host 'build\icon.ico missing; generating it.'
  & node (Join-Path $repo 'scripts\make-icon.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed.' }
}

if (-not (Test-Path $entry) -and -not $Force) {
  throw "No build found at $entry. Run 'npm run build' first, or pass -Force."
}

$desktop = [Environment]::GetFolderPath('Desktop')
$linkPath = Join-Path $desktop "$Name.lnk"

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($linkPath)
$link.TargetPath = $electron
# Electron treats a directory argument as the app root and reads its
# package.json "main" — so this stays correct if the entry point ever moves.
$link.Arguments = '"' + $repo + '"'
$link.WorkingDirectory = $repo
$link.IconLocation = "$icon,0"
$link.Description = 'PocketShell - tmux-native, agent-aware SSH client (dev build)'
$link.Save()

# Release the COM object explicitly; without this the handle can linger for the
# life of the session and keep the .lnk locked against a re-run.
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)

Write-Host "Created $linkPath"
Write-Host "  target: $electron"
Write-Host "  app:    $repo"
