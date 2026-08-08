"""
Short-term conversation memory.

This module holds the *working* memory an active chat session needs
(recent turns, trimmed to `Settings.max_history_messages`). It is
intentionally simple and in-process for Phase 1.

Long-term memory — user preferences, remembered facts, project history
that persists across restarts and is user-viewable/editable/deletable
(see spec section 10) — is a Phase 5 feature and is NOT implemented here
yet. Wiring it in later should only require swapping `ConversationStore`'s
backing storage and adding a `LongTermMemoryStore` alongside it; the
`Agent` already calls this module through a narrow interface so that
swap won't ripple through the rest of the app.
"""
from __future__ import annotations

from backend.ai.llm import ChatMessage


class ConversationStore:
    """In-memory per-session conversation history.

    Not persisted to disk — restarting the backend clears it. That's a
    deliberate Phase 1 boundary, not an oversight.
    """

    def __init__(self, max_messages: int = 20):
        self._max_messages = max_messages
        self._sessions: dict[str, list[ChatMessage]] = {}

    def get_history(self, session_id: str) -> list[ChatMessage]:
        return list(self._sessions.get(session_id, []))

    def append(self, session_id: str, message: ChatMessage) -> None:
        history = self._sessions.setdefault(session_id, [])
        history.append(message)
        overflow = len(history) - self._max_messages
        if overflow > 0:
            del history[:overflow]

    def clear(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)


_store: ConversationStore | None = None


def get_conversation_store() -> ConversationStore:
    global _store
    if _store is None:
        from backend.core.config import get_settings

        _store = ConversationStore(max_messages=get_settings().max_history_messages)
    return _store
