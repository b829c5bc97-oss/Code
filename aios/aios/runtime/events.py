"""The event backbone.

Every observable thing the OS does is an :class:`Event` on the bus. The UI, the
audit ledger, the budget accountant and the memory writer are all just
subscribers, which is what keeps the kernel free of presentation concerns and
makes the whole system replayable from its event log.

Delivery contract:
- handlers for one publish run **sequentially in subscription order**, so a
  subscriber that persists state is guaranteed to see events in causal order;
- a handler that raises is logged and skipped - a broken UI can never take down
  an execution;
- ``publish`` awaits delivery, which gives natural backpressure instead of an
  unbounded queue that silently grows during long runs.
"""

from __future__ import annotations

import asyncio
import fnmatch
import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from ..foundation.clock import SYSTEM_CLOCK, Clock
from ..foundation.ids import new_id
from ..foundation.logging import get_logger
from ..foundation.redaction import redact

log = get_logger("runtime.events")


class Topic:
    """Well-known topic names. Topics are dotted; subscribers may glob."""

    RUN_STARTED = "run.started"
    RUN_UNDERSTOOD = "run.understood"
    RUN_PLANNED = "run.planned"
    RUN_REPLANNED = "run.replanned"
    RUN_COMPLETED = "run.completed"
    RUN_FAILED = "run.failed"
    RUN_CANCELLED = "run.cancelled"

    STEP_QUEUED = "step.queued"
    STEP_STARTED = "step.started"
    STEP_PROGRESS = "step.progress"
    STEP_SUCCEEDED = "step.succeeded"
    STEP_FAILED = "step.failed"
    STEP_RETRYING = "step.retrying"
    STEP_SKIPPED = "step.skipped"
    STEP_BLOCKED = "step.blocked"

    TOOL_INVOKED = "tool.invoked"
    TOOL_RETURNED = "tool.returned"
    TOOL_FAILED = "tool.failed"

    MODEL_REQUEST = "model.request"
    MODEL_RESPONSE = "model.response"

    VERIFY_STARTED = "verify.started"
    VERIFY_PASSED = "verify.passed"
    VERIFY_FAILED = "verify.failed"

    RECOVERY_ATTEMPT = "recovery.attempt"
    RECOVERY_EXHAUSTED = "recovery.exhausted"

    APPROVAL_REQUESTED = "approval.requested"
    APPROVAL_GRANTED = "approval.granted"
    APPROVAL_DENIED = "approval.denied"
    POLICY_BLOCKED = "policy.blocked"

    ARTIFACT_CREATED = "artifact.created"
    BUDGET_WARNING = "budget.warning"
    BUDGET_EXCEEDED = "budget.exceeded"
    MEMORY_WRITTEN = "memory.written"

    LOG = "log"


@dataclass(slots=True)
class Event:
    topic: str
    data: dict[str, Any] = field(default_factory=dict)
    run_id: str | None = None
    step_id: str | None = None
    seq: int = 0
    ts: str = ""
    id: str = field(default_factory=lambda: new_id("evt_"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "seq": self.seq,
            "ts": self.ts,
            "topic": self.topic,
            "run_id": self.run_id,
            "step_id": self.step_id,
            "data": redact(self.data),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> Event:
        return cls(
            topic=payload["topic"],
            data=payload.get("data") or {},
            run_id=payload.get("run_id"),
            step_id=payload.get("step_id"),
            seq=payload.get("seq", 0),
            ts=payload.get("ts", ""),
            id=payload.get("id", new_id("evt_")),
        )


Handler = Callable[[Event], Awaitable[None] | None]


@dataclass(slots=True)
class _Subscription:
    pattern: str
    handler: Handler
    token: str


class EventBus:
    """In-process publish/subscribe with glob topic matching."""

    def __init__(self, clock: Clock | None = None) -> None:
        self._subs: list[_Subscription] = []
        self._clock = clock or SYSTEM_CLOCK
        self._seq = 0
        self._lock = asyncio.Lock()
        self._closed = False

    def subscribe(self, pattern: str, handler: Handler) -> str:
        """Subscribe to a glob pattern such as ``step.*`` or ``*``."""
        token = new_id("sub_")
        self._subs.append(_Subscription(pattern, handler, token))
        return token

    def unsubscribe(self, token: str) -> bool:
        before = len(self._subs)
        self._subs = [s for s in self._subs if s.token != token]
        return len(self._subs) != before

    async def publish(
        self,
        topic: str,
        data: dict[str, Any] | None = None,
        *,
        run_id: str | None = None,
        step_id: str | None = None,
    ) -> Event:
        if self._closed:
            raise RuntimeError("event bus is closed")
        async with self._lock:
            self._seq += 1
            seq = self._seq
        event = Event(
            topic=topic,
            data=data or {},
            run_id=run_id,
            step_id=step_id,
            seq=seq,
            ts=self._clock.isoformat(),
        )
        await self._dispatch(event)
        return event

    async def emit(self, event: Event) -> None:
        """Republish a pre-built event (used when replaying a ledger)."""
        await self._dispatch(event)

    async def _dispatch(self, event: Event) -> None:
        for sub in list(self._subs):
            if not _matches(sub.pattern, event.topic):
                continue
            try:
                result = sub.handler(event)
                if inspect.isawaitable(result):
                    await result
            except asyncio.CancelledError:
                raise
            except Exception:
                # A subscriber must never break execution.
                log.exception("event subscriber failed", extra={"topic": event.topic})

    def close(self) -> None:
        self._closed = True
        self._subs.clear()


def _matches(pattern: str, topic: str) -> bool:
    if pattern in ("*", "**"):
        return True
    return fnmatch.fnmatchcase(topic, pattern)


class Recorder:
    """Captures events in memory. Used by tests and by the run report."""

    def __init__(self, bus: EventBus, pattern: str = "*") -> None:
        self.events: list[Event] = []
        self.token = bus.subscribe(pattern, self._on_event)

    def _on_event(self, event: Event) -> None:
        self.events.append(event)

    def topics(self) -> list[str]:
        return [e.topic for e in self.events]

    def of(self, pattern: str) -> list[Event]:
        return [e for e in self.events if _matches(pattern, e.topic)]

    def last(self, pattern: str) -> Event | None:
        matched = self.of(pattern)
        return matched[-1] if matched else None
