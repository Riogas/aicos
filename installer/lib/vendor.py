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
    if target.exists() and (target / ".git").exists():
        ok(f"vendor/paperclip already present")
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    info(f"Fetching Paperclip {PAPERCLIP_PIN} from {PAPERCLIP_REPO}…")
    # `git clone --branch` doesn't accept a SHA, so init+fetch the pin
    # directly (GitHub allows fetching arbitrary SHAs with depth=1).
    target.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", str(target)], check=True)
    subprocess.run(["git", "-C", str(target), "remote", "add", "origin", PAPERCLIP_REPO], check=True)
    subprocess.run(["git", "-C", str(target), "fetch", "--depth", "1", "origin", PAPERCLIP_PIN], check=True)
    subprocess.run(["git", "-C", str(target), "checkout", "-q", "FETCH_HEAD"], check=True)
    ok(f"checked out {PAPERCLIP_PIN} at {target}")
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
