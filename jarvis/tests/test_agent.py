import pytest

from backend.ai.llm import ChatMessage, LLMError, LLMProvider
from backend.core.agent import Agent, AgentState
from backend.core.config import Settings
from backend.core.memory import ConversationStore


class StubProvider(LLMProvider):
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


@pytest.mark.asyncio
async def test_handle_message_returns_reply_and_updates_memory():
    provider = StubProvider(reply="Hi there!")
    memory = ConversationStore(max_messages=20)
    agent = Agent(settings=Settings(), llm=provider, memory=memory)

    result = await agent.handle_message("session-1", "hello jarvis")

    assert result.reply == "Hi there!"
    assert result.state == AgentState.IDLE
    assert result.provider == "stub"

    history = memory.get_history("session-1")
    assert [m.role for m in history] == ["user", "assistant"]
    assert history[0].content == "hello jarvis"
    assert history[1].content == "Hi there!"


@pytest.mark.asyncio
async def test_handle_message_includes_system_persona():
    provider = StubProvider()
    agent = Agent(settings=Settings(), llm=provider, memory=ConversationStore())

    await agent.handle_message("session-1", "hi")

    assert provider.last_messages[0].role == "system"


@pytest.mark.asyncio
async def test_handle_message_empty_text_short_circuits():
    provider = StubProvider()
    agent = Agent(settings=Settings(), llm=provider, memory=ConversationStore())

    result = await agent.handle_message("session-1", "   ")

    assert provider.last_messages is None
    assert result.state == AgentState.IDLE


@pytest.mark.asyncio
async def test_handle_message_llm_error_reports_error_state():
    provider = StubProvider(error=LLMError("boom"))
    agent = Agent(settings=Settings(), llm=provider, memory=ConversationStore())

    result = await agent.handle_message("session-1", "hi")

    assert result.state == AgentState.ERROR
    assert "boom" in result.reply
