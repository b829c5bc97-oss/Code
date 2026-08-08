import pytest

from backend.ai.llm import ChatMessage, LLMError, LLMProvider, LLMResult, ToolCall, ToolSchema
from backend.core.agent import Agent, AgentState
from backend.core.config import Settings
from backend.core.memory import ConversationStore
from backend.core.permissions import PermissionLevel
from backend.tools.registry import Tool, ToolRegistry, ToolResult


class StubProvider(LLMProvider):
    """Plain-text provider — ignores tools entirely, like a non-tool-aware model."""

    name = "stub"

    def __init__(self, reply: str = "stub reply", error: Exception | None = None):
        self._reply = reply
        self._error = error
        self.last_messages: list[ChatMessage] | None = None

    async def chat(self, messages: list[ChatMessage]) -> str:
        self.last_messages = messages
        if self._error:
            raise self._error
        return self._reply


class ScriptedToolProvider(LLMProvider):
    """Returns a pre-scripted sequence of LLMResults, one per `chat_with_tools` call."""

    name = "scripted"

    def __init__(self, script: list[LLMResult]):
        self._script = list(script)
        self.calls: list[list[ChatMessage]] = []

    async def chat(self, messages: list[ChatMessage]) -> str:
        result = await self.chat_with_tools(messages, [])
        return result.text or ""

    async def chat_with_tools(
        self, messages: list[ChatMessage], tools: list[ToolSchema]
    ) -> LLMResult:
        self.calls.append(messages)
        return self._script.pop(0)


def make_tool(name: str, result: ToolResult, permission=PermissionLevel.LOW) -> Tool:
    async def execute(**_kwargs) -> ToolResult:
        return result

    return Tool(name=name, description="test tool", parameters={"type": "object"}, permission=permission, execute=execute)


@pytest.mark.asyncio
async def test_handle_message_returns_reply_and_updates_memory():
    provider = StubProvider(reply="Hi there!")
    memory = ConversationStore(max_messages=20)
    agent = Agent(settings=Settings(), llm=provider, memory=memory, tool_registry=ToolRegistry())

    result = await agent.handle_message("session-1", "hello jarvis")

    assert result.reply == "Hi there!"
    assert result.state == AgentState.IDLE
    assert result.provider == "stub"
    assert result.tool_activity == []

    history = memory.get_history("session-1")
    assert [m.role for m in history] == ["user", "assistant"]
    assert history[0].content == "hello jarvis"
    assert history[1].content == "Hi there!"


@pytest.mark.asyncio
async def test_handle_message_includes_system_persona():
    provider = StubProvider()
    agent = Agent(
        settings=Settings(), llm=provider, memory=ConversationStore(), tool_registry=ToolRegistry()
    )

    await agent.handle_message("session-1", "hi")

    assert provider.last_messages[0].role == "system"


@pytest.mark.asyncio
async def test_handle_message_empty_text_short_circuits():
    provider = StubProvider()
    agent = Agent(
        settings=Settings(), llm=provider, memory=ConversationStore(), tool_registry=ToolRegistry()
    )

    result = await agent.handle_message("session-1", "   ")

    assert provider.last_messages is None
    assert result.state == AgentState.IDLE


@pytest.mark.asyncio
async def test_handle_message_llm_error_reports_error_state():
    provider = StubProvider(error=LLMError("boom"))
    agent = Agent(
        settings=Settings(), llm=provider, memory=ConversationStore(), tool_registry=ToolRegistry()
    )

    result = await agent.handle_message("session-1", "hi")

    assert result.state == AgentState.ERROR
    assert "boom" in result.reply


