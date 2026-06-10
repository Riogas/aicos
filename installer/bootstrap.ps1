# AICOS bootstrap — Windows.
#
# Designed to be runnable from a fresh Windows machine with nothing
# pre-installed:
#
#   irm https://raw.githubusercontent.com/Riogas/aicos/main/installer/bootstrap.ps1 | iex
#
# Steps:
#   1. Make sure git is on PATH (install via winget if needed).
#   2. Clone the repo into %USERPROFILE%\aicos (or AICOS_TARGET).
#   3. Run installer/install.ps1 as Administrator (relaunches itself
#      elevated if not already).
#
# Idempotent: existing clone is updated, not re-created.

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$RepoUrl    = if ($env:AICOS_REPO)   { $env:AICOS_REPO }   else { "https://github.com/Riogas/aicos.git" }
$RepoBranch = if ($env:AICOS_BRANCH) { $env:AICOS_BRANCH } else { "main" }
$Target     = if ($env:AICOS_TARGET) { $env:AICOS_TARGET } else { Join-Path $env:USERPROFILE "aicos" }

function Ok($t)   { Write-Host "✓ $t" -ForegroundColor Green }
function Warn($t) { Write-Host "⚠ $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "✗ $t" -ForegroundColor Red; exit 1 }

Write-Host "AICOS bootstrap — $RepoUrl → $Target" -ForegroundColor Cyan

# 1. Git available?
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Warn "git not found — installing via winget"
  winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements
  $env:Path += ";C:\Program Files\Git\cmd"
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "git install failed. Install manually: https://git-scm.com/download/win"
  }
}
Ok "git: $((Get-Command git).Source)"

# 2. Clone / update.
if (Test-Path (Join-Path $Target ".git")) {
  Ok "Repo already at $Target — pulling latest"
  git -C $Target fetch origin $RepoBranch
  git -C $Target reset --hard "origin/$RepoBranch"
} else {
  Ok "Cloning into $Target"
  $parent = Split-Path $Target -Parent
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
  git clone --branch $RepoBranch $RepoUrl $Target
}

# 3. Re-launch installer/install.ps1 as Administrator.
$installScript = Join-Path $Target "installer\install.ps1"
if (-not (Test-Path $installScript)) {
  Fail "installer/install.ps1 missing in cloned repo"
}

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Warn "Re-launching as Administrator (UAC prompt incoming)…"
  Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File",$installScript -Verb RunAs
  exit 0
}

& $installScript @args
