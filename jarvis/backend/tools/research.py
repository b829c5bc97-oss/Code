"""
Research mode — Phase 8.

`research.gather` collects raw material from a couple of real web searches
(via the same Playwright session `browser.*` uses) — the actual comparing,
summarizing, and fact/uncertainty distinction described in the project
spec is then done by the LLM in the next tool-loop turn, using this tool's
output as its source material. That split keeps the tool itself simple and
honest: it fetches and cites, it doesn't claim to "know" anything.

No sources are invented — if a fetch fails, that's reported as a failure
for that source, not silently dropped.
"""
from __future__ import annotations

from backend.browser import browser_actions
from backend.browser.browser import BrowserError, BrowserSession, get_browser_session
from backend.core.permissions import PermissionLevel
from backend.tools.registry import Tool, ToolRegistry, ToolResult


async def _fetch_source(session: BrowserSession, query: str, engine: str) -> str:
    try:
        _msg, reason = await browser_actions.search(session, query, engine)
        if reason:
            return f"[{engine}] Stopped: {reason}"
        text = await browser_actions.extract_text(session, max_chars=2500)
        page = await session.get_page()
        return f"[{engine}] Source: {page.url}\n{text}"
    except BrowserError as exc:
        return f"[{engine}] Couldn't fetch a result: {exc}"


def register_research_tools(registry: ToolRegistry, session: BrowserSession | None = None) -> None:
    session = session or get_browser_session()

    async def gather(topic: str, **_: object) -> ToolResult:
        results = [
            await _fetch_source(session, topic, "google"),
            await _fetch_source(session, topic, "bing"),
        ]
        combined = "\n\n---\n\n".join(results)
        return ToolResult(success=True, output=combined)

    registry.register(
        Tool(
            name="research.gather",
            description=(
                "Search multiple sources for a topic and return their raw text with "
                "source URLs, for you to compare and summarize — distinguish facts from "
                "uncertain claims and always cite the source URLs in your answer."
            ),
            parameters={
                "type": "object",
                "properties": {"topic": {"type": "string"}},
                "required": ["topic"],
            },
            permission=PermissionLevel.LOW,
            execute=gather,
        )
    )
