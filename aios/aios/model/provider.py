"""Provider interface.

A provider does exactly one thing: turn a :class:`ModelRequest` into a
:class:`Completion`, translating vendor errors into the shared taxonomy. No
retries, no caching, no budget accounting - those belong to the client that
wraps it, so every provider gets them for free and none of them reimplements
them differently.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from .types import Completion, ModelRequest


@runtime_checkable
class Provider(Protocol):
    name: str
    supports_tools: bool
    supports_json_mode: bool
    generative: bool

    async def complete(self, request: ModelRequest) -> Completion: ...

    def available(self) -> bool:
        """Whether this provider can actually be used right now (keys, deps)."""
        ...


class BaseProvider:
    name = "base"
    supports_tools = False
    supports_json_mode = False
    default_model = ""

    #: False for providers that can only rearrange their input (the offline
    #: fallback). Cognition checks this: a provider that cannot reason must not
    #: be asked to plan, because schema-valid emptiness is worse than an honest
    #: heuristic. It stays useful for extraction and for keeping the OS running.
    generative = True

    def available(self) -> bool:
        return True

    async def complete(self, request: ModelRequest) -> Completion:  # pragma: no cover
        raise NotImplementedError

    def describe(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "available": self.available(),
            "supports_tools": self.supports_tools,
            "supports_json_mode": self.supports_json_mode,
            "generative": self.generative,
            "default_model": self.default_model,
        }
