"""
Tool registry.

Defines the shape every tool has (name, description, JSON-schema
parameters, permission level, an async execution function) so the agent's
tool loop (`core/agent.py`) can list, select, and invoke tools uniformly
regardless of which module implements them.

Each tool category has its own `register_*_tools()` function (see
`browser_tools.py`, `computer_tools.py`, `file_tools.py`, `code_tools.py`,
`document_tools.py`, `memory_tools.py`, `system_tools.py`, `research.py`)
called from `main.py` based on the matching `Settings.enable_*_tools` flag.
`calculator.py` remains an intentional placeholder — see its docstring.
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
    # Optional: given a specific call's arguments, return a higher permission
    # tier to apply just for that call (e.g. `code.run_command` escalates to
    # HIGH when the command looks destructive). Return None to use `permission`
    # unchanged. Never used to *lower* risk — see `Agent._effective_permission`.
    risk_escalation: Callable[[dict[str, Any]], PermissionLevel | None] | None = None


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
