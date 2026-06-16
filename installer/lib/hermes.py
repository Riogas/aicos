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


def _run_hermes_setup() -> bool:
    """Lanza `hermes setup` interactivo, HEREDANDO la terminal del wizard
    (sin capturar output) — el usuario elige su provider (OpenRouter / Nous
    Portal / API keys) y modelo (p.ej. owl alpha) ahí mismo. Devuelve True
    si pudo lanzarlo (aunque el usuario lo cancele con Ctrl+C)."""
    py = _find_hermes_python()
    if py and py.name == "python":
        cmd = [str(py), "-m", "hermes_cli.main", "setup"]
    else:
        cmd = ["hermes", "setup"]
    info("Abriendo `hermes setup` — elegí tu provider (OpenRouter, etc.) y modelo. Ctrl+C cancela.")
    info("")
    try:
        subprocess.run(cmd)  # SIN capture_output → interactivo, usa la terminal
        return True
    except KeyboardInterrupt:
        warn("`hermes setup` cancelado — podés correrlo luego con:  hermes setup")
        return False
    except Exception as e:
        warn(f"no pude lanzar `hermes setup`: {e} — corrélo a mano luego")
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

    # ── Step 3: auth / cerebro de Hermes ─────────────────────────────────────
    auth_mode = state.get("hermes_auth_mode")
    if not auth_mode and not state.get("non_interactive"):
        choice = prompt_select(
            "¿Cómo configurás el cerebro (inference) de Hermes?",
            choices=[
                "hermes-setup  (abre `hermes setup` ahora — OpenRouter / Nous Portal / API keys + modelo)",
                "api-key       (pego API keys de OpenAI / Anthropic / Google / Moonshot)",
                "skip          (lo configuro después con `hermes setup`)",
            ],
            default="hermes-setup  (abre `hermes setup` ahora — OpenRouter / Nous Portal / API keys + modelo)",
        )
        auth_mode = choice.split(" ", 1)[0]  # hermes-setup | api-key | skip
        state["hermes_auth_mode"] = auth_mode

    # "oauth" = valor legacy de un wizard-state viejo → tratarlo como hermes-setup.
    if auth_mode in ("hermes-setup", "oauth"):
        if state.get("hermes_setup_done"):
            ok("hermes ya configurado (hermes setup ya corrió). Reconfigurá con: hermes setup")
        elif _run_hermes_setup():
            state["hermes_setup_done"] = True
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
    else:  # skip
        info("Hermes sin configurar — cuando quieras corré:  hermes setup")
        info("(ahí elegís OpenRouter / Nous Portal / API keys + el modelo).")

    state.setdefault("phases_done", []).append("hermes")
    return state
