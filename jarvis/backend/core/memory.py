"""
Memory.

Two distinct stores, matching two very different lifetimes:

- `ConversationStore` — short-term, in-process, per-session chat history.
  Cleared on backend restart. Unchanged since Phase 1.
- `LongTermMemoryStore` — persistent, user-visible facts/preferences/
  projects/context that survive restarts and follow the user across
  sessions (Phase 5). Backed by a small JSON file (`Settings.memory_path`)
  rather than a database — the expected scale (a personal assistant's
  remembered notes) doesn't need one, and a plain file is easy for the
  user to inspect or back up themselves.

Long-term memory is deliberately simple: entries are short strings tagged
with a category, created via the `memory.remember` tool or the Memory panel
in the UI, and injected into the system prompt on every turn so the agent
"just knows" them — see `ai/prompts.py`. There's no embedding-based
retrieval; at the scale this is designed for (dozens to low hundreds of
notes) sending them all is simpler and more reliable than getting semantic
search right, and the user can always delete stale ones from the UI.
"""
from __future__ import annotations

import json
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from backend.ai.llm import ChatMessage

MEMORY_CATEGORIES = ("preference", "fact", "task", "project", "app", "context")


class ConversationStore:
    """In-memory per-session conversation history.

    Not persisted to disk — restarting the backend clears it. That's a
    deliberate boundary, not an oversight: it's short-term working memory,
    distinct from `LongTermMemoryStore` below.
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


@dataclass
class MemoryEntry:
    id: str
    category: str
    content: str
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class LongTermMemoryStore:
    """JSON-file-backed persistent memory: preferences, facts, tasks, projects, context."""

    def __init__(self, path: Path):
        self._path = path
        self._lock = threading.Lock()
        if not self._path.exists():
            self._write([])

    def _read(self) -> list[dict]:
        try:
            return json.loads(self._path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return []

    def _write(self, entries: list[dict]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(json.dumps(entries, indent=2), encoding="utf-8")

    def list(self) -> list[MemoryEntry]:
        with self._lock:
            return [MemoryEntry(**e) for e in self._read()]

    def add(self, category: str, content: str) -> MemoryEntry:
        category = category if category in MEMORY_CATEGORIES else "fact"
        entry = MemoryEntry(id=uuid.uuid4().hex[:12], category=category, content=content.strip())
        with self._lock:
            entries = self._read()
            entries.append(asdict(entry))
            self._write(entries)
        return entry

    def delete(self, entry_id: str) -> bool:
        with self._lock:
            entries = self._read()
            remaining = [e for e in entries if e["id"] != entry_id]
            if len(remaining) == len(entries):
                return False
            self._write(remaining)
            return True

    def search(self, query: str) -> list[MemoryEntry]:
        needle = query.lower().strip()
        if not needle:
            return self.list()
        return [e for e in self.list() if needle in e.content.lower()]

    def as_prompt_context(self, limit: int = 200) -> str:
        """Render remembered entries as a compact bullet list for the system prompt."""
        entries = self.list()[-limit:]
        if not entries:
            return ""
        lines = [f"- ({e.category}) {e.content}" for e in entries]
        return "Remembered context about this user:\n" + "\n".join(lines)


_conversation_store: ConversationStore | None = None
_memory_store: LongTermMemoryStore | None = None


def get_conversation_store() -> ConversationStore:
    global _conversation_store
    if _conversation_store is None:
        from backend.core.config import get_settings

        _conversation_store = ConversationStore(max_messages=get_settings().max_history_messages)
    return _conversation_store


def get_memory_store() -> LongTermMemoryStore:
    global _memory_store
    if _memory_store is None:
        from backend.core.config import get_settings

        _memory_store = LongTermMemoryStore(get_settings().memory_path)
    return _memory_store
