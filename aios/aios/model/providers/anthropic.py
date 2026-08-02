"""Anthropic Messages API adapter.

Implemented against ``urllib`` so the kernel keeps its zero-dependency promise.
Notable details:

- **Prompt caching.** The system prompt and the tool catalog are the largest and
  most repeated part of every planning call, so the last system block is marked
  with ``cache_control``. On a long run that is the difference between paying
  for the catalog once and paying for it on every step.
- **Tool results** are folded into a single user turn, which is the shape the
  API expects; a naive one-message-per-result encoding is rejected.
- Errors are translated into the shared taxonomy so the retry policy upstream
  can distinguish "overloaded, try again" from "your request is malformed".
"""

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import Any

from ...foundation.errors import (
    ConfigError,
    ContextOverflow,
    InvalidArguments,
    ProviderError,
    ProviderUnavailable,
    RateLimited,
)
from ...foundation.logging import get_logger
from ...runtime.budget import Usage
from ..provider import BaseProvider
from ..types import Completion, ModelRequest, Role, ToolCall

log = get_logger("model.anthropic")

API_VERSION = "2023-06-01"
DEFAULT_BASE_URL = "https://api.anthropic.com"


class AnthropicProvider(BaseProvider):
    name = "anthropic"
    supports_tools = True
    supports_json_mode = False  # enforced via a tool-shaped schema instead
    default_model = "claude-sonnet-5"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        timeout: float = 120.0,
    ) -> None:
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        resolved = base_url or os.environ.get("ANTHROPIC_BASE_URL") or DEFAULT_BASE_URL
        self.base_url = resolved.rstrip("/")
        self.model = model or self.default_model
        self.timeout = timeout

    def available(self) -> bool:
        return bool(self.api_key)

    async def complete(self, request: ModelRequest) -> Completion:
        if not self.available():
            raise ConfigError(
                "ANTHROPIC_API_KEY is not set; export it or select another model provider"
            )
        payload = self._encode(request)
        raw = await asyncio.to_thread(self._post, "/v1/messages", payload)
        return self._decode(raw, request)

    # -- encoding --------------------------------------------------------
    def _encode(self, request: ModelRequest) -> dict[str, Any]:
        messages: list[dict[str, Any]] = []
        pending_results: list[dict[str, Any]] = []

        def flush_results() -> None:
            if pending_results:
                messages.append({"role": "user", "content": list(pending_results)})
                pending_results.clear()

        for message in request.messages:
            if message.role is Role.SYSTEM:
                continue  # carried separately
            if message.role is Role.TOOL:
                for result in message.tool_returns:
                    pending_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": result.call_id,
                            "content": result.content[:200_000],
                            "is_error": result.is_error,
                        }
                    )
                continue
            flush_results()
            if message.role is Role.ASSISTANT:
                blocks: list[dict[str, Any]] = []
                if message.content:
                    blocks.append({"type": "text", "text": message.content})
                for call in message.tool_calls:
                    blocks.append(
                        {"type": "tool_use", "id": call.id, "name": call.name,
                         "input": call.arguments}
                    )
                messages.append(
                    {"role": "assistant",
                     "content": blocks or [{"type": "text", "text": ""}]}
                )
            else:
                messages.append({"role": "user", "content": message.content})
        flush_results()

        if not messages:
            raise InvalidArguments("a model request needs at least one message")

        system_text = request.system or "\n\n".join(
            m.content for m in request.messages if m.role is Role.SYSTEM
        )
        body: dict[str, Any] = {
            "model": request.model or self.model,
            "max_tokens": request.max_tokens or 8192,
            "messages": messages,
        }
        if system_text:
            # Marking the final system block cacheable: it is the stable,
            # expensive prefix shared by every call in a run.
            body["system"] = [
                {"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}
            ]
        if request.temperature is not None:
            body["temperature"] = request.temperature
        if request.stop_sequences:
            body["stop_sequences"] = request.stop_sequences[:4]
        if request.tools:
            body["tools"] = [
                {"name": t["name"], "description": t.get("description", ""),
                 "input_schema": t.get("input_schema", {"type": "object"})}
                for t in request.tools
            ]
        elif request.json_schema:
            # No native JSON mode: expose a single tool and force its use, which
            # is the reliable way to get schema-valid structured output.
            body["tools"] = [
                {"name": "respond", "description": "Return the structured answer.",
                 "input_schema": request.json_schema}
            ]
            body["tool_choice"] = {"type": "tool", "name": "respond"}
        return body

    # -- transport -------------------------------------------------------
    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(payload).encode()
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-api-key": self.api_key,
                "anthropic-version": API_VERSION,
                "anthropic-beta": "prompt-caching-2024-07-31",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            try:
                detail = json.loads(body).get("error", {}).get("message", body)
            except json.JSONDecodeError:
                detail = body
            if exc.code == 429:
                retry_after = exc.headers.get("retry-after")
                raise RateLimited(
                    f"anthropic rate limit: {detail[:300]}",
                    retry_after=float(retry_after) if (retry_after or "").isdigit() else None,
                ) from exc
            if exc.code in {500, 502, 503, 529}:
                raise ProviderUnavailable(f"anthropic {exc.code}: {detail[:300]}") from exc
            if exc.code == 401:
                raise ConfigError("anthropic rejected the API key (401)") from exc
            if "prompt is too long" in detail.lower() or "max_tokens" in detail.lower():
                raise ContextOverflow(detail[:400]) from exc
            raise ProviderError(f"anthropic {exc.code}: {detail[:400]}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise ProviderUnavailable(f"cannot reach anthropic: {exc}") from exc

    # -- decoding --------------------------------------------------------
    def _decode(self, raw: dict[str, Any], request: ModelRequest) -> Completion:
        text_parts: list[str] = []
        calls: list[ToolCall] = []
        for block in raw.get("content", []):
            if block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif block.get("type") == "tool_use":
                calls.append(
                    ToolCall(
                        id=block.get("id", ""),
                        name=block.get("name", ""),
                        arguments=block.get("input") or {},
                    )
                )
        usage_raw = raw.get("usage", {})
        usage = Usage(
            input_tokens=int(usage_raw.get("input_tokens", 0))
            + int(usage_raw.get("cache_read_input_tokens", 0))
            + int(usage_raw.get("cache_creation_input_tokens", 0)),
            output_tokens=int(usage_raw.get("output_tokens", 0)),
            cached_tokens=int(usage_raw.get("cache_read_input_tokens", 0)),
        )
        text = "".join(text_parts)
        # When structured output was requested via the forced tool, surface the
        # arguments as the completion text so callers see plain JSON.
        if request.json_schema and not request.tools and calls:
            text = json.dumps(calls[0].arguments)
            calls = []
        return Completion(
            text=text,
            tool_calls=calls,
            usage=usage,
            model=raw.get("model", request.model or self.model),
            stop_reason=raw.get("stop_reason", ""),
            raw=raw,
        )
