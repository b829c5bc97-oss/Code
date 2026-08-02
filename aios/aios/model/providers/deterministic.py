"""Deterministic offline providers.

Two of them, both essential rather than decorative:

:class:`ScriptedProvider` replays a fixed list of completions. Every kernel
test - retries, recovery, replanning, verification - drives the model through
this, so the whole control plane is tested without a network call or a dollar
spent.

:class:`OfflineProvider` answers requests using only the information already in
the prompt. It never invents facts, and when asked for structured output it
emits a schema-valid minimal object. This is what lets the OS boot and run its
heuristic path with no API key at all, degrading capability without degrading
honesty.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable
from typing import Any

from ...foundation.errors import ProviderError
from ...runtime.budget import Usage
from ..provider import BaseProvider
from ..types import Completion, ModelRequest, Role


def _estimate_tokens(text: str) -> int:
    """~4 characters per token; good enough for budget accounting offline."""
    return max(1, len(text) // 4)


class ScriptedProvider(BaseProvider):
    """Replays queued completions in order. Raises when the script runs out."""

    name = "scripted"
    supports_tools = True
    supports_json_mode = True
    default_model = "scripted"

    def __init__(
        self,
        responses: Iterable[Completion | str | Callable[[ModelRequest], Completion]] = (),
    ) -> None:
        self.responses: list[Any] = list(responses)
        self.requests: list[ModelRequest] = []

    def push(self, response: Completion | str | Callable[[ModelRequest], Completion]) -> None:
        self.responses.append(response)

    async def complete(self, request: ModelRequest) -> Completion:
        self.requests.append(request)
        if not self.responses:
            raise ProviderError(
                f"scripted provider exhausted after {len(self.requests)} request(s)"
            )
        item = self.responses.pop(0)
        if callable(item):
            item = item(request)
        if isinstance(item, str):
            item = Completion(text=item)
        item.model = item.model or self.default_model
        if item.usage.total == 0:
            prompt = request.system + "".join(m.content for m in request.messages)
            item.usage = Usage(_estimate_tokens(prompt), _estimate_tokens(item.text))
        return item


class OfflineProvider(BaseProvider):
    """Extractive, never generative.

    Answers by quoting the prompt back, and satisfies JSON schemas with the
    minimum valid document. The point is that a run without model access still
    produces *correct* output - just less of it - rather than confident fiction.
    """

    name = "offline"
    supports_tools = False
    supports_json_mode = True
    generative = False
    default_model = "offline"

    async def complete(self, request: ModelRequest) -> Completion:
        prompt = "\n".join(m.content for m in request.messages if m.role is not Role.SYSTEM)
        if request.json_schema:
            text = json.dumps(_minimal_instance(request.json_schema, prompt))
        else:
            text = self._summarize(prompt)
        return Completion(
            text=text,
            usage=Usage(_estimate_tokens(request.system + prompt), _estimate_tokens(text)),
            model=self.default_model,
            stop_reason="end_turn",
        )

    @staticmethod
    def _summarize(prompt: str) -> str:
        """Leading sentences of the input - extractive, so nothing is invented."""
        sentences = re.split(r"(?<=[.!?])\s+", prompt.strip())
        picked: list[str] = []
        budget = 600
        for sentence in sentences:
            if not sentence.strip():
                continue
            if budget - len(sentence) < 0:
                break
            picked.append(sentence.strip())
            budget -= len(sentence)
        return " ".join(picked) or "(no model configured; no content to summarise)"


def _minimal_instance(schema: dict[str, Any], hint: str = "") -> Any:
    """Smallest document that satisfies a schema. Used offline and in tests."""
    if "default" in schema:
        return schema["default"]
    if "const" in schema:
        return schema["const"]
    if enum := schema.get("enum"):
        return enum[0]
    kind = schema.get("type")
    if isinstance(kind, list):
        kind = kind[0]
    if kind == "object" or "properties" in schema:
        required = schema.get("required") or list(schema.get("properties", {}))
        return {
            key: _minimal_instance(schema.get("properties", {}).get(key, {}), hint)
            for key in required
        }
    if kind == "array":
        item = schema.get("items", {})
        return [_minimal_instance(item, hint)] if schema.get("minItems", 0) > 0 else []
    if kind == "integer":
        return int(schema.get("minimum", 0))
    if kind == "number":
        return float(schema.get("minimum", 0))
    if kind == "boolean":
        return False
    if kind == "null":
        return None
    return (hint[:120] or "") if schema.get("minLength") else ""
