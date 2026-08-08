"""
Tool registry.

Defines the shape every tool has (name, description, JSON-schema
parameters, permission level, an async execution function) so the agent's
tool loop (`core/agent.py`) can list, select, and invoke tools uniformly
regardless of which module implements them.

Phase 3 registers the first real tools here (`browser.*`, wired up in
`tools/browser_tools.py`). `calculator.py`, `research.py`, and
`code_tools.py` remain placeholders for later phases.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from backend.core.permissions import PermissionLevel


@dataclass
class ToolResult:
    """The outcome of executing one tool call."""

    success: bool
    output: str = ""
    error: str | None = None


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]  # JSON schema
    permission: PermissionLevel
    execute: Callable[..., Awaitable[ToolResult]]


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def list(self) -> list[Tool]:
        return list(self._tools.values())

    def clear(self) -> None:
        """Mainly for tests — reset to an empty registry."""
        self._tools.clear()


_registry = ToolRegistry()


def get_tool_registry() -> ToolRegistry:
    return _registry
