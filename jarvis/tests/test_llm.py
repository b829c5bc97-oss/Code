import pytest

from backend.ai.llm import ChatMessage, MockProvider, ToolSchema, get_llm_provider
from backend.core.config import Settings

BROWSER_TOOLS = [
    ToolSchema(name="browser.open", description="", parameters={}),
    ToolSchema(name="browser.navigate", description="", parameters={}),
    ToolSchema(name="browser.search", description="", parameters={}),
    ToolSchema(name="browser.extract_text", description="", parameters={}),
]


@pytest.mark.asyncio
async def test_mock_provider_echoes_last_user_message():
    provider = MockProvider()
    reply = await provider.chat(
        [
            ChatMessage(role="system", content="you are jarvis"),
            ChatMessage(role="user", content="hello there"),
        ]
    )
    assert "hello there" in reply
    assert "mock" in reply.lower()


@pytest.mark.asyncio
async def test_mock_provider_chat_with_tools_no_tools_falls_back_to_text():
    provider = MockProvider()
    result = await provider.chat_with_tools(
        [ChatMessage(role="user", content="hello")], tools=[]
    )
    assert result.tool_calls == []
    assert result.text is not None


@pytest.mark.asyncio
async def test_mock_provider_detects_search_intent():
    provider = MockProvider()
    result = await provider.chat_with_tools(
        [ChatMessage(role="user", content="search the web for python tutorials")],
        tools=BROWSER_TOOLS,
    )
    assert result.text is None
    assert len(result.tool_calls) == 1
    call = result.tool_calls[0]
    assert call.name == "browser.search"
    assert "python tutorials" in call.arguments["query"]


@pytest.mark.asyncio
async def test_mock_provider_wraps_up_after_tool_result():
    provider = MockProvider()
    result = await provider.chat_with_tools(
        [
            ChatMessage(role="user", content="search youtube for ai news"),
            ChatMessage(role="assistant", content="", tool_calls=[]),
            ChatMessage(role="tool", content="Opened youtube search results.", tool_call_id="1"),
        ],
        tools=BROWSER_TOOLS,
    )
    assert result.tool_calls == []
    assert "Opened youtube search results." in result.text


def test_get_llm_provider_defaults_to_mock():
    settings = Settings(ai_provider="mock")
    provider = get_llm_provider(settings)
    assert provider.name == "mock"


def test_get_llm_provider_openai_requires_api_key():
    from backend.ai.llm import LLMError

    settings = Settings(ai_provider="openai", openai_api_key="")
    with pytest.raises(LLMError):
        get_llm_provider(settings)


def test_get_llm_provider_anthropic_requires_api_key():
    from backend.ai.llm import LLMError

    settings = Settings(ai_provider="anthropic", anthropic_api_key="")
    with pytest.raises(LLMError):
        get_llm_provider(settings)
