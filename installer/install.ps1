# AICOS installer — Windows entrypoint.
#
# On Windows the bridge + every agent CLI MUST run inside Linux, so this
# script bootstraps WSL2 + Ubuntu before invoking the real wizard inside it.
#
# Requires: Administrator PowerShell.

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"
$ProgressPreference    = "SilentlyContinue"

function Title($t) { Write-Host "`n── $t ──────────────────────────────────────────────" -ForegroundColor Cyan }
function Ok($t)    { Write-Host "✓ $t" -ForegroundColor Green }
function Warn($t)  { Write-Host "⚠ $t" -ForegroundColor Yellow }
function Fail($t)  { Write-Host "✗ $t" -ForegroundColor Red; exit 1 }

Title "AICOS installer — Windows host preparation"

# ── 1. Verify Windows version ────────────────────────────────────────────────
$os = Get-CimInstance Win32_OperatingSystem
$build = [int]$os.BuildNumber
if ($build -lt 19041) {
  Fail "Windows 10 build 19041+ or Windows 11 required. Detected build $build."
}
Ok "Windows $($os.Caption) build $build (compatible)"

# ── 2. Enable required features ──────────────────────────────────────────────
# These are the WSL2 + VirtualMachinePlatform features. Skipped if already on.
$features = @(
  "Microsoft-Windows-Subsystem-Linux",
  "VirtualMachinePlatform"
)
$rebootNeeded = $false
foreach ($f in $features) {
  $state = Get-WindowsOptionalFeature -Online -FeatureName $f -ErrorAction SilentlyContinue
  if ($state -and $state.State -ne "Enabled") {
    Warn "Enabling Windows feature: $f"
    Enable-WindowsOptionalFeature -Online -FeatureName $f -All -NoRestart | Out-Null
    $rebootNeeded = $true
  } else {
    Ok "Feature already on: $f"
  }
}

if ($rebootNeeded) {
  Warn "A reboot is required to finish enabling WSL2. Run this script again after the reboot."
  exit 0
}

# ── 3. Install / update WSL ──────────────────────────────────────────────────
Title "WSL"
wsl --update --no-launch 2>$null | Out-Null
wsl --set-default-version 2 2>$null | Out-Null
Ok "WSL2 set as default"

# ── 4. Install Ubuntu 24.04 if missing ───────────────────────────────────────
$installed = (wsl -l -q 2>$null) -replace "`0",""
$distros = $installed -split "`r?`n" | Where-Object { $_ -and $_ -ne "" }
if (-not ($distros -contains "Ubuntu-24.04")) {
  Warn "Ubuntu-24.04 not installed — installing (this can take a few minutes)"
  wsl --install -d Ubuntu-24.04 --no-launch
  Start-Sleep -Seconds 10
  Ok "Ubuntu-24.04 installed"
} else {
  Ok "Ubuntu-24.04 already installed"
}

# ── 5. Initialize Ubuntu (create default user, accept defaults) ──────────────
# First launch creates the unix user. We use --user root for now and let the
# wizard create the working user inside Ubuntu later if needed.
Title "Ubuntu initialization"

# Enable systemd inside the distro so we can use --user systemctl for the
# bridge/dashboard services.
# NB: el contenido viaja por stdin (`bash -s`) — pasarlo como argumento rompe
# el quoting de PowerShell 5.1 con strings multilinea.
$wslConf = @"
[boot]
systemd=true

[interop]
appendWindowsPath=false

[user]
default=root
"@
$wslConf | wsl -d Ubuntu-24.04 -u root -- bash -c "cat > /etc/wsl.conf"
Ok "wsl.conf written (systemd=true)"

# Restart the distro so wsl.conf takes effect.
Warn "Shutting down WSL to apply systemd boot setting…"
wsl --shutdown
Start-Sleep -Seconds 3
wsl -d Ubuntu-24.04 -u root -- bash -c "systemctl is-system-running 2>/dev/null || true" | Out-Null
Ok "Ubuntu booted with systemd"

# ── 6. Install base packages inside Ubuntu ───────────────────────────────────
Title "Installing base packages inside Ubuntu"
$bootstrap = @'
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -q --no-install-recommends \
  ca-certificates curl git wget gpg \
  build-essential pkg-config \
  python3 python3-pip python3-venv \
  jq sudo unzip
# Docker
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg 2>/dev/null
  echo "deb [signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
# Node 22 via nvm (so it survives Ubuntu upgrades)
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
# pnpm
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm@9.12.0
fi
echo OK
'@
# stdin otra vez — un script multilinea como argumento se desarma en PS 5.1.
$bootstrap | wsl -d Ubuntu-24.04 -u root -- bash -s

Ok "Base packages installed (docker / node 22 / pnpm / python)"

# ── 7. Copy this repo into WSL ───────────────────────────────────────────────
$repoOnHost = (Resolve-Path "$PSScriptRoot\..").Path
$repoOnWsl  = "/root/aicos"
Title "Copying repo into WSL"
# C:\foo\bar → /mnt/c/foo/bar (conversion manual — compatible PS 5.1, sin
# -replace con scriptblock que es PS6+).
$driveLetter = $repoOnHost.Substring(0, 1).ToLower()
$pathRest    = $repoOnHost.Substring(2) -replace "\\", "/"
$winPath     = "/mnt/$driveLetter$pathRest"

wsl -d Ubuntu-24.04 -u root -- bash -c "mkdir -p '$repoOnWsl' && cp -a '$winPath'/. '$repoOnWsl/' && chown -R root:root '$repoOnWsl'"
if ($LASTEXITCODE -ne 0) { Fail "repo copy into WSL failed (source: $winPath)" }
Ok "Repo at $repoOnWsl"

# ── 8. Hand off to the Linux installer inside WSL ────────────────────────────
Title "Launching wizard inside WSL"
Write-Host "From here on, the install runs inside Ubuntu. Use Ctrl-C to abort."
Write-Host ""
wsl -d Ubuntu-24.04 -u root -- bash "$repoOnWsl/installer/install.sh" @args
