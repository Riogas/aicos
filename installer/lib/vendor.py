"""
Vendor: clone Paperclip from upstream + apply our patches.

The AICOS repo doesn't ship Paperclip's source (it's MIT-licensed but
shipped separately to keep our repo small + always-fresh-from-upstream).

When the wizard runs:
  - if vendor/paperclip/ doesn't exist → git clone the pinned upstream
  - apply every installer/patches/*.patch in lexical order
  - record applied patches in vendor/paperclip/.aicos-applied-patches.txt
    so re-runs skip already-applied ones (git apply errors on duplicate)

Idempotent. Fails noisily if a patch can't apply because upstream moved
and the patch needs refresh.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from .ui import ok, warn, info, prompt_yesno


PAPERCLIP_REPO = "https://github.com/paperclipai/paperclip.git"
# Pinned to a known-good upstream commit — the base that installer/patches/*
# were validated against. Bump ONLY after re-validating the patches apply
# cleanly on the new SHA (run this phase against a scratch clone).
PAPERCLIP_PIN  = "524e18b0"


def _clone(repo_root: Path) -> Path:
    target = repo_root / "vendor" / "paperclip"
    # "Ya presente" SOLO si tiene contenido real (no un git-init vacío de un
    # intento previo fallido). `server/` es el dir raíz del source de Paperclip.
    if (target / ".git").exists() and (target / "server").exists():
        ok("vendor/paperclip already present")
        return target
    # Limpiar cualquier intento previo roto/incompleto.
    if target.exists():
        warn("vendor/paperclip incompleto (clon previo falló) — limpiando y re-clonando")
        shutil.rmtree(target, ignore_errors=True)
    target.parent.mkdir(parents=True, exist_ok=True)

    # NOTA: `git fetch origin <sha>` NO sirve con un SHA abreviado (y muchos
    # repos no permiten fetch por SHA arbitrario). Clonamos y hacemos checkout
    # local del commit — eso sí resuelve el SHA abreviado de forma confiable.
    # --filter=blob:none baja el grafo de commits sin todos los blobs (rápido);
    # el checkout trae los blobs del commit fijado.
    info(f"Clonando Paperclip desde {PAPERCLIP_REPO}…")
    r = subprocess.run(
        ["git", "clone", "--filter=blob:none", PAPERCLIP_REPO, str(target)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        # Fallback: clon normal (sin partial) por si el server no soporta filter.
        warn("partial clone no soportado — clonando completo (más lento)")
        shutil.rmtree(target, ignore_errors=True)
        subprocess.run(["git", "clone", PAPERCLIP_REPO, str(target)], check=True)

    info(f"Checkout del commit fijado {PAPERCLIP_PIN}…")
    co = subprocess.run(
        ["git", "-C", str(target), "checkout", "--quiet", PAPERCLIP_PIN],
        capture_output=True, text=True,
    )
    if co.returncode != 0:
        raise RuntimeError(
            f"no pude hacer checkout de {PAPERCLIP_PIN}: {co.stderr.strip()}\n"
            f"El commit fijado quizás ya no existe upstream. Actualizá PAPERCLIP_PIN "
            f"en installer/lib/vendor.py a un commit válido y reintentá."
        )
    ok(f"vendor/paperclip en {PAPERCLIP_PIN}")
    return target


def _apply_patches(vendor: Path, patches_dir: Path) -> None:
    if not patches_dir.exists():
        ok("no patches to apply (installer/patches/ absent)")
        return
    log = vendor / ".aicos-applied-patches.txt"
    applied = set()
    if log.exists():
        applied = set(l.strip() for l in log.read_text().splitlines() if l.strip())

    patches = sorted(patches_dir.glob("*.patch"))
    if not patches:
        ok("no patches to apply (installer/patches/ empty)")
        return

    fresh_applied = []
    for p in patches:
        if p.name in applied:
            ok(f"patch already applied: {p.name}")
            continue
        # Already present in the tree (e.g. a vendor checkout where the patch
        # got committed)? --reverse --check succeeding means the content is in.
        r_rev = subprocess.run(
            ["git", "apply", "--check", "--reverse", str(p)],
            cwd=vendor, capture_output=True, text=True,
        )
        if r_rev.returncode == 0:
            ok(f"patch content already present: {p.name} — recording, not re-applying")
            fresh_applied.append(p.name)
            continue
        info(f"applying {p.name}…")
        r = subprocess.run(
            ["git", "apply", "--check", str(p)],
            cwd=vendor, capture_output=True, text=True,
        )
        if r.returncode != 0:
            warn(f"  pre-check failed: {r.stderr.strip()}")
            warn("  Trying with --3way merge (will conflict-mark if upstream moved)…")
            r2 = subprocess.run(
                ["git", "apply", "--3way", str(p)],
                cwd=vendor, capture_output=True, text=True,
            )
            if r2.returncode != 0:
                raise RuntimeError(
                    f"patch {p.name} cannot apply cleanly. Upstream Paperclip moved.\n"
                    f"Re-base the patch manually: cd vendor/paperclip && git apply --reject {p}\n"
                    f"Then commit the result and re-run the wizard."
                )
        else:
            subprocess.run(["git", "apply", str(p)], cwd=vendor, check=True)
        fresh_applied.append(p.name)
        ok(f"  applied {p.name}")

    if fresh_applied:
        with log.open("a") as fh:
            for n in fresh_applied:
                fh.write(n + "\n")


def configure(state: dict) -> dict:
    repo_root = Path(state["repo"])
    vendor = _clone(repo_root)
    _apply_patches(vendor, repo_root / "installer" / "patches")
    state["vendor_paperclip"] = str(vendor)
    state.setdefault("phases_done", []).append("vendor")
    return state
