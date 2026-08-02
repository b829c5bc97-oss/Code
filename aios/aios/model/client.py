"""The model client.

Everything that should be true of *every* model call, regardless of provider,
lives here exactly once:

- **Retry with jittered exponential backoff**, honouring ``Retry-After`` when a
  provider supplies it and never retrying an error the taxonomy marks terminal.
- **Failover.** Providers are tried in priority order, so a 529 from the primary
  falls through to a secondary or to the offline provider rather than failing
  the run.
- **Budget accounting.** Tokens and dollars are charged before the caller sees
  the result, so a runaway loop hits its ceiling instead of the user's card.
- **Content-addressed caching** of identical requests within a run, which makes
  a replan that re-asks the same question free.
- **Structured output with a repair loop**: parse, validate against the schema,
  and hand the validation errors back to the model to fix - bounded, so a model
  that cannot produce valid JSON fails loudly rather than looping.
"""

from __future__ import annotations

import asyncio
import json
import random
import re
from typing import Any

from ..foundation.clock import SYSTEM_CLOCK, Clock
from ..foundation.config import ModelConfig
from ..foundation.errors import (
    AiosError,
    ProviderError,
    ProviderUnavailable,
    RateLimited,
    StructuredOutputError,
    classify,
)
from ..foundation.logging import get_logger
from ..runtime.budget import Budget
from ..runtime.events import EventBus, Topic
from ..tools.schema import ValidationError, validate_and_coerce
from .provider import BaseProvider
from .types import Completion, Message, ModelRequest

log = get_logger("model.client")

_FENCE = re.compile(r"```(?:json|JSON)?\s*(.+?)```", re.S)


