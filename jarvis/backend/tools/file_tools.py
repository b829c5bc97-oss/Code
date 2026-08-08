"""Registers the Phase 6 file management tools into the tool registry."""
from __future__ import annotations

from backend.core.permissions import PermissionLevel
from backend.files import file_manager, search
from backend.files.file_manager import FileManagerError
from backend.tools.registry import Tool, ToolRegistry, ToolResult


def register_file_tools(registry: ToolRegistry) -> None:
    async def list_dir(path: str = ".", **_: object) -> ToolResult:
        try:
            entries = file_manager.list_dir(path)
        except FileManagerError as exc:
            return ToolResult(success=False, error=str(exc))
        if not entries:
            return ToolResult(success=True, output="(empty directory)")
        listing = "\n".join(
            f"{'[dir] ' if e['is_dir'] else ''}{e['name']}" + (f" ({e['size']} bytes)" if e["size"] else "")
            for e in entries
        )
        return ToolResult(success=True, output=listing)

    async def read_file(path: str, **_: object) -> ToolResult:
        try:
            content = file_manager.read_file(path)
        except FileManagerError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=content)

    async def search_files(query: str, directory: str = ".", **_: object) -> ToolResult:
        try:
            matches = search.search_files(query, directory)
        except FileManagerError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output="\n".join(matches) if matches else "No matches found.")

    async def create_file(path: str, content: str = "", **_: object) -> ToolResult:
        try:
            message = file_manager.create_file(path, content)
        except FileManagerError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=message)

    async def rename_file(path: str, new_name: str, **_: object) -> ToolResult:
        try:
            message = file_manager.rename(path, new_name)
        except FileManagerError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=message)

    async def move_file(path: str, destination: str, **_: object) -> ToolResult:
        try:
            message = file_manager.move(path, destination)
        except FileManagerError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=message)

    async def delete_file(path: str, **_: object) -> ToolResult:
        try:
            message = file_manager.delete(path)
        except FileManagerError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=message)

    registry.register(
        Tool(
            name="files.list",
            description="List the contents of a directory.",
            parameters={"type": "object", "properties": {"path": {"type": "string", "default": "."}}},
            permission=PermissionLevel.LOW,
            execute=list_dir,
        )
    )
    registry.register(
        Tool(
            name="files.read",
            description="Read the text content of a file.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            permission=PermissionLevel.LOW,
            execute=read_file,
        )
    )
    registry.register(
        Tool(
            name="files.search",
            description="Search for files by (partial) filename under a directory.",
            parameters={
                "type": "object",
                "properties": {"query": {"type": "string"}, "directory": {"type": "string", "default": "."}},
                "required": ["query"],
            },
            permission=PermissionLevel.LOW,
            execute=search_files,
        )
    )
    registry.register(
        Tool(
            name="files.create",
            description="Create a new file with the given text content (creates parent folders as needed).",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string", "default": ""}},
                "required": ["path"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=create_file,
        )
    )
    registry.register(
        Tool(
            name="files.rename",
            description="Rename a file or folder in place.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}, "new_name": {"type": "string"}},
                "required": ["path", "new_name"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=rename_file,
        )
    )
    registry.register(
        Tool(
            name="files.move",
            description="Move a file or folder to a new location.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}, "destination": {"type": "string"}},
                "required": ["path", "destination"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=move_file,
        )
    )
    registry.register(
        Tool(
            name="files.delete",
            description="Permanently delete a file or folder. Irreversible.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            permission=PermissionLevel.HIGH,
            execute=delete_file,
        )
    )
