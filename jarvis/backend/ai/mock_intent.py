"""
Tiny keyword-based intent detector used only by `MockProvider`.

This is deliberately NOT natural-language understanding — it's a handful of
regexes that let the offline mock provider demonstrate the tool-calling
pipeline (see `llm.py`, `core/agent.py`) across every tool category with no
API key, including the confirmation flow (try "delete <path>"). Real intent
understanding for phrasing JARVIS hasn't seen before requires
`AI_PROVIDER=openai` or `anthropic`.

Regexes run against the original (not lower-cased) text so captured groups
— file paths, app names, remembered content — keep their real casing;
matching itself is case-insensitive.
"""
from __future__ import annotations

import re
import uuid

from backend.ai.llm import ToolCall

_URL_RE = re.compile(r"(https?://\S+|(?:[\w-]+\.)+[a-z]{2,}(?:/\S*)?)", re.IGNORECASE)


def _call(tool_name: str, **arguments: object) -> ToolCall:
    return ToolCall(id=f"mock-{uuid.uuid4().hex[:8]}", name=tool_name, arguments=arguments)


def detect_tool_intent(text: str, available_tools: set[str]) -> ToolCall | None:
    """Return a `ToolCall` if `text` clearly matches a supported tool, else None."""
    text = text.strip()

    if "computer.describe_screen" in available_tools and re.search(
        r"(what.?s (on|happening on)|describe)\s+(my |the )?screen", text, re.IGNORECASE
    ):
        return _call("computer.describe_screen")

    if "system.get_system_info" in available_tools and re.search(
        r"(system (status|info)|how.?s my computer|computer doing)", text, re.IGNORECASE
    ):
        return _call("system.get_system_info")

    remember_match = re.search(r"remember that\s+(.+)", text, re.IGNORECASE)
    if "memory.remember" in available_tools and remember_match:
        return _call("memory.remember", content=remember_match.group(1).strip())

    delete_match = re.search(r"\bdelete\b\s+(?:the\s+)?(?:file|files)?\s*(.+)", text, re.IGNORECASE)
    if "files.delete" in available_tools and delete_match:
        path = delete_match.group(1).strip().rstrip(".")
        if path:
            return _call("files.delete", path=path)

    if "browser.close" in available_tools and re.search(r"\bclose\b.*\bbrowser\b", text, re.IGNORECASE):
        return _call("browser.close")

    youtube_match = re.search(r"(?:on|in)\s+youtube.*?(?:for|about)?\s*[:\-]?\s*(.*)", text, re.IGNORECASE)
    if "browser.search" in available_tools and re.search(r"\byoutube\b", text, re.IGNORECASE):
        query = youtube_match.group(1).strip() if youtube_match and youtube_match.group(1) else text
        query = re.sub(r"^(search|find|look up)\s+", "", query, flags=re.IGNORECASE).strip() or text
        return _call("browser.search", query=query, engine="youtube")

    search_match = re.search(
        r"(?:search|google|look up)\s+(?:the web\s+)?(?:for\s+)?(.+)", text, re.IGNORECASE
    )
    if "browser.search" in available_tools and search_match:
        return _call("browser.search", query=search_match.group(1).strip(), engine="google")

    open_match = re.search(r"(?:go to|open|navigate to|launch|start)\s+(.+)", text, re.IGNORECASE)
    if open_match:
        candidate = open_match.group(1).strip()
        url_match = _URL_RE.search(candidate)
        if "browser.open" in available_tools and re.search(r"\bbrowser\b", candidate, re.IGNORECASE) and not url_match:
            return _call("browser.open")
        if "browser.navigate" in available_tools and url_match:
            return _call("browser.navigate", url=url_match.group(1))
        if "computer.open_application" in available_tools:
            return _call("computer.open_application", name=candidate)

    if "browser.extract_text" in available_tools and re.search(
        r"(summarize|what.?s on|read).*(page|website|webpage)", text, re.IGNORECASE
    ):
        return _call("browser.extract_text")

    return None
