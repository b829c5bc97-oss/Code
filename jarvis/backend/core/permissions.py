"""
Permission system — Phase 6.

Will define LOW / MEDIUM / HIGH risk tiers for tools (see README §
"Permission model") and require explicit user confirmation before any
HIGH-risk action (deleting files, sending messages, changing system
settings, etc.) executes. Also intended to be user-configurable.

Not implemented yet. Phase 1 has no tool execution at all, so there is
nothing to gate — the moment `tools/registry.py` gains real tools, they
must be wired through this module before being callable by the agent.
"""
from __future__ import annotations

from enum import Enum


class PermissionLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class PermissionDenied(Exception):
    """Raised when an action requires confirmation that hasn't been granted."""


def requires_confirmation(level: PermissionLevel) -> bool:
    """Placeholder policy: only HIGH-risk actions require confirmation.

    Real Phase 6 implementation should make this user-configurable
    (see settings.permissions in the roadmap) rather than a fixed rule.
    """
    return level is PermissionLevel.HIGH
