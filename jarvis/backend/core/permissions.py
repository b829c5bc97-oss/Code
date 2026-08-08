"""
Permission system.

Defines LOW / MEDIUM / HIGH risk tiers for tools. HIGH-risk actions
(deleting files, running dangerous commands, changing system settings,
etc.) always require explicit user confirmation before executing — see
`core/agent.py`'s tool loop, which checks `requires_confirmation()` before
calling any tool and routes to a pending-confirmation round trip instead.

User-configurable: setting `ALWAYS_CONFIRM_MEDIUM=true` in `.env` tightens
the policy so MEDIUM-risk actions (writing files, clicking/typing on the
screen, running ordinary scripts) also require a yes/no before running —
useful if you want to review everything JARVIS does at first.
"""
from __future__ import annotations

from enum import Enum

from backend.core.config import Settings, get_settings


class PermissionLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class PermissionDenied(Exception):
    """Raised when an action requires confirmation that hasn't been granted."""


def requires_confirmation(level: PermissionLevel, settings: Settings | None = None) -> bool:
    """HIGH always requires confirmation; MEDIUM does too if the user opted in."""
    settings = settings or get_settings()
    if level is PermissionLevel.HIGH:
        return True
    if level is PermissionLevel.MEDIUM:
        return settings.always_confirm_medium
    return False
