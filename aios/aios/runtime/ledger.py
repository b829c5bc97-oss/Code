"""Append-only run ledger.

Two properties matter here and nothing else:

1. **Auditability.** After the fact you can answer "what exactly did it do, in
   what order, with what arguments, and who approved it" from a single file.
2. **Replayability.** The ledger is the event stream, so a run can be
   reconstructed - or resumed - without the process that produced it.

Format is newline-delimited JSON: append-only, crash-tolerant (a torn final
line is dropped on read), greppable, and streamable by `tail -f`.
"""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from ..foundation.logging import get_logger
from ..foundation.redaction import redact
from .events import Event, EventBus

log = get_logger("runtime.ledger")

# Topics important enough to force to disk immediately - approvals and
# destructive tool calls must survive a hard kill.
DURABLE_TOPICS = frozenset(
    {
        "run.started",
        "run.completed",
        "run.failed",
        "run.cancelled",
        "approval.granted",
        "approval.denied",
        "policy.blocked",
    }
)


class Ledger:
    """One JSONL file per run."""

    def __init__(self, path: Path, *, fsync_durable: bool = True) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = self.path.open("a", encoding="utf-8")
        self._lock = threading.Lock()
        self._fsync_durable = fsync_durable
        self._count = 0

    # -- writing ---------------------------------------------------------
    def append(self, event: Event) -> None:
        line = json.dumps(event.to_dict(), default=str, ensure_ascii=False)
        with self._lock:
            self._fh.write(line + "\n")
            self._count += 1
            if event.topic in DURABLE_TOPICS:
                self._fh.flush()
                if self._fsync_durable:
                    os.fsync(self._fh.fileno())
            elif self._count % 20 == 0:
                self._fh.flush()

    def record(self, topic: str, data: dict[str, Any], **kw: Any) -> None:
        self.append(Event(topic=topic, data=data, **kw))

    def attach(self, bus: EventBus, pattern: str = "*") -> str:
        """Mirror everything on the bus into this ledger."""
        return bus.subscribe(pattern, self.append)

    def flush(self) -> None:
        with self._lock:
            self._fh.flush()

    def close(self) -> None:
        with self._lock:
            if not self._fh.closed:
                self._fh.flush()
                try:
                    os.fsync(self._fh.fileno())
                except OSError:  # pragma: no cover - not supported on every filesystem
                    pass
                self._fh.close()

    def __enter__(self) -> Ledger:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -- reading ---------------------------------------------------------
    @staticmethod
    def read(path: Path | str) -> Iterator[Event]:
        """Iterate a ledger, tolerating a truncated final line."""
        file = Path(path)
        if not file.exists():
            return
        with file.open("r", encoding="utf-8") as fh:
            for lineno, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    yield Event.from_dict(json.loads(raw))
                except json.JSONDecodeError:
                    log.warning(
                        "dropping malformed ledger line",
                        extra={"file": str(file), "line": lineno},
                    )

    @staticmethod
    def summarize(path: Path | str) -> dict[str, Any]:
        """Cheap post-hoc summary without loading the whole stream."""
        counts: dict[str, int] = {}
        first: Event | None = None
        last: Event | None = None
        for event in Ledger.read(path):
            counts[event.topic] = counts.get(event.topic, 0) + 1
            first = first or event
            last = event
        return {
            "path": str(path),
            "events": sum(counts.values()),
            "topics": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
            "started_at": first.ts if first else None,
            "ended_at": last.ts if last else None,
            "run_id": first.run_id if first else None,
        }


class NullLedger(Ledger):
    """No-op ledger for ephemeral/test runs."""

    def __init__(self) -> None:
        self.path = Path(os.devnull)
        self.events: list[Event] = []

    def append(self, event: Event) -> None:
        self.events.append(Event.from_dict(redact(event.to_dict())))

    def flush(self) -> None:
        return None

    def close(self) -> None:
        return None
