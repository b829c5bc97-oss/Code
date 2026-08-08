"""Registers the Phase 5 long-term memory tools into the tool registry."""
from __future__ import annotations

from backend.core.memory import MEMORY_CATEGORIES, LongTermMemoryStore
from backend.core.permissions import PermissionLevel
from backend.tools.registry import Tool, ToolRegistry, ToolResult


def register_memory_tools(registry: ToolRegistry, store: LongTermMemoryStore) -> None:
    async def remember(content: str, category: str = "fact", **_: object) -> ToolResult:
        if not content.strip():
            return ToolResult(success=False, error="Nothing to remember — content was empty.")
        entry = store.add(category, content)
        return ToolResult(success=True, output=f"Remembered ({entry.category}): {entry.content}")

    async def recall(query: str = "", **_: object) -> ToolResult:
        matches = store.search(query)
        if not matches:
            return ToolResult(success=True, output="Nothing found in memory for that.")
        listing = "\n".join(f"- ({e.category}) {e.content}" for e in matches)
        return ToolResult(success=True, output=listing)

    async def list_memories(**_: object) -> ToolResult:
        entries = store.list()
        if not entries:
            return ToolResult(success=True, output="No memories stored yet.")
        listing = "\n".join(f"- [{e.id}] ({e.category}) {e.content}" for e in entries)
        return ToolResult(success=True, output=listing)

    async def forget(id: str, **_: object) -> ToolResult:  # noqa: A002 - matches tool schema
        removed = store.delete(id)
        if not removed:
            return ToolResult(success=False, error=f"No memory with id {id!r} was found.")
        return ToolResult(success=True, output=f"Forgot memory {id!r}.")

    registry.register(
        Tool(
            name="memory.remember",
            description="Save a fact, preference, or piece of context to remember for later.",
            parameters={
                "type": "object",
                "properties": {
                    "content": {"type": "string"},
                    "category": {"type": "string", "enum": list(MEMORY_CATEGORIES), "default": "fact"},
                },
                "required": ["content"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=remember,
        )
    )
    registry.register(
        Tool(
            name="memory.recall",
            description="Search remembered facts/preferences/context for a query.",
            parameters={"type": "object", "properties": {"query": {"type": "string"}}},
            permission=PermissionLevel.LOW,
            execute=recall,
        )
    )
    registry.register(
        Tool(
            name="memory.list",
            description="List everything currently remembered.",
            parameters={"type": "object", "properties": {}},
            permission=PermissionLevel.LOW,
            execute=list_memories,
        )
    )
    registry.register(
        Tool(
            name="memory.forget",
            description="Delete a remembered item by its id (see memory.list).",
            parameters={
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=forget,
        )
    )
