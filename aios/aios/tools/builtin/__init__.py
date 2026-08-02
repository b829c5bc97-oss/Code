"""Builtin tool modules.

Each module exposes ``tools() -> list[Tool]``. Modules are imported lazily and
individually: a module whose optional dependency is missing must not prevent
the rest of the OS from booting, so an import failure degrades that one family
rather than the process.
"""

from __future__ import annotations

import importlib
from collections.abc import Iterable

from ...foundation.logging import get_logger
from ..base import Tool

log = get_logger("tools.builtin")

MODULES = ("fs", "shell", "net", "code", "data", "media", "docs", "vcs", "browser")


def load(modules: Iterable[str] = MODULES) -> list[Tool]:
    """Instantiate every builtin tool that this environment can support."""
    collected: list[Tool] = []
    for name in modules:
        try:
            module = importlib.import_module(f"{__name__}.{name}")
            collected.extend(module.tools())
        except Exception:
            log.warning("builtin tool module unavailable", extra={"module": name}, exc_info=True)
    return collected


__all__ = ["MODULES", "load"]
