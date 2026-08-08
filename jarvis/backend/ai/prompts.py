"""Prompt construction helpers.

Kept separate from `llm.py` so persona/system-prompt wording can evolve
without touching the provider code.
"""
from __future__ import annotations

from backend.ai.llm import ChatMessage
from backend.core.config import Settings


def build_system_message(settings: Settings, memory_context: str = "") -> ChatMessage:
    content = settings.system_persona
    if memory_context:
        content = f"{content}\n\n{memory_context}"
    return ChatMessage(role="system", content=content)
