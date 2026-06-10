"""
Paperclip company onboard.

Two scenarios:
  1) FRESH install: Paperclip is empty. Run the claim flow to create a
     company + the Hermes/CEO agent, get back the API key, persist it as
     `.secrets/paperclip-claim-response.json`.

  2) RE-RUN on an existing install: skip the claim, just verify the
     existing secrets are loadable and the company id is consistent.

Then ensures registry/agents.json + agent-keys.json exist (onboarding the
26 specialist agents if not already done).

The wizard never touches Paperclip's DB directly — everything goes
through the REST API so the install stays decoupled from the vendor
schema.
"""
from __future__ import annotations

import json
import secrets
import subprocess
from pathlib import Path

from .ui import ok, warn, info, prompt_yesno, prompt_text


def _paperclip_up() -> bool:
    """Check if the Paperclip container is up + healthy."""
    try:
        r = subprocess.run(
            ["curl", "-fsS", "-m", "3", "http://localhost:3100/api/health"],
            capture_output=True, text=True,
        )
        return r.returncode == 0
    except Exception:
        return False


def _bring_paperclip_up(repo: Path) -> None:
    info("Bringing Paperclip + its deps up via docker compose…")
    subprocess.run(
        ["docker", "compose", "-f", str(repo / "infra" / "docker-compose.yml"),
         "up", "-d", "postgres", "redis", "qdrant", "paperclip"],
        check=True,
    )
    info("Waiting for Paperclip to become healthy…")
    for _ in range(60):
        if _paperclip_up():
            ok("Paperclip is healthy")
            return
        import time; time.sleep(2)
    raise RuntimeError("Paperclip didn't become healthy in 2 min")


def _claim_company(repo: Path, company_name: str, admin_email: str) -> dict:
    """
    Use Paperclip's bootstrap claim endpoint to create the company + the
    first agent (Hermes/CEO) and get back its API key. The endpoint is
    only callable while the instance hasn't been claimed yet — re-running
    after the first claim returns 409.
    """
    payload = {
        "companyName": company_name,
        "adminEmail":  admin_email,
        # Hermes/CEO is what the bridge authenticates as.
        "firstAgent": {
            "name":         "CEO",
            "department":   "executive",
            "adapterType":  "claude_local",  # arbitrary — won't be dispatched by Paperclip
        },
    }
    body = json.dumps(payload)
    r = subprocess.run(
        ["curl", "-fsS", "-X", "POST",
         "-H", "Content-Type: application/json",
         "-d", body,
         "http://localhost:3100/api/bootstrap/claim"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"claim failed: {r.stderr.strip() or r.stdout.strip()}")
    return json.loads(r.stdout)


def configure(state: dict) -> dict:
    repo = Path(state["repo"])
    claim_path = repo / ".secrets" / "paperclip-claim-response.json"

    # Bring Paperclip up if not running yet (we need its API).
    if not _paperclip_up():
        _bring_paperclip_up(repo)

    if claim_path.exists():
        try:
            claim = json.loads(claim_path.read_text())
            ok(f"Found existing claim — company {claim.get('companyId', '?')[:8]}…")
            state["company_id"]      = claim.get("companyId")
            state["paperclip_api_key"] = claim.get("token") or claim.get("apiKey")
            state["hermes_agent_id"] = claim.get("agentId") or claim.get("hermesAgentId")
        except Exception:
            warn("claim file corrupt — re-claiming")
            claim_path.unlink()

    if not claim_path.exists():
        company_name = state.get("company_name")
        admin_email  = state.get("admin_email")
        if not state.get("non_interactive"):
            company_name = prompt_text("Company name (any label, e.g. Acme)",
                                       default=company_name or "AICOS")
            admin_email  = prompt_text("Admin email (used for billing / alerts)",
                                       default=admin_email or "ops@example.com")
        state["company_name"] = company_name
        state["admin_email"]  = admin_email

        try:
            claim = _claim_company(repo, company_name, admin_email)
            claim_path.parent.mkdir(parents=True, exist_ok=True)
            claim_path.write_text(json.dumps(claim, indent=2))
            try: claim_path.chmod(0o600)
            except: pass
            ok(f"Company claimed: {claim.get('companyId','?')[:8]}…")
            state["company_id"]        = claim.get("companyId")
            state["paperclip_api_key"] = claim.get("token") or claim.get("apiKey")
            state["hermes_agent_id"]   = claim.get("agentId") or claim.get("hermesAgentId")
        except Exception as e:
            warn(f"claim failed (Paperclip may already be claimed): {e}")
            warn(f"If you have a previous claim, drop it at {claim_path} and re-run.")
            raise

    # ── Specialist agents — onboard the 26 from registry/agents.json ─────────
    agents_keys_path = repo / ".secrets" / "agent-keys.json"
    onboard_script = repo / "scripts" / "onboard-agents.mjs"
    if not agents_keys_path.exists():
        if not onboard_script.exists():
            warn("scripts/onboard-agents.mjs missing — skipping specialist onboarding")
        else:
            info("Onboarding 26 specialist agents…")
            try:
                subprocess.run(
                    ["node", str(onboard_script)],
                    cwd=repo, check=True,
                    env={**__import__("os").environ,
                         "PAPERCLIP_API_URL": "http://localhost:3100",
                         "PAPERCLIP_API_KEY": state["paperclip_api_key"],
                         "AICOS_COMPANY_ID":   state["company_id"]},
                )
                ok(f"Agents onboarded → {agents_keys_path}")
            except subprocess.CalledProcessError as e:
                warn(f"onboard-agents failed: {e}")
    else:
        ok(f"agent-keys.json already exists ({agents_keys_path})")

    state.setdefault("phases_done", []).append("paperclip")
    return state
