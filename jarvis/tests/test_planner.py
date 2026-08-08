import pytest

from backend.ai.llm import ChatMessage, LLMError, LLMProvider, MockProvider
from backend.core.planner import Planner


class ScriptedTextProvider(LLMProvider):
    name = "scripted-text"

    def __init__(self, reply: str | None = None, error: Exception | None = None):
        self._reply = reply
        self._error = error

    async def chat(self, messages: list[ChatMessage]) -> str:
        if self._error:
            raise self._error
        return self._reply


@pytest.mark.asyncio
async def test_mock_provider_never_plans():
    planner = Planner(MockProvider())
    plan = await planner.create_plan("research something and write a report", ["browser.search"])
    assert plan == []


@pytest.mark.asyncio
async def test_planner_parses_json_array():
    provider = ScriptedTextProvider(reply='Sure, here is a plan:\n["Search the web", "Summarize findings"]')
    planner = Planner(provider)
    plan = await planner.create_plan("research topic X", ["browser.search"])
    assert plan == ["Search the web", "Summarize findings"]


@pytest.mark.asyncio
async def test_planner_returns_empty_list_for_garbage_response():
    provider = ScriptedTextProvider(reply="I don't understand.")
    planner = Planner(provider)
    plan = await planner.create_plan("do something", ["browser.search"])
    assert plan == []


@pytest.mark.asyncio
async def test_planner_returns_empty_list_on_llm_error():
    provider = ScriptedTextProvider(error=LLMError("boom"))
    planner = Planner(provider)
    plan = await planner.create_plan("do something", ["browser.search"])
    assert plan == []


@pytest.mark.asyncio
async def test_planner_caps_at_eight_steps():
    steps = [f"Step {i}" for i in range(20)]
    import json

    provider = ScriptedTextProvider(reply=json.dumps(steps))
    planner = Planner(provider)
    plan = await planner.create_plan("a very big task", [])
    assert len(plan) == 8
