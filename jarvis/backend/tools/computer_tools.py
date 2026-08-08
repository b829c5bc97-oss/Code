"""
Registers the Phase 2 computer-control tools into the tool registry.

Mirrors `tools/browser_tools.py`: each tool wraps a plain function from
`backend/computer/*`, catches `ComputerControlError`, and returns a
`ToolResult` — a tool should never raise into the agent loop.

Vision-composed tools (`computer.describe_screen`, `computer.click_element`)
are registered separately by `register_vision_tools` in this same module,
since they additionally depend on the configured LLM supporting images.
"""
from __future__ import annotations

from backend.ai.llm import LLMProvider
from backend.ai.vision import VisionError, describe_screen, locate_element
from backend.computer import applications, keyboard, mouse, screen, windows
from backend.computer.errors import ComputerControlError
from backend.core.permissions import PermissionLevel
from backend.tools.registry import Tool, ToolRegistry, ToolResult


def register_computer_tools(registry: ToolRegistry) -> None:
    async def open_application(name: str, **_: object) -> ToolResult:
        try:
            message = applications.open_application(name)
        except ComputerControlError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=message)

    async def close_application(name: str, **_: object) -> ToolResult:
        try:
            message = applications.close_application(name)
        except ComputerControlError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=message)

    async def click(x: int | None = None, y: int | None = None, button: str = "left", **_: object) -> ToolResult:
        try:
            mouse.click(x, y, button=button)
        except ComputerControlError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=f"Clicked at ({x}, {y}).")

    async def type_text(text: str, **_: object) -> ToolResult:
        try:
            keyboard.type_text(text)
        except ComputerControlError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=f"Typed {text!r}.")

    async def press_key(key: str, **_: object) -> ToolResult:
        try:
            keyboard.press_key(key)
        except ComputerControlError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=f"Pressed {key}.")

    async def scroll(amount: int = -400, **_: object) -> ToolResult:
        try:
            mouse.scroll(amount)
        except ComputerControlError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=f"Scrolled by {amount}.")

    async def list_windows(**_: object) -> ToolResult:
        try:
            titles = windows.list_windows()
        except ComputerControlError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=", ".join(titles) if titles else "No windows found.")

    async def focus_window(title: str, **_: object) -> ToolResult:
        try:
            found = windows.focus_window(title)
        except ComputerControlError as exc:
            return ToolResult(success=False, error=str(exc))
        if not found:
            return ToolResult(success=False, error=f"No window matching {title!r} was found.")
        return ToolResult(success=True, output=f"Focused window matching {title!r}.")

    registry.register(
        Tool(
            name="computer.open_application",
            description="Launch a desktop application by name (e.g. 'chrome', 'vscode').",
            parameters={
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
            permission=PermissionLevel.LOW,
            execute=open_application,
        )
    )
    registry.register(
        Tool(
            name="computer.close_application",
            description="Close a running application by (partial) process name.",
            parameters={
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=close_application,
        )
    )
    registry.register(
        Tool(
            name="computer.click",
            description="Click the mouse at absolute screen coordinates (x, y).",
            parameters={
                "type": "object",
                "properties": {
                    "x": {"type": "integer"},
                    "y": {"type": "integer"},
                    "button": {"type": "string", "enum": ["left", "right", "middle"], "default": "left"},
                },
                "required": ["x", "y"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=click,
        )
    )
    registry.register(
        Tool(
            name="computer.type",
            description="Type text at the current keyboard focus.",
            parameters={
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=type_text,
        )
    )
    registry.register(
        Tool(
            name="computer.press_key",
            description="Press a key or key combo, e.g. 'enter', 'ctrl+c'.",
            parameters={
                "type": "object",
                "properties": {"key": {"type": "string"}},
                "required": ["key"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=press_key,
        )
    )
    registry.register(
        Tool(
            name="computer.scroll",
            description="Scroll the focused window. Positive scrolls up, negative scrolls down.",
            parameters={"type": "object", "properties": {"amount": {"type": "integer", "default": -400}}},
            permission=PermissionLevel.LOW,
            execute=scroll,
        )
    )
    registry.register(
        Tool(
            name="computer.list_windows",
            description="List titles of currently open windows.",
            parameters={"type": "object", "properties": {}},
            permission=PermissionLevel.LOW,
            execute=list_windows,
        )
    )
    registry.register(
        Tool(
            name="computer.focus_window",
            description="Bring the window whose title/app name matches to the foreground.",
            parameters={
                "type": "object",
                "properties": {"title": {"type": "string"}},
                "required": ["title"],
            },
            permission=PermissionLevel.LOW,
            execute=focus_window,
        )
    )


def register_vision_tools(registry: ToolRegistry, llm: LLMProvider) -> None:
    """Registers tools that need the configured LLM to understand images.

    Kept separate from `register_computer_tools` because these need a
    provider reference (screenshots are sent to whichever AI provider is
    configured) rather than just OS-level calls.
    """

    async def describe_screen_tool(**_: object) -> ToolResult:
        try:
            description = await describe_screen(llm)
        except (ComputerControlError, VisionError) as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=description)

    async def click_element_tool(description: str, **_: object) -> ToolResult:
        try:
            point = await locate_element(llm, description)
        except (ComputerControlError, VisionError) as exc:
            return ToolResult(success=False, error=str(exc))
        if point is None:
            return ToolResult(success=False, error=f"Couldn't find anything matching {description!r} on screen.")
        try:
            mouse.click(point[0], point[1])
        except ComputerControlError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=f"Clicked {description!r} at {point}.")

    registry.register(
        Tool(
            name="computer.describe_screen",
            description="Look at the current screen and describe what's on it.",
            parameters={"type": "object", "properties": {}},
            permission=PermissionLevel.LOW,
            execute=describe_screen_tool,
        )
    )
    registry.register(
        Tool(
            name="computer.click_element",
            description=(
                "Find a UI element on screen by visual description (e.g. 'the settings "
                "gear icon') and click it, without needing hard-coded coordinates."
            ),
            parameters={
                "type": "object",
                "properties": {"description": {"type": "string"}},
                "required": ["description"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=click_element_tool,
        )
    )
