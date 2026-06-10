#!/usr/bin/env bash
# AICOS installer — Linux / WSL Ubuntu entrypoint.
#
# Just delegates to wizard.py after making sure Python 3.10+ is around.
# Everything interesting lives there.

set -euo pipefail

REPO_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"

# ── Pretty print ────────────────────────────────────────────────────────────
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m⚠\033[0m %s\n' "$*"; }
err()   { printf '\033[31m✗\033[0m %s\n' "$*"; }
title() { echo; bold "── $* ──────────────────────────────────────────────"; }

trap 'err "installer failed at line $LINENO"; exit 1' ERR

title "AICOS installer — Linux / WSL Ubuntu"
echo "Repo: $REPO_DIR"

# Detect distro
if [ -r /etc/os-release ]; then
  . /etc/os-release
  bold "Detected: $PRETTY_NAME"
fi

# Ensure Python 3.10+
if ! command -v python3 >/dev/null 2>&1; then
  warn "python3 not found — installing"
  sudo apt-get update -qq
  sudo apt-get install -y python3 python3-pip
fi
PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
ok "python $PY_VER detected"

# Optional dependency: prompt_toolkit / questionary for nicer prompts.
# Fall back to plain input() if it can't be installed.
if ! python3 -c 'import questionary' >/dev/null 2>&1; then
  warn "questionary not installed — using plain input (no arrow-key menus)"
  python3 -m pip install --user --quiet questionary >/dev/null 2>&1 || true
fi

# WSL detection
if grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then
  ok "Running inside WSL — host integration available via host.docker.internal"
  export AICOS_WSL=1
fi

# Hand off
exec python3 "$REPO_DIR/installer/wizard.py" --repo "$REPO_DIR" "$@"
