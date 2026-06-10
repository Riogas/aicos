#!/usr/bin/env python3
"""
AICOS install wizard.

Idempotent. Always safe to re-run — only prompts for what's missing /
out-of-date and never overwrites secrets unless the user says so.

State flows through a single dict so any module can ask "did the user
opt in to Telegram?" before doing platform-specific work.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Make the installer/lib modules importable.
sys.path.insert(0, str(Path(__file__).parent))
from lib import preflight, vendor, hermes, clis, telegram_setup, paperclip_setup, workspaces, services_setup  # noqa: E402
from lib.ui import title, ok, warn, err, header, prompt_text, prompt_select, prompt_yesno  # noqa: E402


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="aicos-wizard")
    p.add_argument(
        "--repo",
        default=str(Path(__file__).parent.parent),
        help="path to the AICOS repo root (default: parent of this file)",
    )
    p.add_argument("--non-interactive", action="store_true",
                   help="use stored state file only, never prompt")
    p.add_argument("--reset", action="store_true",
                   help="ignore previous state file and start clean")
    p.add_argument("--skip", action="append", default=[],
                   choices=["preflight", "vendor", "hermes", "clis", "telegram",
                            "paperclip", "workspaces", "services"],
                   help="skip a specific phase (repeatable)")
    return p.parse_args()


def load_state(repo: Path, reset: bool) -> dict:
    """Load any previous wizard run's snapshot so we can resume."""
    state_path = repo / ".secrets" / "wizard-state.json"
    if reset or not state_path.exists():
        return {"_path": str(state_path), "repo": str(repo)}
    try:
        s = json.loads(state_path.read_text())
        s["_path"] = str(state_path)
        s["repo"] = str(repo)
        return s
    except Exception:
        return {"_path": str(state_path), "repo": str(repo)}


def save_state(state: dict) -> None:
    path = Path(state["_path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    public = {k: v for k, v in state.items() if not k.startswith("_")}
    path.write_text(json.dumps(public, indent=2, default=str))
    # Tighten permissions — this file may contain tokens/keys.
    try:
        path.chmod(0o600)
    except Exception:
        pass


def main() -> int:
    args = parse_args()
    repo = Path(args.repo).resolve()
    state = load_state(repo, args.reset)
    state["non_interactive"] = args.non_interactive

    header("AICOS install wizard")
    print(f"Repo:  {repo}")
    print(f"State: {state['_path']}")
    print()

    phases = [
        ("preflight",       preflight.configure),
        ("vendor",          vendor.configure),
        ("hermes",          hermes.configure),
        ("clis",            clis.configure),
        ("telegram",        telegram_setup.configure),
        ("paperclip",       paperclip_setup.configure),
        ("workspaces",      workspaces.configure),
        ("services",        services_setup.configure),
    ]

    for name, fn in phases:
        if name in args.skip:
            warn(f"skipping phase '{name}' (--skip)")
            continue
        title(f"Phase: {name}")
        try:
            state = fn(state)
        except KeyboardInterrupt:
            err("aborted by user")
            save_state(state)
            return 130
        except Exception as e:
            err(f"phase {name} failed: {e}")
            save_state(state)
            return 1
        save_state(state)
        ok(f"phase {name} done")

    header("All phases complete")
    print()
    print("What you got:")
    print(f"  • Paperclip      → http://localhost:3100/         (ticket board UI)")
    print(f"  • Live Tactical  → http://localhost:3000/flow      (real-time agent topology)")
    print(f"  • Bridge API     → http://localhost:7100/          (orchestrate, telegram, approve, cancel)")
    print(f"  • Bridge SSE     → http://localhost:7100/events    (stage transitions in real time)")
    print(f"  • Bridge metrics → http://localhost:7100/metrics   (Prometheus)")
    print()
    if state.get("dashboard_token"):
        print(f"Dashboard token: {state['dashboard_token']}")
        print("  (open /flow → paste token at /login → you're in)")
    if state.get("telegram_mode") == "dedicated" and state.get("telegram_bot_token"):
        print("Telegram: dedicated bot configured. See the 'telegram' phase output above for the setWebhook curl.")
    elif state.get("telegram_mode") == "hermes":
        print("Telegram: routing through Hermes-gateway (meta-messages silenced).")
    print()
    print("Quick smoke test:")
    print("  curl http://localhost:7100/health")
    print("  curl http://localhost:3000/api/flow-state")
    print()
    print("Re-run this wizard anytime to rotate keys, add a CLI, or repair the install:")
    print(f"  bash {repo}/installer/install.sh")
    return 0


if __name__ == "__main__":
    sys.exit(main())
