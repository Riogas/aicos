#!/usr/bin/env bash
# AICOS bootstrap — Linux / WSL.
#
# Designed to be runnable from a fresh shell with nothing local:
#
#   curl -fsSL https://raw.githubusercontent.com/Riogas/aicos/main/installer/bootstrap.sh | bash
#
# It clones the repo to a target dir (default ~/aicos), then chains to
# install.sh which runs the wizard. Idempotent: if the target dir already
# has the repo, it just pulls + re-runs the wizard so re-install is one
# command.

set -euo pipefail

REPO_URL="${AICOS_REPO:-https://github.com/Riogas/aicos.git}"
REPO_BRANCH="${AICOS_BRANCH:-main}"
TARGET="${AICOS_TARGET:-$HOME/aicos}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$*"; }
err()  { printf '\033[31m✗\033[0m %s\n' "$*"; }

bold "AICOS bootstrap — $REPO_URL → $TARGET"

# Ensure git + curl exist before anything else.
for cmd in git curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "$cmd not found"
    warn "Trying to install with apt…"
    sudo apt-get update -qq
    sudo apt-get install -y "$cmd"
  fi
done

if [ -d "$TARGET/.git" ]; then
  ok "Repo already at $TARGET — pulling latest"
  git -C "$TARGET" fetch origin "$REPO_BRANCH"
  git -C "$TARGET" reset --hard "origin/$REPO_BRANCH"
else
  ok "Cloning into $TARGET"
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$TARGET"
fi

# Hand off to the installer.
# Cuando esto se corre vía `curl ... | bash`, el stdin del proceso es el caño
# del curl, no la terminal → el wizard interactivo no puede leer los prompts
# ("Input is not a terminal"). Si hay una terminal controladora disponible,
# redirigimos el stdin del installer a /dev/tty para que los menús funcionen.
if [ -e /dev/tty ] && [ -r /dev/tty ]; then
  exec bash "$TARGET/installer/install.sh" "$@" < /dev/tty
else
  warn "sin terminal (/dev/tty) — si el wizard necesita input, cloná el repo y corré: bash installer/install.sh"
  exec bash "$TARGET/installer/install.sh" "$@"
fi
