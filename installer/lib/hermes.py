"""
Hermes setup.

Installs the Hermes CLI if missing, configures auth (OAuth subscription or
API keys), and writes the silenced display settings the user already chose
in the running install (no surprise meta-messages on Telegram).

Idempotent: re-running this module on an existing install just re-prompts
for things that look unset.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from .ui import ok, warn, info, prompt_yesno, prompt_select, prompt_text


HERMES_HOME = Path.home() / ".hermes"
HERMES_BIN_GUESSES = [
    HERMES_HOME / "hermes-agent" / "venv" / "bin" / "python",
    Path.home() / ".local" / "bin" / "hermes",
]


def _find_hermes_python() -> Path | None:
    for p in HERMES_BIN_GUESSES:
        if p.exists():
            return p
    return None


def _hermes(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    py = _find_hermes_python()
    if py and py.name == "python":
        cmd = [str(py), "-m", "hermes_cli.main", *args]
    else:
        cmd = ["hermes", *args]
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


HERMES_INSTALL_URL = "https://hermes-agent.nousresearch.com/install.sh"


def _install_hermes() -> bool:
    """Official installer: clones hermes-agent into ~/.hermes/hermes-agent,
    creates its venv, and drops the `hermes` wrapper in ~/.local/bin.

    --skip-setup: NO lanza el setup wizard interactivo de Hermes (que pide
    loguear al Nous Portal). El cerebro de Hermes lo configuramos nosotros
    con API keys más abajo (o el usuario lo hace después). --skip-browser:
    no instala Playwright/Chromium (pesado; el bridge no usa el browser-tool).
    --non-interactive: cualquier prompt restante usa defaults sin colgarse."""
    info(f"Installing Hermes Agent ({HERMES_INSTALL_URL}) — sin wizard interactivo…")
    try:
        subprocess.run(
            ["bash", "-c",
             f"curl -fsSL {HERMES_INSTALL_URL} | bash -s -- --skip-setup --non-interactive"],
            check=True,
        )
        return _find_hermes_python() is not None
    except Exception as e:
        warn(f"hermes install failed: {e}")
        return False


def _set_config(key: str, value: str) -> None:
    res = _hermes(["config", "set", key, str(value)])
    if res.returncode != 0:
        warn(f"hermes config set {key} failed: {res.stderr.strip()}")
    else:
        ok(f"hermes {key} = {value}")


def configure(state: dict) -> dict:
    # ── Step 1: detect Hermes ────────────────────────────────────────────────
    py = _find_hermes_python()
    if py:
        ok(f"hermes already installed ({py})")
    else:
        warn("hermes not detected")
        if state.get("non_interactive") or prompt_yesno("Install Hermes CLI now?", default=True):
            if not _install_hermes():
                raise RuntimeError(
                    "hermes install failed — manual route: "
                    "https://github.com/NousResearch/hermes-agent#installation"
                )

    # Re-detect.
    py = _find_hermes_python()
    if not py:
        raise RuntimeError("hermes still not detected after install")

    # ── Step 2: silence noisy meta-messages ──────────────────────────────────
    info("Applying quiet-mode defaults so the bot stops chattering about itself…")
    quiet_settings = [
        ("compression.codex_gpt55_autoraise",       "false"),
        ("display.interim_assistant_messages",      "false"),
        ("display.long_running_notifications",      "false"),
        ("display.background_process_notifications", "none"),
        ("display.busy_ack_detail",                  "false"),
        ("display.turn_completion_explainer",        "false"),
        ("display.tool_progress",                    "none"),
        ("display.tool_progress_command",            "false"),
        ("agent.gateway_notify_interval",            "3600"),
    ]
    for k, v in quiet_settings:
        _set_config(k, v)
    state["hermes_quiet_mode"] = True

    # ── Step 3: auth strategy ────────────────────────────────────────────────
    auth_mode = state.get("hermes_auth_mode")
    if not auth_mode and not state.get("non_interactive"):
        auth_mode = prompt_select(
            "How should Hermes authenticate to its inference provider?",
            choices=[
                "oauth-subscription   (Claude/ChatGPT subscription via browser login)",
                "api-key              (pay-as-you-go: OPENAI_API_KEY / ANTHROPIC_API_KEY / etc.)",
            ],
            default="oauth-subscription   (Claude/ChatGPT subscription via browser login)",
        )
        auth_mode = "oauth" if auth_mode.startswith("oauth") else "api-key"
        state["hermes_auth_mode"] = auth_mode

    if auth_mode == "oauth":
        info("Run this in a separate terminal to log in:")
        info("    hermes login")
        info("(skipping interactive login here — the browser flow doesn't compose with a wizard)")
    elif auth_mode == "api-key":
        info("Provide an API key per provider you want Hermes to use. Empty = skip.")
        api_keys = state.setdefault("hermes_api_keys", {})
        for provider, env_var in [
            ("OpenAI",   "OPENAI_API_KEY"),
            ("Anthropic","ANTHROPIC_API_KEY"),
            ("Google",   "GOOGLE_API_KEY"),
            ("Moonshot", "MOONSHOT_API_KEY"),
        ]:
            existing = api_keys.get(env_var) or os.environ.get(env_var)
            mask = f"…{existing[-4:]}" if existing else "(unset)"
            v = prompt_text(f"  {provider} {env_var} [{mask}]", default="", secret=True)
            if v:
                api_keys[env_var] = v
        # Write to ~/.hermes/.env so the gateway picks them up.
        env_lines = [f"{k}={v}" for k, v in api_keys.items() if v]
        if env_lines:
            env_path = HERMES_HOME / ".env"
            env_path.write_text("\n".join(env_lines) + "\n")
            try:
                env_path.chmod(0o600)
            except Exception:
                pass
            ok(f"Wrote {len(env_lines)} API keys to {env_path}")

    state.setdefault("phases_done", []).append("hermes")
    return state
