"""
Paperclip company onboard.

Paperclip runs in `authenticated` + `private` deployment mode, so there is
no headless "create company" shortcut: board-level mutations need a board
API token. The supported way to mint one from a terminal is Paperclip's
CLI-auth challenge flow:

  1. POST /api/cli-auth/challenges  → {id, token, boardApiToken, approvalUrl}
  2. The user opens http://localhost:3100 in a browser, signs up
     (the FIRST user of a private instance claims instance-admin), then
     opens the approvalUrl and clicks Approve.
  3. We poll GET /api/cli-auth/challenges/:id?token=… until approved —
     from then on `boardApiToken` is a valid instance-admin Bearer token.

With that token the wizard:
  - creates (or reuses) the company
  - creates the "AICOS Hermes" bridge identity agent + its API key
    (persisted as .secrets/paperclip-claim-response.json — the bridge and
    dashboard authenticate with it)
  - creates an agent invite and runs scripts/onboard-agents.mjs to onboard
    the 26 specialists (the script auto-approves using the board token and
    patches each agent to the `process` adapter pointing at aicos-bridge)

Idempotent: every step checks for existing state before creating anything.
The wizard never touches Paperclip's DB directly — REST only.
"""
from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from .ui import ok, warn, info, err, prompt_text
from .services_setup import write_infra_env

PAPERCLIP_URL = "http://localhost:3100"
CHALLENGE_TIMEOUT_S = 15 * 60


# ── tiny HTTP helper (stdlib only — the installer has no pip deps) ───────────
def _api(method: str, path: str, token: str | None = None, body: dict | None = None,
         timeout: int = 15) -> tuple[int, dict | list | None]:
    req = urllib.request.Request(PAPERCLIP_URL + path, method=method)
    req.add_header("Accept", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw.decode(errors="replace")[:400]}


def _paperclip_up() -> bool:
    try:
        code, _ = _api("GET", "/api/health", timeout=4)
        return code == 200
    except Exception:
        return False


def _bring_paperclip_up(repo: Path) -> None:
    info("Bringing Paperclip + its deps up via docker compose…")
    subprocess.run(
        ["docker", "compose", "-f", str(repo / "infra" / "docker-compose.yml"),
         "up", "-d", "postgres", "redis", "qdrant", "paperclip"],
        check=True,
    )
    info("Waiting for Paperclip to become healthy (first boot runs migrations)…")
    for _ in range(90):
        if _paperclip_up():
            ok("Paperclip is healthy")
            return
        time.sleep(2)
    raise RuntimeError("Paperclip didn't become healthy in 3 min — check `docker logs aicos-paperclip`")


# ── board token via CLI-auth challenge ───────────────────────────────────────
def _board_token_valid(token: str) -> bool:
    code, _ = _api("GET", "/api/companies", token=token)
    return code == 200


def _obtain_board_token(state: dict) -> str:
    existing = state.get("paperclip_board_token")
    if existing and _board_token_valid(existing):
        ok("existing board token still valid")
        return existing

    if state.get("non_interactive"):
        raise RuntimeError(
            "no valid board token in state and non-interactive mode can't run "
            "the browser approval flow — run the wizard interactively once"
        )

    code, ch = _api("POST", "/api/cli-auth/challenges", body={
        "command": "aicos installer",
        "clientName": "aicos-wizard",
        "requestedAccess": "instance_admin_required",
    })
    if code != 201 or not isinstance(ch, dict):
        raise RuntimeError(f"could not create CLI-auth challenge: HTTP {code} {ch}")

    approval_url = ch.get("approvalUrl") or (PAPERCLIP_URL + ch["approvalPath"])
    board_token = ch["boardApiToken"]
    poll_path = ch["pollPath"] if ch["pollPath"].startswith("/api") else "/api" + ch["pollPath"]

    # Si Paperclip corre en una VM/host remoto, el usuario accede por la IP, no
    # por localhost (localhost desde otra máquina apunta a OTRA cosa). Mostramos
    # las URLs con las IPs no-loopback del host además de localhost.
    host_ips: list[str] = []
    try:
        out = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=5).stdout
        host_ips = [ip for ip in out.split() if ip.count(".") == 3 and not ip.startswith("127.")]
    except Exception:
        pass

    info("")
    info("Paperclip needs a one-time browser approval:")
    if host_ips:
        info("  *** Si accedés desde otra máquina (p.ej. una VM), usá la IP, NO localhost ***")
    info(f"  1. Sign up / sign in:")
    info(f"       {PAPERCLIP_URL}")
    for ip in host_ips:
        info(f"       http://{ip}:3100   <- usá esta si entrás de afuera")
    info("     (the FIRST user of this instance becomes its admin)")
    info(f"  2. Then open and click **Approve**:")
    info(f"       {approval_url}")
    for ip in host_ips:
        info(f"       {approval_url.replace('localhost', ip)}   <- usá esta si entrás de afuera")
    info("")
    info(f"Waiting for approval (up to {CHALLENGE_TIMEOUT_S // 60} min)…")

    deadline = time.time() + CHALLENGE_TIMEOUT_S
    while time.time() < deadline:
        code, st = _api("GET", f"{poll_path}?token={ch['token']}")
        status = (st or {}).get("status") if isinstance(st, dict) else None
        if status == "approved":
            ok("challenge approved")
            state["paperclip_board_token"] = board_token
            return board_token
        if status in ("cancelled", "expired"):
            raise RuntimeError(f"CLI-auth challenge {status} — re-run the wizard")
        time.sleep(3)
    raise RuntimeError("timed out waiting for browser approval — re-run the wizard")


