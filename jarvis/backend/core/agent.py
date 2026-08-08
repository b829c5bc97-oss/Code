"""
The JARVIS agent core.

Phase 1 scope was a plain chat loop. Phase 3 adds real tool use: the agent
now hands the LLM a list of available tools (currently the `browser.*`
tools — see `tools/browser_tools.py`) and, when the model asks to call one,
executes it and feeds the result back for up to `Settings.max_tool_steps`
rounds before giving up. This is intentionally a bounded loop, not a full
planner — multi-step *planning* ahead of execution is still Phase 6
(`core/planner.py`).

    USER INPUT -> UNDERSTAND -> CHECK MEMORY -> [ CALL LLM -> maybe TOOL
    CALL -> EXECUTE -> OBSERVE ] * N -> REPORT

If a tool reports that a page needs a human (CAPTCHA, login), the loop
stops immediately and hands control back rather than pretending to push
through it — see `WAITING_FOR_CONFIRMATION` below.

Permission-gated confirmation for destructive actions is still Phase 6:
none of the current tools are HIGH-risk (see `core/permissions.py`), so
there is nothing to confirm yet.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from backend.ai.llm import ChatMessage, LLMError, LLMProvider, ToolSchema, get_llm_provider
from backend.ai.prompts import build_system_message
from backend.core.config import Settings, get_settings
from backend.core.memory import ConversationStore, get_conversation_store
from backend.core.permissions import requires_confirmation
from backend.tools.browser_tools import HUMAN_REQUIRED_PREFIX
from backend.tools.registry import ToolRegistry, get_tool_registry


class AgentState(str, Enum):
    """High-level state JARVIS is in, mirrored by the UI's visualizer."""

    IDLE = "idle"
    THINKING = "thinking"
    EXECUTING = "executing"
    WAITING_FOR_CONFIRMATION = "waiting_for_confirmation"
    SPEAKING = "speaking"
    ERROR = "error"


@dataclass
class ToolActivity:
    """One tool invocation, surfaced to the UI's activity readout."""

    name: str
    success: bool
    summary: str


@dataclass
class AgentResponse:
    reply: str
    state: AgentState
    provider: str
    tool_activity: list[ToolActivity] = field(default_factory=list)


def _tool_schemas(registry: ToolRegistry) -> list[ToolSchema]:
    return [
        ToolSchema(name=t.name, description=t.description, parameters=t.parameters)
        for t in registry.list()
    ]


def _summarize(text: str, limit: int = 160) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


class Agent:
    """Coordinates memory + LLM + tools to answer a single user turn."""

    def __init__(
        self,
        settings: Settings | None = None,
        llm: LLMProvider | None = None,
        memory: ConversationStore | None = None,
        tool_registry: ToolRegistry | None = None,
    ):
        self._settings = settings or get_settings()
        self._llm = llm or get_llm_provider(self._settings)
        self._memory = memory or get_conversation_store()
        self._tools = tool_registry if tool_registry is not None else get_tool_registry()

    async def handle_message(self, session_id: str, text: str) -> AgentResponse:
        text = text.strip()
        if not text:
            return AgentResponse(
                reply="I didn't catch that — could you say it again?",
                state=AgentState.IDLE,
                provider=self._llm.name,
            )

        self._memory.append(session_id, ChatMessage(role="user", content=text))
        conversation = list(self._memory.get_history(session_id))
        working_messages = [build_system_message(self._settings), *conversation]

        tools = (
            _tool_schemas(self._tools)
            if self._settings.enable_browser_tools
            else []
        )
        activity: list[ToolActivity] = []

        for _ in range(max(1, self._settings.max_tool_steps)):
            try:
                result = await self._llm.chat_with_tools(working_messages, tools)
            except LLMError as exc:
                return AgentResponse(
                    reply=f"I couldn't reach the AI provider: {exc}",
                    state=AgentState.ERROR,
                    provider=self._llm.name,
                    tool_activity=activity,
                )

            if not result.tool_calls:
                reply = result.text or "I don't have a response for that."
                self._memory.append(session_id, ChatMessage(role="assistant", content=reply))
                return AgentResponse(
                    reply=reply, state=AgentState.IDLE, provider=self._llm.name, tool_activity=activity
                )

            assistant_msg = ChatMessage(
                role="assistant", content=result.text or "", tool_calls=result.tool_calls
            )
            working_messages.append(assistant_msg)

            for call in result.tool_calls:
                tool = self._tools.get(call.name)
                if tool is None:
                    observation = f"Unknown tool: {call.name}"
                    activity.append(ToolActivity(call.name, False, observation))
                elif requires_confirmation(tool.permission):
                    # No HIGH-risk tools exist yet, but the check stays live
                    # so wiring one in later fails safe, not silently open.
                    reply = (
                        f"Using {call.name} needs your confirmation first, and I can't "
                        "get that yet — this safety check isn't wired up to the UI until "
                        "a later phase."
                    )
                    self._memory.append(session_id, ChatMessage(role="assistant", content=reply))
                    return AgentResponse(
                        reply=reply,
                        state=AgentState.WAITING_FOR_CONFIRMATION,
                        provider=self._llm.name,
                        tool_activity=activity,
                    )
                else:
                    tool_result = await tool.execute(**call.arguments)
                    observation = tool_result.output if tool_result.success else (
                        tool_result.error or "Tool failed with no details."
                    )
                    activity.append(
                        ToolActivity(call.name, tool_result.success, _summarize(observation))
                    )

                    if tool_result.success and observation.startswith(HUMAN_REQUIRED_PREFIX):
                        reason = observation[len(HUMAN_REQUIRED_PREFIX):].strip()
                        reply = (
                            f"I need you to take over: {reason} Let me know once you've "
                            "handled it and I'll continue."
                        )
                        self._memory.append(session_id, ChatMessage(role="assistant", content=reply))
                        return AgentResponse(
                            reply=reply,
                            state=AgentState.WAITING_FOR_CONFIRMATION,
                            provider=self._llm.name,
                            tool_activity=activity,
                        )

                tool_msg = ChatMessage(
                    role="tool", content=observation, tool_call_id=call.id, name=call.name
                )
                working_messages.append(tool_msg)

        reply = "I wasn't able to finish that within the allotted number of steps."
        self._memory.append(session_id, ChatMessage(role="assistant", content=reply))
        return AgentResponse(
            reply=reply, state=AgentState.ERROR, provider=self._llm.name, tool_activity=activity
        )
