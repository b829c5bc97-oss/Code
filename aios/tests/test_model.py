"""Model client: retries, failover, caching, budget and structured repair."""

from __future__ import annotations

import json

import pytest
from conftest import scripted

from aios.foundation.clock import ManualClock
from aios.foundation.config import ModelConfig
from aios.foundation.errors import (
    ProviderError,
    ProviderUnavailable,
    RateLimited,
    StructuredOutputError,
)
from aios.model.client import ModelClient, extract_json
from aios.model.provider import BaseProvider
from aios.model.providers.anthropic import AnthropicProvider
from aios.model.providers.deterministic import OfflineProvider, ScriptedProvider
from aios.model.types import Completion, Message, ModelRequest, Role
from aios.runtime.budget import Budget, Usage

SCHEMA = {
    "type": "object",
    "properties": {"name": {"type": "string"}, "count": {"type": "integer"}},
    "required": ["name", "count"],
    "additionalProperties": False,
}


class FailingProvider(BaseProvider):
    name = "failing"
    supports_tools = True

    def __init__(self, error, succeed_after: int = 999) -> None:
        self.error = error
        self.calls = 0
        self.succeed_after = succeed_after

    async def complete(self, request):
        self.calls += 1
        if self.calls > self.succeed_after:
            return Completion(text="finally", usage=Usage(10, 5), model="failing")
        raise self.error


class TestJsonExtraction:
    @pytest.mark.parametrize(
        "text",
        [
            '{"name": "x", "count": 1}',
            '```json\n{"name": "x", "count": 1}\n```',
            'Sure! Here you go:\n{"name": "x", "count": 1}\nHope that helps.',
            '```\n{"name": "x", "count": 1}\n```',
        ],
    )
    def test_json_is_recovered_from_common_wrappings(self, text):
        assert extract_json(text) == {"name": "x", "count": 1}

    def test_trailing_commas_are_repaired(self):
        assert extract_json('{"a": 1, "b": [2, 3,],}') == {"a": 1, "b": [2, 3]}

    def test_empty_response_is_reported_clearly(self):
        with pytest.raises(StructuredOutputError, match="empty"):
            extract_json("   ")

    def test_unparseable_text_reports_a_preview(self):
        with pytest.raises(StructuredOutputError) as excinfo:
            extract_json("this is definitely not json at all")
        assert "preview" in excinfo.value.context


class TestRetryAndFailover:
    async def test_transient_errors_are_retried(self, clock):
        provider = FailingProvider(ProviderUnavailable("503"), succeed_after=2)
        client = ModelClient([provider], ModelConfig(max_retries=3), clock=clock)
        completion = await client.complete(ModelRequest(messages=[Message.user("hi")]))
        assert completion.text == "finally"
        assert provider.calls == 3

    async def test_terminal_errors_are_not_retried(self, clock):
        provider = FailingProvider(ProviderError("bad request"))
        client = ModelClient([provider], ModelConfig(max_retries=3), clock=clock)
        with pytest.raises(ProviderError):
            await client.complete(ModelRequest(messages=[Message.user("hi")]))
        assert provider.calls == 1

    async def test_rate_limit_hint_is_honoured(self, clock):
        provider = FailingProvider(RateLimited("slow", retry_after=7), succeed_after=1)
        client = ModelClient([provider], ModelConfig(max_retries=2), clock=clock)
        await client.complete(ModelRequest(messages=[Message.user("hi")]))
        assert 7 in clock.slept

    async def test_failover_to_the_next_provider(self, clock):
        primary = FailingProvider(ProviderUnavailable("529"))
        secondary = ScriptedProvider(["from the backup"])
        client = ModelClient([primary, secondary], ModelConfig(max_retries=2), clock=clock)
        completion = await client.complete(ModelRequest(messages=[Message.user("hi")]))
        assert completion.text == "from the backup"

    async def test_backoff_is_bounded(self, clock):
        provider = FailingProvider(ProviderUnavailable("503"), succeed_after=3)
        client = ModelClient([provider], ModelConfig(max_retries=4), clock=clock)
        await client.complete(ModelRequest(messages=[Message.user("hi")]))
        assert all(delay <= 40 for delay in clock.slept)


