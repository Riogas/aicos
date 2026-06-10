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


CLI_CATALOG = {
    "claude": {
        "name":         "Claude Code (Anthropic)",
        "check_cmd":    ["claude", "--version"],
        "install_url":  "https://docs.claude.com/en/docs/claude-code/quickstart",
        "install_cmd":  ["npm", "install", "-g", "@anthropic-ai/claude-code"],
        "login_cmd":    ["claude", "setup-token"],
        "api_env_var":  "ANTHROPIC_API_KEY",
        "creds_dir":    str(Path.home() / ".claude"),
        "default_models": ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4"],
    },
    "codex": {
        "name":         "Codex CLI (OpenAI/ChatGPT)",
        "check_cmd":    ["codex", "--version"],
        "install_url":  "https://platform.openai.com/docs/codex",
        "install_cmd":  ["npm", "install", "-g", "@openai/codex-cli"],
        "login_cmd":    ["codex", "auth", "login"],
        "api_env_var":  "OPENAI_API_KEY",
        "creds_dir":    str(Path.home() / ".codex"),
        "default_models": ["gpt-5.5", "gpt-5", "gpt-4o"],
    },
    "agy": {
        "name":         "Antigravity / Gemini CLI (Google)",
        "check_cmd":    ["agy", "--version"],
        "install_url":  "https://gemini.google.dev/cli",
        "install_cmd":  ["npm", "install", "-g", "@google/antigravity-cli"],
        "login_cmd":    ["agy", "login"],
        "api_env_var":  "GOOGLE_API_KEY",
        "creds_dir":    str(Path.home() / ".config" / "antigravity"),
        "default_models": ["gemini-3", "gemini-2.5-pro"],
    },
    "opencode": {
        "name":         "OpenCode (router to open-weights — Kimi, Mimo, DeepSeek)",
        "check_cmd":    ["opencode", "--version"],
        "install_url":  "https://opencode.ai",
        "install_cmd":  ["npm", "install", "-g", "opencode"],
        "login_cmd":    ["opencode", "auth"],
        "api_env_var":  "OPENROUTER_API_KEY",
        "creds_dir":    str(Path.home() / ".config" / "opencode"),
        "default_models": ["moonshotai/kimi-k2.6", "xiaomi/mimo-vl-7b-rl"],
    },
}


def _which(name: str) -> str | None:
    return shutil.which(name)


def _installed(cli: str) -> bool:
    return _which(cli) is not None


def _try_install(cli: str, spec: dict) -> bool:
    if _which("npm") and spec["install_cmd"][0] == "npm":
        try:
            subprocess.run(spec["install_cmd"], check=True)
            return _installed(cli)
        except subprocess.CalledProcessError:
            pass
    warn(f"Could not auto-install {cli}. Install manually: {spec['install_url']}")
    return False


def _set_api_key(cli: str, spec: dict, key: str) -> None:
    """Persist an API key for a CLI in a way it'll pick up automatically.

    Each CLI has its own convention — we write a small shell snippet to
    ~/.aicos/api-keys.env which the bridge launcher sources, AND we drop
    the right cred file in each CLI's home where it's idiomatic.
    """
    env_path = Path.home() / ".aicos" / "api-keys.env"
    env_path.parent.mkdir(parents=True, exist_ok=True)

    # Update or insert.
    existing = {}
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                existing[k.strip()] = v
    existing[spec["api_env_var"]] = key
    env_path.write_text(
        "\n".join(f"{k}={v}" for k, v in existing.items()) + "\n",
        encoding="utf-8",
    )
    try:
        env_path.chmod(0o600)
    except Exception:
        pass
    ok(f"  wrote {spec['api_env_var']} → {env_path}")

    # Per-CLI conventional location too.
    creds_dir = Path(spec["creds_dir"])
    creds_dir.mkdir(parents=True, exist_ok=True)
    api_key_path = creds_dir / "api-key"
    api_key_path.write_text(key)
    try:
        api_key_path.chmod(0o600)
    except Exception:
        pass
    ok(f"  wrote {api_key_path}")


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
            info(f"    {' '.join(spec['login_cmd'])}")
        elif mode == "api-key":
            existing = os.environ.get(spec["api_env_var"])
            mask = f"…{existing[-4:]}" if existing else "unset"
            v = prompt_text(f"  Paste {spec['api_env_var']} [{mask}]", default="", secret=True)
            if v:
                _set_api_key(cli, spec, v)
            else:
                warn(f"  no key entered for {cli} — skipped")
        elif mode == "skip":
            info(f"  {cli} auth skipped — configure later before runs go to it")

    state.setdefault("phases_done", []).append("clis")
    return state
