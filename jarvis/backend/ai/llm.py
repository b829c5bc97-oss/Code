"""
Pluggable LLM provider layer.

JARVIS must never be hard-wired to a single AI vendor. Every provider
implements the same small `LLMProvider` interface; `get_llm_provider()`
picks the concrete implementation from `Settings.ai_provider` at call time.

Phase 3 adds tool-calling: `chat_with_tools()` lets the agent hand the model
a list of available tools (see `tools/registry.py`) and get back either a
final text answer or a request to execute one or more of them. Providers
that don't support tools (or are called with an empty tool list) fall back
to a plain-text reply via the default implementation below — `chat()`
itself is just `chat_with_tools()` with no tools.

Adding a new provider later (local models, Gemini, etc.) means writing one
class here and registering it in `_PROVIDERS` — nothing else in the app
needs to change.
"""
from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from backend.core.config import Settings, get_settings


@dataclass
class ToolCall:
    """A request from the model to execute one registered tool."""

    id: str
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)


@dataclass
class ChatMessage:
    role: str  # "system" | "user" | "assistant" | "tool"
    content: str = ""
    # Present on an assistant message that requested tool execution.
    tool_calls: list[ToolCall] | None = None
    # Present on a "tool" role message: links the result back to its call.
    tool_call_id: str | None = None
    name: str | None = None  # tool name, for "tool" role messages


@dataclass
class ToolSchema:
    """JSON-schema description of a callable tool, provider-agnostic."""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class LLMResult:
    """Either a finished text reply, or one/more tool calls to execute."""

    text: str | None
    tool_calls: list[ToolCall] = field(default_factory=list)


class LLMError(RuntimeError):
    """Raised when a provider cannot produce a completion (bad key, network, etc.)."""


class LLMProvider(ABC):
    """Common interface every LLM backend must implement."""

    name: str = "base"

    @abstractmethod
    async def chat(self, messages: list[ChatMessage]) -> str:
        """Send a conversation and return the assistant's reply as plain text."""
        raise NotImplementedError

    async def chat_with_tools(
        self, messages: list[ChatMessage], tools: list[ToolSchema]
    ) -> LLMResult:
        """Send a conversation with optional tools; may return tool calls instead of text.

        Default implementation ignores `tools` and falls back to plain
        `chat()` — providers that support real function/tool calling
        (OpenAI, Anthropic) override this.
        """
        text = await self.chat(messages)
        return LLMResult(text=text, tool_calls=[])


class MockProvider(LLMProvider):
    """Deterministic, offline provider.

    Used as the default so the app is runnable out of the box with no API
    key, and so automated tests never depend on network access or billing.
    It is intentionally simple and clearly labelled — JARVIS never pretends
    a mock reply came from a real model.

    Tool use in mock mode is a small set of keyword/regex rules (see
    `mock_intent.py`) rather than real language understanding — good enough
    to exercise and demo the tool-calling pipeline without an API key, but
    not a substitute for a real provider.
    """

    name = "mock"

    async def chat(self, messages: list[ChatMessage]) -> str:
        last_user = next((m.content for m in reversed(messages) if m.role == "user"), "")
        return (
            "[mock provider — configure a real AI_PROVIDER in .env for actual answers]\n"
            f"You said: {last_user!r}"
        )

    async def chat_with_tools(
        self, messages: list[ChatMessage], tools: list[ToolSchema]
    ) -> LLMResult:
        if not tools:
            return LLMResult(text=await self.chat(messages), tool_calls=[])

        # If the previous turn already returned a tool result, wrap up with
        # a text summary instead of calling another tool — keeps the mock
        # provider's tool loop bounded and deterministic.
        if messages and messages[-1].role == "tool":
            observation = messages[-1].content
            return LLMResult(
                text=f"[mock provider] Tool result: {observation}",
                tool_calls=[],
            )

        from backend.ai.mock_intent import detect_tool_intent

        last_user = next((m.content for m in reversed(messages) if m.role == "user"), "")
        call = detect_tool_intent(last_user, {t.name for t in tools})
        if call is not None:
            return LLMResult(text=None, tool_calls=[call])

        return LLMResult(text=await self.chat(messages), tool_calls=[])


def _openai_message(message: ChatMessage) -> dict[str, Any]:
    if message.role == "assistant" and message.tool_calls:
        return {
            "role": "assistant",
            "content": message.content or None,
            "tool_calls": [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": json.dumps(call.arguments)},
                }
                for call in message.tool_calls
            ],
        }
    if message.role == "tool":
        return {"role": "tool", "tool_call_id": message.tool_call_id, "content": message.content}
    return {"role": message.role, "content": message.content}


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
        result = await self.chat_with_tools(messages, tools=[])
        return result.text or ""

    async def chat_with_tools(
        self, messages: list[ChatMessage], tools: list[ToolSchema]
    ) -> LLMResult:
        oa_tools = (
            [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                }
                for t in tools
            ]
            if tools
            else None
        )
        try:
            response = await self._client.chat.completions.create(
                model=self._model,
                messages=[_openai_message(m) for m in messages],
                tools=oa_tools,
                tool_choice="auto" if oa_tools else None,
            )
        except Exception as exc:  # noqa: BLE001 - surface as a clean LLMError
            raise LLMError(f"OpenAI request failed: {exc}") from exc

        choice = response.choices[0].message
        if choice.tool_calls:
            calls = [
                ToolCall(
                    id=tc.id,
                    name=tc.function.name,
                    arguments=json.loads(tc.function.arguments or "{}"),
                )
                for tc in choice.tool_calls
            ]
            return LLMResult(text=choice.content, tool_calls=calls)
        return LLMResult(text=choice.content or "", tool_calls=[])


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
        result = await self.chat_with_tools(messages, tools=[])
        return result.text or ""

    async def chat_with_tools(
        self, messages: list[ChatMessage], tools: list[ToolSchema]
    ) -> LLMResult:
        system = "\n".join(m.content for m in messages if m.role == "system") or None
        anthropic_tools = (
            [{"name": t.name, "description": t.description, "input_schema": t.parameters} for t in tools]
            if tools
            else None
        )

        conversation: list[dict[str, Any]] = []
        for m in messages:
            if m.role == "system":
                continue
            if m.role == "assistant" and m.tool_calls:
                content: list[dict[str, Any]] = []
                if m.content:
                    content.append({"type": "text", "text": m.content})
                for call in m.tool_calls:
                    content.append(
                        {"type": "tool_use", "id": call.id, "name": call.name, "input": call.arguments}
                    )
                conversation.append({"role": "assistant", "content": content})
            elif m.role == "tool":
                conversation.append(
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": m.tool_call_id,
                                "content": m.content,
                            }
                        ],
                    }
                )
            else:
                conversation.append({"role": m.role, "content": m.content})

        try:
            response = await self._client.messages.create(
                model=self._model,
                system=system,
                messages=conversation,
                tools=anthropic_tools,
                max_tokens=1024,
            )
        except Exception as exc:  # noqa: BLE001
            raise LLMError(f"Anthropic request failed: {exc}") from exc

        text_parts = [block.text for block in response.content if block.type == "text"]
        tool_calls = [
            ToolCall(id=block.id, name=block.name, arguments=block.input)
            for block in response.content
            if block.type == "tool_use"
        ]
        return LLMResult(text="".join(text_parts) if text_parts else None, tool_calls=tool_calls)


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
