"""
Shared UI primitives for the wizard.

Tries to use `questionary` for nicer arrow-key menus when available;
falls back to plain stdin/stdout otherwise so the installer works on a
fresh Ubuntu with zero pip deps.
"""
from __future__ import annotations

import sys
from typing import Iterable

try:
    import questionary
    _HAVE_Q = True
except ImportError:  # pragma: no cover
    _HAVE_Q = False


# ── tiny ANSI helpers ────────────────────────────────────────────────────────
def _c(code: int, text: str) -> str:
    if not sys.stdout.isatty():
        return text
    return f"\033[{code}m{text}\033[0m"


def bold(t: str) -> str: return _c(1, t)
def red(t: str)  -> str: return _c(31, t)
def green(t: str) -> str: return _c(32, t)
def yellow(t: str) -> str: return _c(33, t)
def cyan(t: str)  -> str: return _c(36, t)


def header(t: str) -> None:
    bar = "═" * max(40, len(t) + 4)
    print()
    print(cyan(bar))
    print(cyan(f"  {bold(t)}"))
    print(cyan(bar))
    print()


def title(t: str) -> None:
    print()
    print(cyan(f"── {bold(t)} {'─' * (50 - len(t))}"))


def ok(t: str)   -> None: print(green("✓") + " " + t)
def warn(t: str) -> None: print(yellow("⚠") + " " + t)
def err(t: str)  -> None: print(red("✗") + " " + t)
def info(t: str) -> None: print("  " + t)


# ── prompts ──────────────────────────────────────────────────────────────────
def prompt_text(question: str, default: str | None = None, secret: bool = False) -> str:
    """Free-text prompt. `secret=True` masks the input."""
    if _HAVE_Q:
        if secret:
            return questionary.password(question, default=default or "").ask() or (default or "")
        return questionary.text(question, default=default or "").ask() or (default or "")
    # Fallback
    suffix = f" [{default}]" if default else ""
    if secret:
        import getpass
        v = getpass.getpass(f"{question}{suffix}: ")
    else:
        v = input(f"{question}{suffix}: ")
    return v.strip() or (default or "")


def prompt_yesno(question: str, default: bool = True) -> bool:
    if _HAVE_Q:
        return bool(questionary.confirm(question, default=default).ask())
    yn = "Y/n" if default else "y/N"
    while True:
        v = input(f"{question} [{yn}]: ").strip().lower()
        if not v:
            return default
        if v in ("y", "yes", "s", "si", "sí"):
            return True
        if v in ("n", "no"):
            return False


def prompt_select(question: str, choices: Iterable[str], default: str | None = None) -> str:
    choices = list(choices)
    if _HAVE_Q:
        return questionary.select(question, choices=choices, default=default).ask() or (default or choices[0])
    print(question)
    for i, c in enumerate(choices, 1):
        marker = " *" if c == default else "  "
        print(f"  {i}{marker} {c}")
    while True:
        v = input(f"Select [1-{len(choices)}] (default {default}): ").strip()
        if not v and default:
            return default
        try:
            idx = int(v) - 1
            if 0 <= idx < len(choices):
                return choices[idx]
        except ValueError:
            pass
        print(red("invalid"))


def prompt_checkboxes(question: str, choices: Iterable[str], defaults: Iterable[str] = ()) -> list[str]:
    """Multi-select. Returns the list of selected items."""
    choices = list(choices)
    defaults = list(defaults)
    if _HAVE_Q:
        result = questionary.checkbox(question, choices=choices, default=None).ask()
        return result or []
    # Fallback: ask each one yes/no
    print(question)
    out = []
    for c in choices:
        if prompt_yesno(f"  Include {c}?", default=(c in defaults)):
            out.append(c)
    return out
