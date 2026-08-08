"""
The JARVIS agent core.

    USER INPUT -> UNDERSTAND -> CHECK MEMORY -> DETERMINE TOOLS -> PLAN
    -> [ CALL LLM -> maybe TOOL CALL -> CONFIRM IF NEEDED -> EXECUTE ->
    OBSERVE ] * N -> REPORT

- **Memory**: long-term facts/preferences (`core/memory.LongTermMemoryStore`)
  are folded into the system prompt on every turn; short-term conversation
  history (`ConversationStore`) is appended as-is.
- **Plan**: for requests that look like more than a one-liner, a real
  provider is asked for a short upfront plan (`core/planner.py`) before
  the tool loop starts, purely for the user-visible task panel — it
  doesn't constrain what the loop actually does.
- **Tool loop**: hands the LLM the registry's tools; executes what it asks
  for, up to `Settings.max_tool_steps` rounds, feeding results back.
- **Confirmation**: if a requested tool needs confirmation (HIGH-risk
  always; MEDIUM-risk if `ALWAYS_CONFIRM_MEDIUM=true`), the loop pauses —
  the pending call is stashed in `self._pending` — and resumes from
  exactly where it left off via `confirm()` once the user answers.
- **Human-in-the-loop**: if a tool reports it hit something only a human
  can resolve (CAPTCHA, login), the loop stops and hands control back
  rather than pretending to push through it.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from backend.ai.llm import ChatMessage, LLMError, LLMProvider, ToolSchema, get_llm_provider
from backend.ai.prompts import build_system_message
from backend.core.config import Settings, get_settings
from backend.core.memory import ConversationStore, LongTermMemoryStore, get_conversation_store, get_memory_store
from backend.core.permissions import PermissionLevel, requires_confirmation
from backend.core.planner import Planner
from backend.tools.browser_tools import HUMAN_REQUIRED_PREFIX
from backend.tools.registry import Tool, ToolRegistry, get_tool_registry


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
    plan: list[str] = field(default_factory=list)


@dataclass
class _PendingAction:
    call_id: str
    tool: Tool
    arguments: dict
    working_messages: list[ChatMessage]
    activity: list[ToolActivity]
    steps_remaining: int


def _tool_schemas(registry: ToolRegistry) -> list[ToolSchema]:
    return [
        ToolSchema(name=t.name, description=t.description, parameters=t.parameters)
        for t in registry.list()
    ]


def _summarize(text: str, limit: int = 160) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _effective_permission(tool: Tool, arguments: dict) -> PermissionLevel:
    """A tool's static tier, unless it escalates for this specific call."""
    if tool.risk_escalation is not None:
        escalated = tool.risk_escalation(arguments)
        if escalated is not None:
            return escalated
    return tool.permission