@pytest.mark.asyncio
async def test_agent_executes_tool_call_and_reports_final_answer():
    registry = ToolRegistry()
    registry.register(make_tool("browser.open", ToolResult(success=True, output="Browser opened.")))

    provider = ScriptedToolProvider(
        [
            LLMResult(text=None, tool_calls=[ToolCall(id="1", name="browser.open", arguments={})]),
            LLMResult(text="Done — Chrome is open.", tool_calls=[]),
        ]
    )
    agent = Agent(
        settings=Settings(), llm=provider, memory=ConversationStore(), tool_registry=registry
    )

    result = await agent.handle_message("s1", "open chrome")

    assert result.state == AgentState.IDLE
    assert result.reply == "Done — Chrome is open."
    assert len(result.tool_activity) == 1
    assert result.tool_activity[0].name == "browser.open"
    assert result.tool_activity[0].success is True
    # second chat_with_tools call should have seen the tool's observation
    second_call_messages = provider.calls[1]
    assert any(m.role == "tool" for m in second_call_messages)


@pytest.mark.asyncio
async def test_agent_reports_tool_failure_in_activity():
    registry = ToolRegistry()
    registry.register(
        make_tool("browser.navigate", ToolResult(success=False, error="Couldn't open example.com"))
    )
    provider = ScriptedToolProvider(
        [
            LLMResult(
                text=None,
                tool_calls=[ToolCall(id="1", name="browser.navigate", arguments={"url": "example.com"})],
            ),
            LLMResult(text="I couldn't open that page.", tool_calls=[]),
        ]
    )
    agent = Agent(
        settings=Settings(), llm=provider, memory=ConversationStore(), tool_registry=registry
    )

    result = await agent.handle_message("s1", "go to example.com")

    assert result.tool_activity[0].success is False
    assert "example.com" in result.tool_activity[0].summary


@pytest.mark.asyncio
async def test_agent_stops_and_waits_for_human_on_captcha():
    registry = ToolRegistry()
    registry.register(
        make_tool(
            "browser.navigate",
            ToolResult(success=True, output="HUMAN_REQUIRED: This page has a CAPTCHA."),
        )
    )
    provider = ScriptedToolProvider(
        [
            LLMResult(
                text=None,
                tool_calls=[ToolCall(id="1", name="browser.navigate", arguments={"url": "x.com"})],
            ),
        ]
    )
    agent = Agent(
        settings=Settings(), llm=provider, memory=ConversationStore(), tool_registry=registry
    )

    result = await agent.handle_message("s1", "go to x.com")

    assert result.state == AgentState.WAITING_FOR_CONFIRMATION
    assert "CAPTCHA" in result.reply


@pytest.mark.asyncio
async def test_agent_blocks_high_permission_tools():
    registry = ToolRegistry()
    registry.register(
        make_tool(
            "files.delete",
            ToolResult(success=True, output="deleted"),
            permission=PermissionLevel.HIGH,
        )
    )
    provider = ScriptedToolProvider(
        [
            LLMResult(
                text=None,
                tool_calls=[ToolCall(id="1", name="files.delete", arguments={})],
            ),
        ]
    )
    agent = Agent(
        settings=Settings(), llm=provider, memory=ConversationStore(), tool_registry=registry
    )

    result = await agent.handle_message("s1", "delete everything")

    assert result.state == AgentState.WAITING_FOR_CONFIRMATION
    assert result.tool_activity == []  # never executed


@pytest.mark.asyncio
async def test_agent_gives_up_after_max_tool_steps():
    registry = ToolRegistry()
    registry.register(make_tool("browser.scroll", ToolResult(success=True, output="scrolled")))

    infinite_call = LLMResult(
        text=None, tool_calls=[ToolCall(id="1", name="browser.scroll", arguments={})]
    )
    provider = ScriptedToolProvider([infinite_call] * 10)
    agent = Agent(
        settings=Settings(max_tool_steps=3),
        llm=provider,
        memory=ConversationStore(),
        tool_registry=registry,
    )

    result = await agent.handle_message("s1", "keep scrolling")

    assert result.state == AgentState.ERROR
    assert len(provider.calls) == 3
