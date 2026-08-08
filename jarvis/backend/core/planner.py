"""
Multi-step task planner — Phase 6.

Will be responsible for breaking a complex request ("build me a website
for a watch company") into an ordered list of tool calls, each tagged
with the permission level it requires, before `Agent` executes them.

Not implemented yet. `Agent.handle_message` currently answers every
request directly through the LLM with no planning or tool use.
"""
from __future__ import annotations


class Planner:
    def create_plan(self, goal: str) -> list[str]:
        raise NotImplementedError(
            "Task planning is not implemented in Phase 1. See core/agent.py "
            "for the current (LLM-only) request flow."
        )
