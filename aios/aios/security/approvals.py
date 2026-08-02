"""Approval brokering.

When the policy engine returns ``CONFIRM`` the kernel asks a broker. Brokers
are pluggable so the same kernel serves a terminal (prompt), a server (push a
question to a UI and await), CI (deny everything that needs a human) and tests
(auto-approve).

Scopes let a user answer once for a class of actions instead of being asked 40
times during a long run - ``ONCE`` for this call, ``TOOL`` for every call of
that tool in this run, ``ALWAYS`` for the rest of the run.
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from ..foundation.logging import get_logger
from ..foundation.redaction import redact
from .policy import ActionRequest, Decision

log = get_logger("security.approvals")


class Scope(str, Enum):
    ONCE = "once"
    TOOL = "tool"
    ALWAYS = "always"
    NEVER = "never"  # deny this action class for the rest of the run


@dataclass(slots=True)
class ApprovalRequest:
    action: ActionRequest
    decision: Decision
    prompt: str = ""

    def render(self) -> str:
        parts = [self.prompt or self.action.describe()]
        parts.append(f"  risk:   {self.decision.risk.name}")
        parts.append(f"  reason: {self.decision.reason}")
        if self.action.command:
            parts.append(f"  command: {self.action.command}")
        if self.action.paths:
            parts.append(f"  paths:   {', '.join(self.action.paths[:5])}")
        if self.action.urls:
            parts.append(f"  urls:    {', '.join(self.action.urls[:5])}")
        return "\n".join(parts)


@dataclass(slots=True)
class ApprovalResult:
    approved: bool
    scope: Scope = Scope.ONCE
    reason: str = ""
    responder: str = "unknown"

    def to_dict(self) -> dict[str, Any]:
        return {
            "approved": self.approved,
            "scope": self.scope.value,
            "reason": self.reason,
            "responder": self.responder,
        }


class ApprovalBroker(Protocol):
    async def request(self, request: ApprovalRequest) -> ApprovalResult: ...


class AutoApprove:
    """Approves everything. For tests and explicitly unattended runs only."""

    name = "auto"

    async def request(self, request: ApprovalRequest) -> ApprovalResult:
        log.warning(
            "auto-approving gated action",
            extra={"tool": request.action.tool, "rule": request.decision.rule},
        )
        return ApprovalResult(True, Scope.ONCE, "approval_mode=auto", self.name)


class DenyAll:
    """Refuses everything that needs a human. The right default for CI."""

    name = "deny"

    async def request(self, request: ApprovalRequest) -> ApprovalResult:
        return ApprovalResult(False, Scope.ONCE, "approval_mode=deny (unattended)", self.name)


class CallbackApprover:
    """Delegates to a coroutine - the adapter for a web UI or chat surface."""

    name = "callback"

    def __init__(self, callback: Any, *, timeout: float = 300.0) -> None:
        self._callback = callback
        self._timeout = timeout

    async def request(self, request: ApprovalRequest) -> ApprovalResult:
        try:
            result = await asyncio.wait_for(self._callback(request), timeout=self._timeout)
        except TimeoutError:
            return ApprovalResult(False, Scope.ONCE, "approval timed out", self.name)
        if isinstance(result, ApprovalResult):
            return result
        return ApprovalResult(bool(result), Scope.ONCE, "callback", self.name)


class ConsoleApprover:
    """Interactive terminal prompt.

    Reads on a worker thread so the event loop keeps servicing parallel steps
    while the user is thinking.
    """

    name = "console"

    def __init__(self, *, stream: Any = None, timeout: float | None = None) -> None:
        self._out = stream or sys.stderr
        self._timeout = timeout

    async def request(self, request: ApprovalRequest) -> ApprovalResult:
        if not sys.stdin or not sys.stdin.isatty():
            return ApprovalResult(False, Scope.ONCE, "no interactive terminal available", self.name)
        banner = (
            "\n\x1b[38;5;214m┌─ approval required\x1b[0m\n"
            + "\n".join(f"\x1b[38;5;214m│\x1b[0m {line}" for line in request.render().splitlines())
            + "\n\x1b[38;5;214m└─\x1b[0m [y]es / [n]o / [a]ll for this tool / [q]uit: "
        )
        self._out.write(banner)
        self._out.flush()
        try:
            answer = await asyncio.wait_for(
                asyncio.to_thread(sys.stdin.readline), timeout=self._timeout
            )
        except TimeoutError:
            return ApprovalResult(False, Scope.ONCE, "prompt timed out", self.name)
        choice = (answer or "").strip().lower()[:1]
        if choice == "y":
            return ApprovalResult(True, Scope.ONCE, "user approved", self.name)
        if choice == "a":
            return ApprovalResult(True, Scope.TOOL, "user approved for this tool", self.name)
        if choice == "q":
            return ApprovalResult(False, Scope.NEVER, "user aborted the run", self.name)
        return ApprovalResult(False, Scope.ONCE, "user declined", self.name)


class ApprovalGate:
    """Caches scoped answers so a user is asked once per class, not per call."""

    def __init__(self, broker: ApprovalBroker) -> None:
        self.broker = broker
        self._tool_grants: set[str] = set()
        self._tool_denials: set[str] = set()
        self._blanket: bool | None = None
        self.history: list[dict[str, Any]] = field(default_factory=list)  # type: ignore[assignment]
        self.history = []

    async def ask(self, request: ApprovalRequest) -> ApprovalResult:
        tool = request.action.tool
        if self._blanket is False:
            return ApprovalResult(False, Scope.NEVER, "run was aborted by the user", "cache")
        if tool in self._tool_denials:
            return ApprovalResult(False, Scope.TOOL, "previously denied for this tool", "cache")
        if self._blanket is True or tool in self._tool_grants:
            return ApprovalResult(True, Scope.TOOL, "previously approved for this tool", "cache")

        result = await self.broker.request(request)
        if result.scope is Scope.TOOL:
            (self._tool_grants if result.approved else self._tool_denials).add(tool)
        elif result.scope is Scope.ALWAYS and result.approved:
            self._blanket = True
        elif result.scope is Scope.NEVER:
            self._blanket = False
        self.history.append(
            {
                "tool": tool,
                "summary": redact(request.action.describe()),
                "rule": request.decision.rule,
                "risk": request.decision.risk.name,
                **result.to_dict(),
            }
        )
        return result


def build_broker(mode: str) -> ApprovalBroker:
    if mode == "auto":
        return AutoApprove()
    if mode == "deny":
        return DenyAll()
    if sys.stdin and sys.stdin.isatty():
        return ConsoleApprover()
    # "prompt" with nowhere to prompt is a deny, never a silent yes.
    return DenyAll()