class Agent:
    """Coordinates memory + planning + LLM + tools to answer a user's turns."""

    def __init__(
        self,
        settings: Settings | None = None,
        llm: LLMProvider | None = None,
        memory: ConversationStore | None = None,
        long_term_memory: LongTermMemoryStore | None = None,
        tool_registry: ToolRegistry | None = None,
    ):
        self._settings = settings or get_settings()
        self._llm = llm or get_llm_provider(self._settings)
        self._memory = memory or get_conversation_store()
        self._long_term_memory = long_term_memory or get_memory_store()
        self._tools = tool_registry if tool_registry is not None else get_tool_registry()
        self._planner = Planner(self._llm)
        self._pending: dict[str, _PendingAction] = {}

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
        memory_context = self._long_term_memory.as_prompt_context()
        working_messages = [build_system_message(self._settings, memory_context), *conversation]
        tool_names = [t.name for t in self._tools.list()]

        plan: list[str] = []
        if self._settings.enable_planner and tool_names and len(text.split()) >= 8:
            plan = await self._planner.create_plan(text, tool_names)

        response = await self._run_loop(
            session_id, working_messages, self._settings.max_tool_steps
        )
        response.plan = plan
        return response

    async def confirm(self, session_id: str, approved: bool) -> AgentResponse:
        pending = self._pending.pop(session_id, None)
        if pending is None:
            return AgentResponse(
                reply="There's nothing waiting for confirmation.",
                state=AgentState.IDLE,
                provider=self._llm.name,
            )

        if not approved:
            reply = f"Okay, I won't run {pending.tool.name}."
            self._memory.append(session_id, ChatMessage(role="assistant", content=reply))
            return AgentResponse(
                reply=reply,
                state=AgentState.IDLE,
                provider=self._llm.name,
                tool_activity=pending.activity,
            )

        observation, success, human_reason = await self._execute_tool(pending.tool, pending.arguments)
        pending.activity.append(ToolActivity(pending.tool.name, success, _summarize(observation)))

        if human_reason:
            reply = (
                f"I need you to take over: {human_reason} Let me know once you've handled "
                "it and I'll continue."
            )
            self._memory.append(session_id, ChatMessage(role="assistant", content=reply))
            return AgentResponse(
                reply=reply,
                state=AgentState.WAITING_FOR_CONFIRMATION,
                provider=self._llm.name,
                tool_activity=pending.activity,
            )

        pending.working_messages.append(
            ChatMessage(role="tool", content=observation, tool_call_id=pending.call_id, name=pending.tool.name)
        )
        return await self._run_loop(
            session_id, pending.working_messages, pending.steps_remaining, pending.activity
        )

    async def _execute_tool(self, tool: Tool, arguments: dict) -> tuple[str, bool, str | None]:
        """Run a tool; returns (observation text, success, human-required reason or None)."""
        tool_result = await tool.execute(**arguments)
        observation = tool_result.output if tool_result.success else (
            tool_result.error or "Tool failed with no details."
        )
        if tool_result.success and observation.startswith(HUMAN_REQUIRED_PREFIX):
            return observation, True, observation[len(HUMAN_REQUIRED_PREFIX):].strip()
        return observation, tool_result.success, None

    async def _run_loop(
        self,
        session_id: str,
        working_messages: list[ChatMessage],
        steps_remaining: int,
        activity: list[ToolActivity] | None = None,
    ) -> AgentResponse:
        activity = activity if activity is not None else []
        tools = _tool_schemas(self._tools)

        while steps_remaining > 0:
            steps_remaining -= 1
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

            working_messages.append(
                ChatMessage(role="assistant", content=result.text or "", tool_calls=result.tool_calls)
            )

            for call in result.tool_calls:
                tool = self._tools.get(call.name)
                if tool is None:
                    observation = f"Unknown tool: {call.name}"
                    activity.append(ToolActivity(call.name, False, observation))
                    working_messages.append(
                        ChatMessage(role="tool", content=observation, tool_call_id=call.id, name=call.name)
                    )
                    continue

                effective_permission = _effective_permission(tool, call.arguments)
                if requires_confirmation(effective_permission, self._settings):
                    self._pending[session_id] = _PendingAction(
                        call_id=call.id,
                        tool=tool,
                        arguments=call.arguments,
                        working_messages=working_messages,
                        activity=activity,
                        steps_remaining=steps_remaining,
                    )
                    reply = (
                        f"I'd like to run {tool.name} with {call.arguments!r} — "
                        f"{tool.description} This is a {effective_permission.value}-risk action. "
                        "Should I proceed?"
                    )
                    self._memory.append(session_id, ChatMessage(role="assistant", content=reply))
                    return AgentResponse(
                        reply=reply,
                        state=AgentState.WAITING_FOR_CONFIRMATION,
                        provider=self._llm.name,
                        tool_activity=activity,
                    )

                observation, success, human_reason = await self._execute_tool(tool, call.arguments)
                activity.append(ToolActivity(tool.name, success, _summarize(observation)))

                if human_reason:
                    reply = (
                        f"I need you to take over: {human_reason} Let me know once you've "
                        "handled it and I'll continue."
                    )
                    self._memory.append(session_id, ChatMessage(role="assistant", content=reply))
                    return AgentResponse(
                        reply=reply,
                        state=AgentState.WAITING_FOR_CONFIRMATION,
                        provider=self._llm.name,
                        tool_activity=activity,
                    )

                working_messages.append(
                    ChatMessage(role="tool", content=observation, tool_call_id=call.id, name=call.name)
                )

        reply = "I wasn't able to finish that within the allotted number of steps."
        self._memory.append(session_id, ChatMessage(role="assistant", content=reply))
        return AgentResponse(
            reply=reply, state=AgentState.ERROR, provider=self._llm.name, tool_activity=activity
        )
