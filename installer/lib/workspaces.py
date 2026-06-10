"""
Project workspaces.

The bridge maps Paperclip projectId → local cwd (where agents write code)
via registry/project-workspaces.json. Without at least one entry, runs that
aren't triggered with an explicit workspace land nowhere useful.

This phase (optional, skippable):
  1. asks for a first project (name + local path)
  2. creates it in Paperclip (POST /api/companies/:id/projects) using the
     board token minted in the paperclip phase
  3. writes the mapping into registry/project-workspaces.json
  4. records it as AICOS_DEFAULT_PROJECT_ID (used by the Telegram trigger)

Idempotent: existing mappings are preserved; re-running only adds.
"""
from __future__ import annotations

import json
from pathlib import Path

from .ui import ok, warn, info, prompt_yesno, prompt_text
from .paperclip_setup import _api


def _load_map(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            warn(f"{path} corrupt — starting a fresh map")
    return {
        "$schema": "AICOS Project Workspaces map v0.1",
        "comments": [
            "Mapa projectId (Paperclip) -> workspace cwd local donde los agentes escriben codigo.",
            "El bridge usa este mapa cuando Paperclip no inyecta paperclipWorkspace.cwd en el context.",
            "Para agregar un proyecto: anotar id Paperclip + path local + (opcional) git remote.",
        ],
        "workspaces": {},
    }


def configure(state: dict) -> dict:
    repo = Path(state["repo"])
    map_path = repo / "registry" / "project-workspaces.json"
    ws_map = _load_map(map_path)

    if ws_map.get("workspaces"):
        n = len(ws_map["workspaces"])
        ok(f"project-workspaces.json ya tiene {n} workspace(s)")
        if not state.get("default_project_id"):
            state["default_project_id"] = next(iter(ws_map["workspaces"]))
        state.setdefault("phases_done", []).append("workspaces")
        return state

    if state.get("non_interactive"):
        info("non-interactive y sin workspaces — se omite (agregalos después re-corriendo el wizard)")
        state.setdefault("phases_done", []).append("workspaces")
        return state

    if not prompt_yesno("¿Registrar un primer proyecto/workspace ahora?", default=True):
        info("Sin workspaces por ahora. Re-corré el wizard cuando tengas un repo.")
        state.setdefault("phases_done", []).append("workspaces")
        return state

    name = prompt_text("Nombre del proyecto (ej: mi-app)", default="mi-proyecto")
    cwd = prompt_text("Path local del workspace (los agentes escriben acá)",
                      default=str(Path.home() / "Projects" / name))
    cwd_path = Path(cwd).expanduser()
    cwd_path.mkdir(parents=True, exist_ok=True)

    token = state.get("paperclip_board_token")
    company_id = state.get("company_id")
    project_id = None
    if token and company_id:
        code, created = _api("POST", f"/api/companies/{company_id}/projects",
                             token=token, body={"name": name})
        if code == 201 and isinstance(created, dict):
            project_id = created.get("id") or (created.get("project") or {}).get("id")
            ok(f"proyecto creado en Paperclip ({str(project_id)[:8]}…)")
        else:
            warn(f"no pude crear el proyecto en Paperclip (HTTP {code}) — "
                 "registrá el id a mano en registry/project-workspaces.json")
    else:
        warn("sin board token/company — el proyecto no se crea en Paperclip ahora")

    key = project_id or f"PENDING-{name}"
    ws_map["workspaces"][key] = {
        "projectName": name,
        "cwd": str(cwd_path),
        "gitRemote": None,
        "defaultBranch": "main",
    }
    map_path.parent.mkdir(parents=True, exist_ok=True)
    map_path.write_text(json.dumps(ws_map, indent=2) + "\n")
    ok(f"workspace registrado en {map_path}")

    if project_id:
        state["default_project_id"] = project_id

    state.setdefault("phases_done", []).append("workspaces")
    return state
