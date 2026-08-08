"""
Pluggable LLM provider layer.

JARVIS must never be hard-wired to a single AI vendor. Every provider
implements the same small `LLMProvider` interface; `get_llm_provider()`
picks the concrete implementation from `Settings.ai_provider` at call time.

Adding a new provider later (local models, Gemini, etc.) means writing one
class here and registering it in `_PROVIDERS` — nothing else in the app
needs to change.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from backend.core.config import Settings, get_settings


@dataclass
class ChatMessage:
    role: str  # "system" | "user" | "assistant"
    content: str


class LLMError(RuntimeError):
    """Raised when a provider cannot produce a completion (bad key, network, etc.)."""


class LLMProvider(ABC):
    """Common interface every LLM backend must implement."""

    name: str = "base"

    @abstractmethod
    async def chat(self, messages: list[ChatMessage]) -> str:
        """Send a conversation and return the assistant's reply as plain text."""
        raise NotImplementedError


class MockProvider(LLMProvider):
    """Deterministic, offline provider.

    Used as the default so the app is runnable out of the box with no API
    key, and so automated tests never depend on network access or billing.
    It is intentionally simple and clearly labelled — JARVIS never pretends
    a mock reply came from a real model.
    """

    name = "mock"

    async def chat(self, messages: list[ChatMessage]) -> str:
        last_user = next((m.content for m in reversed(messages) if m.role == "user"), "")
        return (
            "[mock provider — configure a real AI_PROVIDER in .env for actual answers]\n"
            f"You said: {last_user!r}"
        )


class OpenAIProvider(LLMProvider):
    name = "openai"

    def __init__(self, settings: Settings):
        if not settings.openai_api_key:
            raise LLMError(
                "OPENAI_API_KEY is not set. Add it to your .env file to use the "
                "OpenAI provider."
            )
        try:
            from openai import AsyncOpenAI
        except ImportError as exc:  # pragma: no cover - dependency guard
            raise LLMError(
                "The 'openai' package is not installed. Run `pip install -r requirements.txt`."
            ) from exc

        self._client = AsyncOpenAI(api_key=settings.openai_api_key)
        self._model = settings.ai_model or "gpt-4o-mini"

    async def chat(self, messages: list[ChatMessage]) -> str:
        try:
            response = await self._client.chat.completions.create(
                model=self._model,
                messages=[{"role": m.role, "content": m.content} for m in messages],
            )
        except Exception as exc:  # noqa: BLE001 - surface as a clean LLMError
            raise LLMError(f"OpenAI request failed: {exc}") from exc
        return response.choices[0].message.content or ""


class AnthropicProvider(LLMProvider):
    name = "anthropic"

    def __init__(self, settings: Settings):
        if not settings.anthropic_api_key:
            raise LLMError(
                "ANTHROPIC_API_KEY is not set. Add it to your .env file to use the "
                "Anthropic provider."
            )
        try:
            from anthropic import AsyncAnthropic
        except ImportError as exc:  # pragma: no cover - dependency guard
            raise LLMError(
                "The 'anthropic' package is not installed. Run `pip install -r requirements.txt`."
            ) from exc

        self._client = AsyncAnthropic(api_key=settings.anthropic_api_key)
        self._model = settings.ai_model or "claude-sonnet-4-5"

    async def chat(self, messages: list[ChatMessage]) -> str:
        system = "\n".join(m.content for m in messages if m.role == "system") or None
        conversation = [
            {"role": m.role, "content": m.content} for m in messages if m.role != "system"
        ]
        try:
            response = await self._client.messages.create(
                model=self._model,
                system=system,
                messages=conversation,
                max_tokens=1024,
            )
        except Exception as exc:  # noqa: BLE001
            raise LLMError(f"Anthropic request failed: {exc}") from exc
        return "".join(block.text for block in response.content if block.type == "text")


_PROVIDERS: dict[str, type[LLMProvider]] = {
    "mock": MockProvider,
    "openai": OpenAIProvider,
    "anthropic": AnthropicProvider,
}


def get_llm_provider(settings: Settings | None = None) -> LLMProvider:
    """Instantiate the LLM provider configured via `AI_PROVIDER`."""
    settings = settings or get_settings()
    provider_cls = _PROVIDERS.get(settings.ai_provider)
    if provider_cls is None:
        raise LLMError(f"Unknown AI provider: {settings.ai_provider!r}")
    if provider_cls is MockProvider:
        return MockProvider()
    return provider_cls(settings)
