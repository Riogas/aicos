#!/bin/bash
# AICOS R6 — Wizard interactivo para autenticar opencode con Moonshot (Kimi),
# Xiaomi (MiMo), OpenRouter, y dejar opencode.json con permisos en workspaces.
#
# Por que este script existe:
#   - opencode --format json sirve a Kimi/MiMo/DeepSeek como CLI agentica
#   - El Quota Manager rutea a esos providers en survival mode
#   - Sin keys de Moonshot/Xiaomi configuradas en opencode, el fallback FALLA
#     (exit 127, lo vimos en el survival demo de T4)
#
# Que hace:
#   1. Verifica opencode instalado
#   2. Llama `opencode auth login <provider>` para cada provider que elijas
#   3. Drop opencode.json en TODOS los workspaces de registry/project-workspaces.json
#      con permission: { edit: allow, bash: allow, webfetch: allow }
#   4. Verifica con un probe agentico contra cada provider

set -e
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
AICOS_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
WORKSPACES_JSON="$AICOS_ROOT/registry/project-workspaces.json"

color_info()  { printf "\033[1;34m[opencode-auth]\033[0m %s\n" "$1"; }
color_ok()    { printf "\033[1;32m[ok]\033[0m %s\n" "$1"; }
color_warn()  { printf "\033[1;33m[warn]\033[0m %s\n" "$1"; }
color_err()   { printf "\033[1;31m[err]\033[0m %s\n" "$1"; }

step_check_opencode() {
  if ! command -v opencode >/dev/null 2>&1; then
    color_err "opencode not in PATH. Install with: npm install -g opencode-ai"
    exit 1
  fi
  color_ok "opencode: $(opencode --version 2>/dev/null || echo unknown)"
}

step_auth_providers() {
  echo ""
  color_info "Available providers (Quota Manager prefers these for survival fallback):"
  echo "  1) Moonshot (Kimi K2.6) — https://platform.moonshot.ai"
  echo "  2) Xiaomi (MiMo V2.5 Pro) — https://platform.xiaomimimo.com"
  echo "  3) OpenRouter (1 key for many providers) — https://openrouter.ai"
  echo "  4) (skip and configure later)"
  echo ""
  echo "Repeat per provider — opencode prompts for the API key interactively"
  echo "and persists it in ~/.local/share/opencode/auth.json."
  echo ""

  while true; do
    read -p "Pick a provider [1-4]: " choice
    case "$choice" in
      1)
        color_info "Launching: opencode auth login moonshot"
        opencode auth login moonshot
        color_ok "Moonshot configured."
        ;;
      2)
        color_info "Launching: opencode auth login xiaomi"
        opencode auth login xiaomi
        color_ok "Xiaomi configured."
        ;;
      3)
        color_info "Launching: opencode auth login openrouter"
        opencode auth login openrouter
        color_ok "OpenRouter configured."
        ;;
      4|q|quit|exit)
        break
        ;;
      *)
        color_warn "Unknown choice: $choice"
        ;;
    esac
  done
}

step_drop_workspace_configs() {
  if [ ! -f "$WORKSPACES_JSON" ]; then
    color_warn "No registry/project-workspaces.json found, skipping workspace config drop."
    return
  fi
  color_info "Reading workspaces from $WORKSPACES_JSON"
  python3 - "$WORKSPACES_JSON" <<'PY'
import json, sys, os
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
workspaces = data.get("workspaces", {})
config_body = json.dumps({
    "$schema": "https://opencode.ai/config.json",
    "permission": {
        "edit": "allow",
        "bash": "allow",
        "webfetch": "allow"
    }
}, indent=2)
for project_id, ws in workspaces.items():
    cwd = ws.get("cwd")
    if not cwd or not os.path.isdir(cwd):
        print(f"  - skip {project_id}: cwd missing")
        continue
    target = os.path.join(cwd, "opencode.json")
    if os.path.exists(target):
        print(f"  - {ws.get('projectName', project_id)}: opencode.json already exists at {target}")
        continue
    with open(target, "w") as f:
        f.write(config_body)
    print(f"  - {ws.get('projectName', project_id)}: wrote {target}")
PY
}

step_probe() {
  echo ""
  color_info "Probe: 'opencode run' with each authorized provider"
  echo "Skip with Ctrl-C. Each probe takes ~3s if the provider/model works."

  for spec in \
    "moonshot:moonshotai/kimi-k2.6" \
    "xiaomi:xiaomi/mimo-v2.5-pro" \
    "openrouter:openrouter/moonshotai/kimi-k2.6" \
  ; do
    provider="${spec%%:*}"
    model="${spec##*:}"
    echo ""
    color_info "Probing $provider via $model ..."
    if opencode run -m "$model" --format json "Echo OK" 2>/dev/null | tail -3 | grep -q '"type":"step_finish"\|OK'; then
      color_ok "$provider works"
    else
      color_warn "$provider failed (auth missing or model not available — that's OK)"
    fi
  done
}

main() {
  echo "════════════════════════════════════════════════════════════"
  echo "  AICOS R6 — opencode auth setup wizard"
  echo "════════════════════════════════════════════════════════════"
  step_check_opencode
  step_auth_providers
  step_drop_workspace_configs
  step_probe
  echo ""
  color_ok "Done. The Quota Manager can now route survival fallback to Kimi/MiMo."
  echo ""
  echo "Next:  the bridge will pick up the new auths automatically — no restart needed."
  echo "       Run a real /run with a critical task → mark anthropic down via"
  echo "       'curl -X POST -d {\"cooldownSec\":300} :7001/providers/anthropic/down'"
  echo "       and watch the bridge route to opencode/kimi."
}

main "$@"