class ModelClient:
    def __init__(
        self,
        providers: list[BaseProvider],
        config: ModelConfig,
        *,
        bus: EventBus | None = None,
        budget: Budget | None = None,
        clock: Clock | None = None,
    ) -> None:
        if not providers:
            raise ProviderError("at least one model provider is required")
        self.providers = providers
        self.config = config
        self.bus = bus
        self.budget = budget
        self.clock = clock or SYSTEM_CLOCK
        self._cache: dict[str, Completion] = {}
        self.calls = 0

    @property
    def primary(self) -> BaseProvider:
        for provider in self.providers:
            if provider.available():
                return provider
        return self.providers[0]

    def supports_tools(self) -> bool:
        return self.primary.supports_tools

    def can_generate(self) -> bool:
        """False when only the extractive offline provider is available.

        Callers that need genuine reasoning - the intent resolver and the
        planner - check this and use their deterministic path instead of
        burning calls on a provider that can only echo the prompt back.
        """
        return any(p.available() and p.generative for p in self.providers)

    # -- core ------------------------------------------------------------
    async def complete(
        self,
        request: ModelRequest,
        *,
        run_id: str | None = None,
        step_id: str | None = None,
        purpose: str = "",
    ) -> Completion:
        request.model = request.model or self.config.model
        request.temperature = (
            self.config.temperature if request.temperature is None else request.temperature
        )
        request.max_tokens = request.max_tokens or self.config.max_tokens

        key = request.cache_key()
        if self.config.cache_enabled and key in self._cache:
            cached = self._cache[key]
            log.debug("model cache hit", extra={"purpose": purpose})
            return Completion(
                text=cached.text, tool_calls=list(cached.tool_calls), usage=cached.usage,
                model=cached.model, stop_reason=cached.stop_reason, raw=cached.raw, cached=True,
            )

        if self.budget:
            self.budget.check(what=f"model call ({purpose or 'generic'})")

        if self.bus:
            await self.bus.publish(
                Topic.MODEL_REQUEST,
                {"purpose": purpose, "model": request.model,
                 "messages": len(request.messages), "tools": len(request.tools),
                 "structured": bool(request.json_schema)},
                run_id=run_id, step_id=step_id,
            )

        last_error: AiosError | None = None
        for provider in self._candidates():
            try:
                completion = await self._with_retries(provider, request, purpose)
            except AiosError as exc:
                last_error = exc
                if not isinstance(exc, ProviderUnavailable | RateLimited):
                    raise
                log.warning(
                    "provider failed over",
                    extra={"provider": provider.name, "error": exc.code},
                )
                continue
            self.calls += 1
            if self.budget:
                self.budget.charge_model(completion.model or request.model, completion.usage)
            if self.config.cache_enabled:
                self._cache[key] = completion
            if self.bus:
                await self.bus.publish(
                    Topic.MODEL_RESPONSE,
                    {"purpose": purpose, "model": completion.model,
                     "input_tokens": completion.usage.input_tokens,
                     "output_tokens": completion.usage.output_tokens,
                     "cached_tokens": completion.usage.cached_tokens,
                     "stop_reason": completion.stop_reason,
                     "tool_calls": [c.name for c in completion.tool_calls]},
                    run_id=run_id, step_id=step_id,
                )
            return completion
        raise last_error or ProviderError("no model provider could serve the request")

    def _candidates(self) -> list[BaseProvider]:
        available = [p for p in self.providers if p.available()]
        return available or self.providers[:1]

    async def _with_retries(
        self, provider: BaseProvider, request: ModelRequest, purpose: str
    ) -> Completion:
        attempts = max(1, self.config.max_retries)
        for attempt in range(1, attempts + 1):
            try:
                return await asyncio.wait_for(
                    provider.complete(request), timeout=self.config.timeout_seconds
                )
            except Exception as exc:
                error = classify(exc)
                if not error.retryable or attempt == attempts:
                    raise error from exc
                delay = getattr(error, "retry_after", None) or _backoff(attempt)
                log.warning(
                    "retrying model call",
                    extra={"provider": provider.name, "attempt": attempt,
                           "delay_s": round(delay, 2), "error": error.code, "purpose": purpose},
                )
                await self.clock.sleep(delay)
        raise ProviderError("unreachable")  # pragma: no cover

    # -- convenience -----------------------------------------------------
    async def ask(
        self, prompt: str, *, system: str = "", purpose: str = "", **kw: Any
    ) -> str:
        completion = await self.complete(
            ModelRequest(messages=[Message.user(prompt)], system=system, **kw), purpose=purpose
        )
        return completion.text.strip()

    async def structured(
        self,
        prompt: str,
        schema: dict[str, Any],
        *,
        system: str = "",
        purpose: str = "structured",
        repair_attempts: int = 2,
        run_id: str | None = None,
        step_id: str | None = None,
        **kw: Any,
    ) -> Any:
        """Get schema-valid JSON, repairing invalid output up to N times."""
        messages = [Message.user(prompt)]
        instruction = (
            f"{system}\n\nRespond with a single JSON document conforming to this schema:\n"
            f"{json.dumps(schema, indent=2)}\n\n"
            "Output JSON only. No prose, no markdown fences."
        ).strip()

        last_errors: list[str] = []
        for attempt in range(repair_attempts + 1):
            completion = await self.complete(
                ModelRequest(messages=list(messages), system=instruction, json_schema=schema, **kw),
                purpose=f"{purpose}{'' if attempt == 0 else f'/repair{attempt}'}",
                run_id=run_id, step_id=step_id,
            )
            try:
                payload = extract_json(completion.text)
            except StructuredOutputError as exc:
                last_errors = [str(exc)]
            else:
                try:
                    return validate_and_coerce(payload, schema)
                except ValidationError as exc:
                    last_errors = exc.errors

            if attempt == repair_attempts:
                break
            messages += [
                Message.assistant(completion.text[:4000]),
                Message.user(
                    "That response did not satisfy the schema:\n- "
                    + "\n- ".join(last_errors[:10])
                    + "\n\nReturn corrected JSON only."
                ),
            ]
            log.warning(
                "repairing structured output",
                extra={"attempt": attempt + 1, "errors": last_errors[:4], "purpose": purpose},
            )

        raise StructuredOutputError(
            f"model could not produce schema-valid JSON after {repair_attempts + 1} attempts",
            context={"errors": last_errors[:10], "purpose": purpose},
        )

    def stats(self) -> dict[str, Any]:
        return {
            "calls": self.calls,
            "cache_entries": len(self._cache),
            "providers": [p.describe() for p in self.providers],
        }


def _backoff(attempt: int, base: float = 1.0, cap: float = 30.0, jitter: float = 0.3) -> float:
    """Exponential with full-ish jitter, so parallel steps do not retry in lockstep."""
    delay = min(cap, base * (2 ** (attempt - 1)))
    return delay * (1 - jitter + random.random() * 2 * jitter)


def extract_json(text: str) -> Any:
    """Recover a JSON document from a model response.

    Models wrap JSON in fences, prefix it with prose, and occasionally emit
    trailing commas. Each of those costs a repair round-trip if not handled, so
    they are handled here.
    """
    text = (text or "").strip()
    if not text:
        raise StructuredOutputError("model returned an empty response")

    for candidate in _candidates(text):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            repaired = re.sub(r",(\s*[}\]])", r"\1", candidate)
            try:
                return json.loads(repaired)
            except json.JSONDecodeError:
                continue
    raise StructuredOutputError(
        "could not parse JSON from the model response",
        context={"preview": text[:300]},
    )


def _candidates(text: str) -> list[str]:
    out = [text]
    if match := _FENCE.search(text):
        out.insert(0, match.group(1).strip())
    # Widest balanced object/array in the text.
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        end = text.rfind(closer)
        if 0 <= start < end:
            out.append(text[start : end + 1])
    return out
