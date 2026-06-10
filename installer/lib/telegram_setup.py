"""
Telegram setup.

The user can:
  - skip Telegram entirely (no webhook, no bot)
  - use Hermes-gateway as the front (default — pairs with the silent
    display config we already applied)
  - point a dedicated bot directly at the bridge `/telegram/webhook`

For the dedicated-bot path we collect the bot token, generate a webhook
secret, persist both, and provide the exact `setWebhook` curl line —
without making the network call from inside the wizard (so the install
doesn't fail when the user is offline or behind a proxy).
"""
from __future__ import annotations

import secrets
from pathlib import Path

from .ui import ok, warn, info, prompt_yesno, prompt_select, prompt_text


def configure(state: dict) -> dict:
    use_telegram = state.get("telegram_enabled")
    if use_telegram is None and not state.get("non_interactive"):
        use_telegram = prompt_yesno("Enable Telegram triggers?", default=True)
        state["telegram_enabled"] = use_telegram

    if not state.get("telegram_enabled"):
        info("Telegram skipped.")
        state.setdefault("phases_done", []).append("telegram")
        return state

    mode = state.get("telegram_mode")
    if not mode and not state.get("non_interactive"):
        mode = prompt_select(
            "How should Telegram messages reach AICOS?",
            choices=[
                "via Hermes-gateway (already silent — recommended)",
                "via a dedicated bot pointing at the AICOS bridge /telegram/webhook",
            ],
            default="via Hermes-gateway (already silent — recommended)",
        )
        mode = "hermes" if "Hermes" in mode else "dedicated"
        state["telegram_mode"] = mode

    if mode == "hermes":
        info("Using Hermes-gateway. Configure the bot in Hermes' setup (`hermes whatsapp` / `hermes setup`).")
        info("The 'auto-compaction was raised' style meta-messages are silenced by the Hermes phase.")
        state.setdefault("phases_done", []).append("telegram")
        return state

    # Dedicated-bot path.
    token = state.get("telegram_bot_token")
    if not token:
        token = prompt_text(
            "Telegram bot token (from @BotFather)",
            default="",
            secret=True,
        )
        if not token:
            warn("No token entered. Switching to skip.")
            state["telegram_enabled"] = False
            state.setdefault("phases_done", []).append("telegram")
            return state
        state["telegram_bot_token"] = token

    secret = state.get("telegram_webhook_secret")
    if not secret:
        secret = secrets.token_urlsafe(24)
        state["telegram_webhook_secret"] = secret
        ok(f"Generated webhook secret: {secret}")

    public_url = state.get("telegram_public_url")
    if not public_url and not state.get("non_interactive"):
        public_url = prompt_text(
            "Public HTTPS URL of the bridge (e.g. https://aicos.example.com)",
            default=public_url or "",
        )
        state["telegram_public_url"] = public_url

    webhook_url = (
        f"{public_url.rstrip('/')}/api/bridge/telegram/webhook"
        if public_url else
        "<set-public-https-url-then-re-run>"
    )
    info("")
    info(f"After provisioning your public URL, register the webhook:")
    info(f"  curl -X POST 'https://api.telegram.org/bot{token[:8]}…/setWebhook' \\")
    info(f"    -d 'url={webhook_url}' \\")
    info(f"    -d 'secret_token={secret}'")
    info("")
    info("And ensure the bridge env has:")
    info(f"  AICOS_TELEGRAM_SECRET={secret}")
    info("  AICOS_DEFAULT_PROJECT_ID=<your Paperclip project id>")
    info("")

    state.setdefault("phases_done", []).append("telegram")
    return state
