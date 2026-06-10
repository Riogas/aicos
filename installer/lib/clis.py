"""
Optional agent CLIs: claude, codex, agy (gemini), opencode.

For each one the user can:
  - skip
  - install with OAuth (subscription / browser login)
  - install with API key

Each CLI gets its credentials in its conventional location so the bridge
spawning it via `process` adapter just picks them up naturally.

Designed to be re-run: existing installs are detected, you can rotate
keys without uninstalling, and adding a new CLI later doesn't disturb
the others.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from .ui import ok, warn, info, prompt_yesno, prompt_select, prompt_text


# Install/login commands validated against the reference install (2026-06).
# "login_hint" is printed, never executed — every OAuth flow here is
# interactive/browser-based and doesn't compose with a wizard.
CLI_CATALOG = {
    "claude": {
        "name":         "Claude Code (Anthropic)",
        "check_cmd":    ["claude", "--version"],
        "install_url":  "https://docs.claude.com/en/docs/claude-code/quickstart",
        "install_cmd":  ["npm", "install", "-g", "@anthropic-ai/claude-code"],
        "login_hint":   "claude   (arranca y corré /login — suscripción)  |  claude setup-token (token de larga vida)",
        "api_env_var":  "ANTHROPIC_API_KEY",
        "default_models": ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4"],
    },
    "codex": {
        "name":         "Codex CLI (OpenAI/ChatGPT)",
        "check_cmd":    ["codex", "--version"],
        "install_url":  "https://developers.openai.com/codex/cli",
        "install_cmd":  ["npm", "install", "-g", "@openai/codex"],
        "login_hint":   "codex login   (browser OAuth con la cuenta ChatGPT)",
        "api_env_var":  "OPENAI_API_KEY",
        "default_models": ["gpt-5.5", "gpt-5", "gpt-4o"],
    },
    "agy": {
        "name":         "Antigravity CLI (Google)",
        "check_cmd":    ["agy", "--version"],
        "install_url":  "https://antigravity.google",
        # No es un paquete npm — instala un binario standalone en ~/.local/bin.
        "install_cmd":  ["bash", "-c", "curl -fsSL https://antigravity.google/cli/install.sh | bash"],
        "login_hint":   "agy   (el primer arranque interactivo abre el browser para autenticar)",
        "api_env_var":  "GOOGLE_API_KEY",
        "default_models": ["gemini-3", "gemini-2.5-pro"],
    },
    "opencode": {
        "name":         "OpenCode (router a open-weights — Kimi, MiMo, DeepSeek)",
        "check_cmd":    ["opencode", "--version"],
        "install_url":  "https://opencode.ai",
        "install_cmd":  ["npm", "install", "-g", "opencode-ai"],
        "login_hint":   "bash scripts/setup-opencode-auth.sh   (keys Moonshot/Xiaomi/OpenRouter + opencode.json de permisos)",
        "api_env_var":  "OPENROUTER_API_KEY",
        "default_models": ["moonshotai/kimi-k2.6", "xiaomi/mimo-vl-7b-rl"],
    },
}


def _which(name: str) -> str | None:
    return shutil.which(name)


def _installed(cli: str) -> bool:
    return _which(cli) is not None


def _try_install(cli: str, spec: dict) -> bool:
    cmd = spec["install_cmd"]
    runnable = cmd[0] != "npm" or _which("npm")
    if runnable:
        try:
            subprocess.run(cmd, check=True)
            if _installed(cli):
                return True
        except subprocess.CalledProcessError:
            pass
    warn(f"Could not auto-install {cli}. Install manually: {spec['install_url']}")
    return False


def _set_api_key(state: dict, spec: dict, key: str) -> None:
    """Persist an API key so the bridge's spawned CLIs see it.

    The bridge runs as a systemd unit with EnvironmentFile=infra/.env.bridge
    and passes its env down to every CLI child process — so the only place a
    key needs to live is state["cli_api_keys"]; the services phase merges
    those into .env.bridge when it renders env files.
    """
    keys = state.setdefault("cli_api_keys", {})
    keys[spec["api_env_var"]] = key
    ok(f"  {spec['api_env_var']} guardada — la fase services la escribe en infra/.env.bridge")


def configure(state: dict) -> dict:
    info("Pick which CLIs you want this AICOS install to spawn.")
    info("(Bridge falls back across CLIs automatically — install the ones you use.)")

    # If we're resuming, the user already picked once.
    enabled = set(state.get("cli_enabled", []))

    available = list(CLI_CATALOG.keys())
    if not state.get("non_interactive"):
        from .ui import prompt_checkboxes
        chosen = prompt_checkboxes(
            "Which CLIs do you want enabled?",
            choices=available,
            defaults=list(enabled) or available,  # default to all on first run
        )
        enabled = set(chosen)

    state["cli_enabled"] = sorted(enabled)
    if not enabled:
        warn("No CLIs selected. The bridge will only be able to run Hermes-mediated tasks.")
        state.setdefault("phases_done", []).append("clis")
        return state

    # Per-CLI: install + auth.
    auth_choices = state.setdefault("cli_auth", {})
    for cli in sorted(enabled):
        spec = CLI_CATALOG[cli]
        info("")
        info(f"━━ {spec['name']} ━━")

        if not _installed(cli):
            if state.get("non_interactive") or prompt_yesno(f"Install {cli}?", default=True):
                _try_install(cli, spec)
            else:
                warn(f"skipped {cli}")
                continue
        else:
            ok(f"{cli} already installed at {_which(cli)}")

        prior_mode = auth_choices.get(cli)
        if state.get("non_interactive"):
            mode = prior_mode or "skip"
        else:
            mode = prompt_select(
                f"Auth for {cli}",
                choices=[
                    "oauth  (subscription / browser login — recommended)",
                    "api-key (paste a key now; saved to ~/.aicos/api-keys.env)",
                    "skip   (configure later)",
                ],
                default=prior_mode or "oauth  (subscription / browser login — recommended)",
            )
            mode = mode.split(" ", 1)[0]
            auth_choices[cli] = mode

        if mode == "oauth":
            info(f"Run this in a separate terminal to log in:")
            info(f"    {spec['login_hint']}")
        elif mode == "api-key":
            existing = os.environ.get(spec["api_env_var"])
            mask = f"…{existing[-4:]}" if existing else "unset"
            v = prompt_text(f"  Paste {spec['api_env_var']} [{mask}]", default="", secret=True)
            if v:
                _set_api_key(state, spec, v)
            else:
                warn(f"  no key entered for {cli} — skipped")
        elif mode == "skip":
            info(f"  {cli} auth skipped — configure later before runs go to it")

    # opencode necesita ADEMAS un opencode.json de permisos en cada workspace —
    # sin eso no-opea en silencio (edit/bash denied). setup-opencode-auth.sh
    # lo deja en todos los workspaces registrados.
    if "opencode" in enabled and _installed("opencode"):
        info("")
        info("Recordatorio opencode: corré `bash scripts/setup-opencode-auth.sh` para")
        info("keys de Moonshot/Xiaomi y el opencode.json de permisos por workspace.")

    state.setdefault("phases_done", []).append("clis")
    return state