class TestBudgetAccounting:
    async def test_usage_is_charged(self, clock):
        provider = ScriptedProvider([Completion(text="ok", usage=Usage(1000, 500), model="m")])
        budget = Budget(clock=clock)
        budget.start()
        client = ModelClient([provider], ModelConfig(), budget=budget, clock=clock)
        await client.complete(ModelRequest(messages=[Message.user("hi")]))
        assert budget.usage.input_tokens == 1000
        assert budget.model_calls == 1
        assert budget.usd > 0

    async def test_budget_ceiling_blocks_further_calls(self, clock):
        from aios.foundation.config import BudgetConfig
        from aios.foundation.errors import BudgetExceeded

        budget = Budget(limits=BudgetConfig(max_model_calls=1), clock=clock)
        budget.start()
        client = ModelClient(
            [ScriptedProvider(["a", "b"])], ModelConfig(cache_enabled=False),
            budget=budget, clock=clock,
        )
        await client.complete(ModelRequest(messages=[Message.user("one")]))
        with pytest.raises(BudgetExceeded):
            await client.complete(ModelRequest(messages=[Message.user("two")]))


class TestCaching:
    async def test_identical_requests_are_served_from_cache(self, clock):
        provider = ScriptedProvider(["only once"])
        client = ModelClient([provider], ModelConfig(cache_enabled=True), clock=clock)
        request = ModelRequest(messages=[Message.user("same question")])
        first = await client.complete(request)
        second = await client.complete(ModelRequest(messages=[Message.user("same question")]))
        assert first.text == second.text == "only once"
        assert second.cached and len(provider.requests) == 1

    async def test_different_requests_are_not_confused(self, clock):
        provider = ScriptedProvider(["a", "b"])
        client = ModelClient([provider], ModelConfig(cache_enabled=True), clock=clock)
        assert (await client.ask("first")) == "a"
        assert (await client.ask("second")) == "b"


class TestStructuredOutput:
    async def test_valid_json_passes_through(self, clock):
        client = scripted({"name": "x", "count": 3})
        assert await client.structured("go", SCHEMA) == {"name": "x", "count": 3}

    async def test_invalid_output_is_repaired(self, clock):
        client = scripted(
            '{"name": "x"}',                      # missing `count`
            '{"name": "x", "count": 7}',          # repaired
        )
        assert await client.structured("go", SCHEMA) == {"name": "x", "count": 7}

    async def test_repair_prompt_names_the_actual_errors(self, clock):
        provider = ScriptedProvider(['{"name": "x"}', '{"name": "x", "count": 1}'])
        client = ModelClient([provider], ModelConfig(cache_enabled=False, max_retries=1))
        await client.structured("go", SCHEMA)
        repair_prompt = provider.requests[1].messages[-1].content
        assert "missing required property 'count'" in repair_prompt

    async def test_repair_gives_up_and_says_why(self, clock):
        client = scripted('{"bad": 1}', '{"still": "bad"}', '{"nope": true}')
        with pytest.raises(StructuredOutputError) as excinfo:
            await client.structured("go", SCHEMA, repair_attempts=2)
        assert excinfo.value.context["errors"]

    async def test_coercion_avoids_a_pointless_repair_round(self, clock):
        provider = ScriptedProvider(['{"name": "x", "count": "5"}'])
        client = ModelClient([provider], ModelConfig(cache_enabled=False))
        assert await client.structured("go", SCHEMA) == {"name": "x", "count": 5}
        assert len(provider.requests) == 1


