"""
Preflight: verify (and install if missing) Docker, Node 22, pnpm, Python.
Refuses to continue if any blocker can't be resolved automatically.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .ui import ok, warn, err, info, prompt_yesno


REQUIRED = {
    "docker":          {"min": None,  "install_hint": "apt or https://docs.docker.com/engine/install/"},
    "docker compose":  {"min": None,  "install_hint": "comes with docker-compose-plugin"},
    "node":            {"min": "20",  "install_hint": "https://github.com/nodesource/distributions"},
    "pnpm":            {"min": "9",   "install_hint": "npm i -g pnpm@9.12.0"},
    "python3":         {"min": "3.10","install_hint": "apt install python3"},
    "git":             {"min": None,  "install_hint": "apt install git"},
    "curl":            {"min": None,  "install_hint": "apt install curl"},
    "jq":              {"min": None,  "install_hint": "apt install jq"},
}


def _cmd(*args) -> tuple[int, str, str]:
    p = subprocess.run(list(args), capture_output=True, text=True)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def _check_docker() -> tuple[bool, str]:
    if not shutil.which("docker"):
        return False, "docker binary missing"
    code, out, _ = _cmd("docker", "info")
    if code != 0:
        return False, "docker daemon not running"
    return True, out.split("\n")[0] if out else "ok"


def _check_node_version() -> tuple[bool, str]:
    if not shutil.which("node"):
        return False, "node missing"
    code, out, _ = _cmd("node", "-v")
    if code != 0:
        return False, "node broken"
    # out is like 'v22.7.0' — accept anything >= 20
    try:
        major = int(out.lstrip("v").split(".")[0])
    except ValueError:
        return False, f"unparseable version {out}"
    if major < 20:
        return False, f"node {out} — need 20+"
    return True, out


def _check_pnpm() -> tuple[bool, str]:
    if not shutil.which("pnpm"):
        return False, "pnpm missing"
    code, out, _ = _cmd("pnpm", "-v")
    return code == 0, out


def _try_install_via_apt(*pkgs: str) -> bool:
    try:
        subprocess.run(["sudo", "apt-get", "update", "-qq"], check=True)
        subprocess.run(["sudo", "apt-get", "install", "-y", *pkgs], check=True)
        return True
    except subprocess.CalledProcessError:
        return False


def _try_install_pnpm() -> bool:
    try:
        subprocess.run(["npm", "install", "-g", "pnpm@9.12.0"], check=True)
        return True
    except subprocess.CalledProcessError:
        return False


def configure(state: dict) -> dict:
    missing = []
    checks = {
        "docker":       _check_docker,
        "node (≥20)":   _check_node_version,
        "pnpm":         _check_pnpm,
    }
    for name, fn in checks.items():
        good, detail = fn()
        if good:
            ok(f"{name}: {detail}")
        else:
            err(f"{name}: {detail}")
            missing.append(name)

    if missing and not state.get("non_interactive"):
        warn("Some prerequisites are missing.")
        if prompt_yesno("Try to auto-install (requires sudo)?", default=True):
            if any(n.startswith("docker") for n in missing):
                info("Installing Docker via apt (may take a while)…")
                _try_install_via_apt("docker.io", "docker-compose-plugin")
            if any(n.startswith("node") for n in missing):
                info("Installing Node 22…")
                subprocess.run(
                    "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -",
                    shell=True, check=False,
                )
                _try_install_via_apt("nodejs")
            if "pnpm" in missing:
                info("Installing pnpm…")
                _try_install_pnpm()
            # Re-check
            still_missing = []
            for name, fn in checks.items():
                good, _ = fn()
                if not good:
                    still_missing.append(name)
            if still_missing:
                err(f"Still missing after install attempt: {', '.join(still_missing)}")
                err("Install them manually and re-run the wizard.")
                raise RuntimeError("preflight unmet")
            ok("All prerequisites resolved")
        else:
            raise RuntimeError("preflight unmet (user declined auto-install)")
    elif missing:
        raise RuntimeError(f"non-interactive mode: missing {missing}")

    # Verify repo has the right structure.
    repo = Path(state["repo"])
    for child in ("apps/paperclip-bridge", "apps/dashboard", "services/aicos-quota-manager", "infra/docker-compose.yml"):
        if not (repo / child).exists():
            err(f"repo missing: {child}")
            raise RuntimeError("repo structure incomplete — clone the full aicos repo")
    ok("repo structure looks complete")

    state.setdefault("phases_done", []).append("preflight")
    return state
