"""Model layer: provider-neutral types, adapters and the resilient client."""

from __future__ import annotations

from ..foundation.config import ModelConfig
from ..foundation.logging import get_logger
from .client import ModelClient, extract_json
from .provider import BaseProvider, Provider
from .providers import AnthropicProvider, OfflineProvider, ScriptedProvider
from .types import Completion, Message, ModelRequest, Role, ToolCall, ToolReturn

log = get_logger("model")

_REGISTRY: dict[str, type[BaseProvider]] = {
    "anthropic": AnthropicProvider,
    "offline": OfflineProvider,
    "scripted": ScriptedProvider,
}


def register_provider(name: str, factory: type[BaseProvider]) -> None:
    """Extension point: a plugin adds a provider with one call."""
    _REGISTRY[name] = factory


def build_providers(config: ModelConfig) -> list[BaseProvider]:
    """Resolve the configured provider chain.

    ``auto`` prefers a real provider when credentials exist and always appends
    the offline provider as a last resort, so the OS starts either way.
    """
    if config.provider != "auto":
        factory = _REGISTRY.get(config.provider)
        if factory is None:
            raise ValueError(
                f"unknown model provider {config.provider!r}; known: {sorted(_REGISTRY)}"
            )
        primary = factory(model=config.model) if factory is AnthropicProvider else factory()
        chain: list[BaseProvider] = [primary]
        if config.provider not in {"offline", "scripted"}:
            chain.append(OfflineProvider())
        return chain

    chain = []
    anthropic = AnthropicProvider(model=config.model, timeout=config.timeout_seconds)
    if anthropic.available():
        chain.append(anthropic)
    else:
        log.info("no ANTHROPIC_API_KEY found; running with the offline provider")
    chain.append(OfflineProvider())
    return chain


def build_client(config: ModelConfig, **kw) -> ModelClient:
    return ModelClient(build_providers(config), config, **kw)


__all__ = [
    "AnthropicProvider",
    "BaseProvider",
    "Completion",
    "Message",
    "ModelClient",
    "ModelRequest",
    "OfflineProvider",
    "Provider",
    "Role",
    "ScriptedProvider",
    "ToolCall",
    "ToolReturn",
    "build_client",
    "build_providers",
    "extract_json",
    "register_provider",
]
