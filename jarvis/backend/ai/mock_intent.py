"""
Tiny keyword-based intent detector used only by `MockProvider`.

This is deliberately NOT natural-language understanding — it's a handful of
regexes that let the offline mock provider demonstrate the tool-calling
pipeline (see `llm.py`, `core/agent.py`) without needing a real LLM. Real
intent understanding for phrasing JARVIS hasn't seen before requires
`AI_PROVIDER=openai` or `anthropic`.
"""
from __future__ import annotations

import re
import uuid

from backend.ai.llm import ToolCall

_URL_RE = re.compile(r"(https?://\S+|(?:[\w-]+\.)+[a-z]{2,}(?:/\S*)?)", re.IGNORECASE)


def _call(name: str, **arguments: object) -> ToolCall:
    return ToolCall(id=f"mock-{uuid.uuid4().hex[:8]}", name=name, arguments=arguments)


def detect_tool_intent(text: str, available_tools: set[str]) -> ToolCall | None:
    """Return a `ToolCall` if `text` clearly matches a supported tool, else None."""
    lowered = text.strip().lower()

    if "browser.close" in available_tools and re.search(r"\bclose\b.*\bbrowser\b", lowered):
        return _call("browser.close")

    youtube_match = re.search(r"(?:on|in)\s+youtube.*?(?:for|about)?\s*[:\-]?\s*(.*)", lowered)
    if "browser.search" in available_tools and "youtube" in lowered:
        query = youtube_match.group(1).strip() if youtube_match else lowered
        query = re.sub(r"^(search|find|look up)\s+", "", query).strip() or lowered
        return _call("browser.search", query=query, engine="youtube")

    search_match = re.search(
        r"(?:search|google|look up)\s+(?:the web\s+)?(?:for\s+)?(.+)", lowered
    )
    if "browser.search" in available_tools and search_match:
        return _call("browser.search", query=search_match.group(1).strip(), engine="google")

    nav_match = re.search(r"(?:go to|open|navigate to)\s+(.+)", lowered)
    if "browser.navigate" in available_tools and nav_match:
        candidate = nav_match.group(1).strip()
        url_match = _URL_RE.search(candidate)
        if url_match and "browser" not in candidate:
            return _call("browser.navigate", url=url_match.group(1))

    if "browser.open" in available_tools and re.search(r"\bopen\b.*\bbrowser\b", lowered):
        return _call("browser.open")

    if "browser.extract_text" in available_tools and re.search(
        r"(summarize|what.?s on|read).*(page|website|webpage|screen)", lowered
    ):
        return _call("browser.extract_text")

    return None
