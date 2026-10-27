# Install dsh-plugin-pkt into a DSH profile.
#
# Copies the package into <profile>\node_modules\dsh-plugin-pkt and appends the
# loader entry to <profile>\cordis.patch.yml (backing that file up first).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -ProfileDir "C:\Users\me\.dsh\profiles\desktop"
#
# Restart DSH afterwards: the loader does not hot-add new plugin entries.

param(
    [string]$ProfileDir = (Join-Path $env:USERPROFILE ".dsh\profiles\desktop")
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgName = "dsh-plugin-pkt"
$entryId = "pkt-reader"

if (-not (Test-Path $ProfileDir)) {
    throw "profile directory not found: $ProfileDir"
}

$dest = Join-Path $ProfileDir "node_modules\$pkgName"
$patch = Join-Path $ProfileDir "cordis.patch.yml"

Write-Host "source : $here"
Write-Host "target : $dest"

# 1) copy the package
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($item in @("src", "bin", "package.json", "cordis.patch.yml", "README.md", "LICENSE")) {
    $src = Join-Path $here $item
    if (Test-Path $src) { Copy-Item $src $dest -Recurse -Force }
}

# 2) register the loader entry (idempotent)
$marker = "id: $entryId"
$existing = if (Test-Path $patch) { Get-Content $patch -Raw } else { "" }

if ($existing -match [regex]::Escape($marker)) {
    Write-Host "cordis.patch.yml already references $entryId; leaving it untouched."
} else {
    if (Test-Path $patch) {
        $backup = "$patch.bak-pkt"
        Copy-Item $patch $backup -Force
        Write-Host "backup : $backup"
    }
    $entry = "`r`n- insert:`r`n    - id: $entryId`r`n      name: '$pkgName'`r`n"
    Add-Content -Path $patch -Value $entry -NoNewline
    Write-Host "appended loader entry to $patch"
}

Write-Host ""
Write-Host "Done. Restart DSH to activate: pkt_read, pkt_fix, pkt_new, pkt_build, pkt_open."
