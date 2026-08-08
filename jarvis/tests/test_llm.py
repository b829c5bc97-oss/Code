import pytest

from backend.ai.llm import ChatMessage, MockProvider, get_llm_provider
from backend.core.config import Settings


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
