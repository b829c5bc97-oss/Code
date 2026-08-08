"""
Registers the Phase 3 browser tools into the tool registry.

Each tool wraps a function from `browser/browser_actions.py`, catches
`BrowserError`, and returns a `ToolResult` — tool execution should never
raise into the agent loop.

If a page looks like it needs a human (CAPTCHA, login — see
`detect_requires_human`), the tool's output is prefixed with
`HUMAN_REQUIRED:` so `Agent` can recognize it and hand control back to the
user instead of continuing to click around a page it can't get past.
"""
from __future__ import annotations

from backend.browser import browser_actions
from backend.browser.browser import BrowserError, BrowserSession, get_browser_session
from backend.core.permissions import PermissionLevel
from backend.tools.registry import Tool, ToolRegistry, ToolResult

HUMAN_REQUIRED_PREFIX = "HUMAN_REQUIRED:"


def _human_required_output(reason: str) -> str:
    return f"{HUMAN_REQUIRED_PREFIX} {reason}"


def register_browser_tools(registry: ToolRegistry, session: BrowserSession | None = None) -> None:
    session = session or get_browser_session()

    async def open_(**_: object) -> ToolResult:
        try:
            await session.ensure_started()
        except BrowserError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output="Browser opened.")

    async def navigate(url: str, **_: object) -> ToolResult:
        try:
            message, reason = await browser_actions.navigate(session, url)
        except BrowserError as exc:
            return ToolResult(success=False, error=str(exc))
        if reason:
            return ToolResult(success=True, output=_human_required_output(reason))
        return ToolResult(success=True, output=message)

    async def search(query: str, engine: str = "google", **_: object) -> ToolResult:
        try:
            message, reason = await browser_actions.search(session, query, engine)
        except BrowserError as exc:
            return ToolResult(success=False, error=str(exc))
        if reason:
            return ToolResult(success=True, output=_human_required_output(reason))
        return ToolResult(success=True, output=message)

    async def extract_text(max_chars: int = browser_actions.MAX_EXTRACT_CHARS, **_: object) -> ToolResult:
        try:
            text = await browser_actions.extract_text(session, max_chars)
        except BrowserError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=text)

    async def click(text: str, **_: object) -> ToolResult:
        try:
            message = await browser_actions.click(session, text)
        except BrowserError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=message)

    async def type_text(text: str, target: str | None = None, **_: object) -> ToolResult:
        try:
            message = await browser_actions.type_text(session, text, target)
        except BrowserError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=message)

    async def scroll(direction: str = "down", amount: int = 800, **_: object) -> ToolResult:
        try:
            message = await browser_actions.scroll(session, direction, amount)
        except BrowserError as exc:
            return ToolResult(success=False, error=str(exc))
        return ToolResult(success=True, output=message)

    async def close(**_: object) -> ToolResult:
        await session.close()
        return ToolResult(success=True, output="Browser closed.")

    registry.register(
        Tool(
            name="browser.open",
            description="Open (launch) the browser if it isn't already running.",
            parameters={"type": "object", "properties": {}},
            permission=PermissionLevel.LOW,
            execute=open_,
        )
    )
    registry.register(
        Tool(
            name="browser.navigate",
            description="Navigate the browser to a specific URL.",
            parameters={
                "type": "object",
                "properties": {"url": {"type": "string", "description": "URL to open"}},
                "required": ["url"],
            },
            permission=PermissionLevel.LOW,
            execute=navigate,
        )
    )
    registry.register(
        Tool(
            name="browser.search",
            description="Search the web (Google, YouTube, or Bing) for a query.",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "engine": {
                        "type": "string",
                        "enum": ["google", "youtube", "bing"],
                        "default": "google",
                    },
                },
                "required": ["query"],
            },
            permission=PermissionLevel.LOW,
            execute=search,
        )
    )
    registry.register(
        Tool(
            name="browser.extract_text",
            description="Read the visible text of the current page.",
            parameters={
                "type": "object",
                "properties": {"max_chars": {"type": "integer", "default": 4000}},
            },
            permission=PermissionLevel.LOW,
            execute=extract_text,
        )
    )
    registry.register(
        Tool(
            name="browser.click",
            description="Click the first element on the page matching visible text.",
            parameters={
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=click,
        )
    )
    registry.register(
        Tool(
            name="browser.type",
            description=(
                "Type text into an input field on the page. `target` optionally names the "
                "field by its placeholder or label; without it, the first text input is used."
            ),
            parameters={
                "type": "object",
                "properties": {"text": {"type": "string"}, "target": {"type": "string"}},
                "required": ["text"],
            },
            permission=PermissionLevel.MEDIUM,
            execute=type_text,
        )
    )
    registry.register(
        Tool(
            name="browser.scroll",
            description="Scroll the current page up or down.",
            parameters={
                "type": "object",
                "properties": {
                    "direction": {"type": "string", "enum": ["up", "down"], "default": "down"},
                    "amount": {"type": "integer", "default": 800},
                },
            },
            permission=PermissionLevel.LOW,
            execute=scroll,
        )
    )
    registry.register(
        Tool(
            name="browser.close",
            description="Close the browser.",
            parameters={"type": "object", "properties": {}},
            permission=PermissionLevel.LOW,
            execute=close,
        )
    )