class TestOfflineProvider:
    async def test_offline_is_extractive_not_generative(self):
        provider = OfflineProvider()
        assert provider.generative is False
        completion = await provider.complete(
            ModelRequest(messages=[Message.user("First sentence. Second sentence.")])
        )
        assert "First sentence" in completion.text

    async def test_offline_satisfies_a_schema_minimally(self):
        completion = await OfflineProvider().complete(
            ModelRequest(messages=[Message.user("x")], json_schema=SCHEMA)
        )
        payload = json.loads(completion.text)
        assert set(payload) == {"name", "count"}

    def test_client_reports_that_it_cannot_generate(self):
        client = ModelClient([OfflineProvider()], ModelConfig())
        assert not client.can_generate()

    def test_client_reports_generative_when_a_real_provider_exists(self):
        client = ModelClient([ScriptedProvider(["x"]), OfflineProvider()], ModelConfig())
        assert client.can_generate()


class TestAnthropicEncoding:
    """Wire-format correctness, verified without touching the network."""

    @pytest.fixture
    def provider(self):
        return AnthropicProvider(api_key="sk-ant-test", model="claude-sonnet-5")

    def test_system_prompt_is_hoisted_and_marked_cacheable(self, provider):
        body = provider._encode(
            ModelRequest(messages=[Message.user("hi")], system="you are helpful")
        )
        assert body["system"][0]["text"] == "you are helpful"
        assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
        assert all(m["role"] != "system" for m in body["messages"])

    def test_tool_results_collapse_into_one_user_turn(self, provider):
        body = provider._encode(
            ModelRequest(
                messages=[
                    Message.user("do it"),
                    Message.assistant("working"),
                    Message.tool("call_1", "result one"),
                    Message.tool("call_2", "result two"),
                ]
            )
        )
        tool_turns = [m for m in body["messages"] if isinstance(m["content"], list)
                      and m["content"][0].get("type") == "tool_result"]
        assert len(tool_turns) == 1
        assert len(tool_turns[0]["content"]) == 2

    def test_structured_output_uses_a_forced_tool(self, provider):
        body = provider._encode(
            ModelRequest(messages=[Message.user("hi")], json_schema=SCHEMA)
        )
        assert body["tool_choice"] == {"type": "tool", "name": "respond"}
        assert body["tools"][0]["input_schema"] == SCHEMA

    def test_forced_tool_output_is_decoded_as_json_text(self, provider):
        completion = provider._decode(
            {
                "content": [{"type": "tool_use", "id": "t", "name": "respond",
                             "input": {"name": "x", "count": 1}}],
                "usage": {"input_tokens": 5, "output_tokens": 2},
                "model": "claude-sonnet-5",
            },
            ModelRequest(messages=[Message.user("hi")], json_schema=SCHEMA),
        )
        assert json.loads(completion.text) == {"name": "x", "count": 1}
        assert completion.tool_calls == []

    def test_cached_tokens_are_accounted(self, provider):
        completion = provider._decode(
            {"content": [{"type": "text", "text": "hi"}],
             "usage": {"input_tokens": 10, "output_tokens": 5,
                       "cache_read_input_tokens": 900}},
            ModelRequest(messages=[Message.user("hi")]),
        )
        assert completion.usage.cached_tokens == 900
        assert completion.usage.input_tokens == 910

    def test_no_key_means_unavailable(self):
        assert not AnthropicProvider(api_key="").available()


class TestMessageTypes:
    def test_round_trip(self):
        message = Message.assistant("text")
        assert message.to_dict()["role"] == Role.ASSISTANT.value

    def test_cache_key_is_content_addressed(self):
        a = ModelRequest(messages=[Message.user("x")], system="s")
        b = ModelRequest(messages=[Message.user("x")], system="s")
        c = ModelRequest(messages=[Message.user("y")], system="s")
        assert a.cache_key() == b.cache_key() != c.cache_key()


def test_manual_clock_does_not_actually_sleep():
    clock = ManualClock()
    start = clock.monotonic()
    import asyncio

    asyncio.run(clock.sleep(3600))
    assert clock.monotonic() - start == 3600
