"""
Multi-step task planner.

For requests that clearly need more than one tool call, `Planner` asks the
LLM for a short upfront plan (a handful of plain-language steps) before the
agent starts executing — matching the flow in the project spec:

    UNDERSTAND -> CHECK MEMORY -> DETERMINE TOOLS -> CREATE PLAN -> ...

This is *not* the model deciding tool calls (that's `Agent`'s tool loop in
`core/agent.py`) — it's a short, user-visible summary of the approach,
shown in the UI's task panel, generated once per turn. The plan is
advisory: the agent's tool loop still decides each actual step; nothing
here enforces that execution follows the plan verbatim.

The `mock` provider has no real reasoning to plan with, so `Planner`
skips planning entirely rather than fabricating a plausible-looking list —
see `Agent`, which only calls this for real providers.
"""
from __future__ import annotations

import json
import re

from backend.ai.llm import ChatMessage, LLMError, LLMProvider

_JSON_ARRAY_RE = re.compile(r"\[.*\]", re.DOTALL)

_PLAN_PROMPT = (
    "Break the following user request into a short ordered plan for a personal AI "
    "assistant to follow. At most 6 steps, each a few words, plain language, no "
    "numbering. Only include this if the request genuinely needs multiple steps — "
    "for a simple one-step request, respond with an empty array.\n"
    "Respond with ONLY a JSON array of strings and nothing else.\n\n"
    "Available tools: {tools}\n"
    "Request: {goal!r}"
)


class Planner:
    def __init__(self, llm: LLMProvider):
        self._llm = llm

    async def create_plan(self, goal: str, tool_names: list[str]) -> list[str]:
        if self._llm.name == "mock":
            return []

        prompt = _PLAN_PROMPT.format(tools=", ".join(tool_names) or "none", goal=goal)
        try:
            raw = await self._llm.chat([ChatMessage(role="user", content=prompt)])
        except LLMError:
            return []

        match = _JSON_ARRAY_RE.search(raw)
        if not match:
            return []
        try:
            steps = json.loads(match.group(0))
        except json.JSONDecodeError:
            return []
        if not isinstance(steps, list):
            return []
        return [str(step).strip() for step in steps if str(step).strip()][:8]