# ── company ───────────────────────────────────────────────────────────────────
def _ensure_company(state: dict, token: str) -> str:
    if state.get("company_id"):
        code, c = _api("GET", f"/api/companies/{state['company_id']}", token=token)
        if code == 200:
            ok(f"company exists: {state['company_id'][:8]}…")
            return state["company_id"]
        warn("company id in state no longer resolves — creating a new one")

    code, companies = _api("GET", "/api/companies", token=token)
    rows = companies.get("companies") if isinstance(companies, dict) else companies
    if isinstance(rows, list) and rows:
        first = rows[0]
        ok(f"reusing existing company '{first.get('name', '?')}' ({first['id'][:8]}…)")
        state["company_id"] = first["id"]
        return first["id"]

    name = state.get("company_name")
    if not state.get("non_interactive"):
        name = prompt_text("Company name (any label, e.g. Acme)", default=name or "AICOS")
    state["company_name"] = name or "AICOS"
    code, created = _api("POST", "/api/companies", token=token, body={"name": state["company_name"]})
    if code != 201 or not isinstance(created, dict):
        raise RuntimeError(f"company create failed: HTTP {code} {created}")
    ok(f"company created: {created['id'][:8]}…")
    state["company_id"] = created["id"]
    return created["id"]


# ── Hermes bridge identity agent + API key ───────────────────────────────────
def _ensure_hermes_agent(state: dict, token: str, company_id: str, claim_path: Path) -> None:
    if claim_path.exists():
        try:
            claim = json.loads(claim_path.read_text())
            state["paperclip_api_key"] = claim["token"]
            state["hermes_agent_id"] = claim["agentId"]
            ok(f"Hermes bridge key already provisioned (agent {claim['agentId'][:8]}…)")
            return
        except Exception:
            warn("claim file corrupt — re-provisioning the Hermes agent key")

    # Reuse the agent if a previous run created it but lost the key file.
    code, listing = _api("GET", f"/api/companies/{company_id}/agents", token=token)
    rows = listing.get("agents") if isinstance(listing, dict) else listing
    agent_id = None
    for a in rows or []:
        if a.get("name") == "AICOS Hermes":
            agent_id = a["id"]
            ok(f"found existing 'AICOS Hermes' agent ({agent_id[:8]}…)")
            break

    if not agent_id:
        # adapterType http is intentional: this identity is never dispatched by
        # Paperclip heartbeats — it's the system principal the bridge/dashboard
        # authenticate as (and the PAPERCLIP_SYSTEM_AGENT_IDS bypass member).
        code, created = _api("POST", f"/api/companies/{company_id}/agents", token=token, body={
            "name": "AICOS Hermes",
            "title": "AICOS bridge system identity",
            "adapterType": "http",
            "adapterConfig": {"url": "http://host.docker.internal:7100/run"},
            "capabilities": "System identity used by the AICOS bridge — do not assign work.",
        })
        if code != 201 or not isinstance(created, dict):
            raise RuntimeError(f"Hermes agent create failed: HTTP {code} {created}")
        agent_id = created.get("id") or (created.get("agent") or {}).get("id")
        ok(f"'AICOS Hermes' agent created ({agent_id[:8]}…)")

    code, key = _api("POST", f"/api/agents/{agent_id}/keys", token=token, body={"name": "aicos-bridge"})
    if code != 201 or not isinstance(key, dict):
        raise RuntimeError(f"Hermes agent key create failed: HTTP {code} {key}")
    claim = {
        "keyId":     key.get("id") or key.get("keyId"),
        "token":     key.get("token"),
        "agentId":   agent_id,
        "createdAt": key.get("createdAt") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if not claim["token"]:
        raise RuntimeError(f"key endpoint didn't return a token: {sorted(key.keys())}")
    claim_path.parent.mkdir(parents=True, exist_ok=True)
    claim_path.write_text(json.dumps(claim, indent=2))
    try:
        claim_path.chmod(0o600)
    except Exception:
        pass
    ok(f"Hermes bridge key written to {claim_path}")
    state["paperclip_api_key"] = claim["token"]
    state["hermes_agent_id"] = agent_id


# ── 26 specialists via invite + onboard script ───────────────────────────────
def _onboard_specialists(state: dict, token: str, company_id: str, repo: Path) -> None:
    keys_path = repo / ".secrets" / "agent-keys.json"
    if keys_path.exists():
        try:
            n = len(json.loads(keys_path.read_text()))
            ok(f"agent-keys.json already exists ({n} agents) — skipping onboarding")
            return
        except Exception:
            warn("agent-keys.json corrupt — re-onboarding")

    onboard_script = repo / "scripts" / "onboard-agents.mjs"
    if not onboard_script.exists():
        warn("scripts/onboard-agents.mjs missing — skipping specialist onboarding")
        return

    invite_token = state.get("agent_invite_token")
    if not invite_token:
        code, inv = _api("POST", f"/api/companies/{company_id}/invites", token=token,
                         body={"allowedJoinTypes": "agent"})
        if code != 201 or not isinstance(inv, dict):
            raise RuntimeError(f"invite create failed: HTTP {code} {inv}")
        invite_token = inv["token"]
        state["agent_invite_token"] = invite_token
        ok(f"agent invite created ({invite_token[:12]}…)")

    info("Onboarding the 26 specialist agents (auto-approved with the board token)…")
    env = {**__import__("os").environ,
           "PAPERCLIP_BOARD_TOKEN": token,
           "AICOS_COMPANY_ID":      company_id}
    r = subprocess.run(
        ["node", str(onboard_script), f"--invite={invite_token}", f"--api={PAPERCLIP_URL}"],
        cwd=repo, env=env,
    )
    if r.returncode != 0:
        raise RuntimeError("onboard-agents.mjs failed — see its output above")
    ok(f"Agents onboarded → {keys_path}")


def configure(state: dict) -> dict:
    repo = Path(state["repo"])
    claim_path = repo / ".secrets" / "paperclip-claim-response.json"

    # CRÍTICO: escribir infra/.env ANTES de levantar el stack. Si no, postgres
    # arranca sin POSTGRES_PASSWORD y se niega a inicializar → unhealthy. La
    # fase services lo re-escribe luego con la API key / company id ya conocidos.
    write_infra_env(state, repo)

    if not _paperclip_up():
        _bring_paperclip_up(repo)

    # Fast path: a complete previous install needs no board token at all.
    if claim_path.exists() and (repo / ".secrets" / "agent-keys.json").exists():
        try:
            claim = json.loads(claim_path.read_text())
            state["paperclip_api_key"] = claim["token"]
            state["hermes_agent_id"] = claim["agentId"]
            if not state.get("company_id"):
                # Backfill from a previous install's compose env.
                infra_env = repo / "infra" / ".env"
                if infra_env.exists():
                    for line in infra_env.read_text().splitlines():
                        if line.startswith("AICOS_COMPANY_ID=") and line.split("=", 1)[1].strip():
                            state["company_id"] = line.split("=", 1)[1].strip().strip('"')
                            break
            if not state.get("company_id"):
                warn("company_id missing from state — run with --reset paperclip if agents misbehave")
            ok("Paperclip already provisioned (claim + agent keys present)")
            state.setdefault("phases_done", []).append("paperclip")
            return state
        except Exception:
            warn("existing secrets unreadable — re-provisioning")

    token = _obtain_board_token(state)
    company_id = _ensure_company(state, token)
    _ensure_hermes_agent(state, token, company_id, claim_path)
    _onboard_specialists(state, token, company_id, repo)

    state.setdefault("phases_done", []).append("paperclip")
    return state
