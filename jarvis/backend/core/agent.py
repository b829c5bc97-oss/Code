"""
The JARVIS agent core.

Phase 1 scope: understand a message, consult short-term conversation
memory, call the configured LLM, and return a reply. This is deliberately
the simplest possible slice of the full flow described in the project
spec:

    USER INPUT -> UNDERSTAND -> CHECK MEMORY -> DETERMINE TOOLS -> PLAN
    -> CONFIRM (if needed) -> EXECUTE -> OBSERVE -> VERIFY -> REPORT

Tool selection, multi-step planning, and permission-gated execution are
Phase 6 (`core/planner.py`, `tools/registry.py`, `core/permissions.py`).
Wiring them in later means extending `Agent.handle_message` to consult a
planner/tool-registry before falling back to a plain chat reply — the
public interface (`handle_message`) is written so that call sites (the
API layer) never need to change when that happens.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from backend.ai.llm import ChatMessage, LLMError, LLMProvider, get_llm_provider
from backend.ai.prompts import build_system_message
from backend.core.config import Settings, get_settings
from backend.core.memory import ConversationStore, get_conversation_store


class AgentState(str, Enum):
    """High-level state JARVIS is in, mirrored by the UI's visualizer."""

    IDLE = "idle"
    THINKING = "thinking"
    EXECUTING = "executing"
    WAITING_FOR_CONFIRMATION = "waiting_for_confirmation"
    SPEAKING = "speaking"
    ERROR = "error"


@dataclass
class AgentResponse:
    reply: str
    state: AgentState
    provider: str


class Agent:
    """Coordinates memory + LLM to answer a single user turn."""

    def __init__(
        self,
        settings: Settings | None = None,
        llm: LLMProvider | None = None,
        memory: ConversationStore | None = None,
    ):
        self._settings = settings or get_settings()
        self._llm = llm or get_llm_provider(self._settings)
        self._memory = memory or get_conversation_store()

    async def handle_message(self, session_id: str, text: str) -> AgentResponse:
        text = text.strip()
        if not text:
            return AgentResponse(
                reply="I didn't catch that — could you say it again?",
                state=AgentState.IDLE,
                provider=self._llm.name,
            )

        self._memory.append(session_id, ChatMessage(role="user", content=text))
        history = self._memory.get_history(session_id)
        messages = [build_system_message(self._settings), *history]

        try:
            reply = await self._llm.chat(messages)
        except LLMError as exc:
            return AgentResponse(
                reply=f"I couldn't reach the AI provider: {exc}",
                state=AgentState.ERROR,
                provider=self._llm.name,
            )

        self._memory.append(session_id, ChatMessage(role="assistant", content=reply))
        return AgentResponse(reply=reply, state=AgentState.IDLE, provider=self._llm.name)
