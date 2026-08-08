"""
Tool registry — Phase 6.

Defines the shape every tool will have (name, description, JSON-schema
parameters, permission level, an async execution function) so the
planner/agent can list, select, and invoke tools uniformly once real
tools exist. Registering a tool here does not by itself make the agent
use it — that wiring (LLM function-calling or planner dispatch) is also
Phase 6.

No tools are registered yet. `calculator.py`, `research.py`, and
`code_tools.py` in this package are placeholders for the first tools to
land.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from backend.core.permissions import PermissionLevel


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]  # JSON schema
    permission: PermissionLevel
    execute: Callable[..., Awaitable[Any]]


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def list(self) -> list[Tool]:
        return list(self._tools.values())


_registry = ToolRegistry()


def get_tool_registry() -> ToolRegistry:
    return _registry
