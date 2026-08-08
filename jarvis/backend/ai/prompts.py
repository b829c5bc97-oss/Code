"""Prompt construction helpers.

Kept separate from `llm.py` so persona/system-prompt wording can evolve
(and later be extended with tool descriptions, memory context, etc. in
later phases) without touching the provider code.
"""
from __future__ import annotations

from backend.ai.llm import ChatMessage
from backend.core.config import Settings


def build_system_message(settings: Settings) -> ChatMessage:
    return ChatMessage(role="system", content=settings.system_persona)
