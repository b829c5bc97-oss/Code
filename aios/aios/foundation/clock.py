"""Injectable time source.

Every deadline, budget and backoff in the kernel reads time through a Clock so
that tests can drive multi-minute retry schedules in microseconds instead of
sleeping through them.
"""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime


class Clock:
    """Real wall-clock / monotonic time."""

    def now(self) -> datetime:
        return datetime.now(UTC)

    def monotonic(self) -> float:
        return time.monotonic()

    async def sleep(self, seconds: float) -> None:
        if seconds > 0:
            await asyncio.sleep(seconds)

    def isoformat(self) -> str:
        return self.now().isoformat()


class ManualClock(Clock):
    """Deterministic clock for tests; ``sleep`` advances instantly."""

    def __init__(self, start: datetime | None = None) -> None:
        self._now = start or datetime(2025, 1, 1, tzinfo=UTC)
        self._mono = 0.0
        self.slept: list[float] = []

    def now(self) -> datetime:
        return self._now

    def monotonic(self) -> float:
        return self._mono

    async def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.advance(seconds)
        await asyncio.sleep(0)  # still yield so other tasks interleave

    def advance(self, seconds: float) -> None:
        from datetime import timedelta

        self._mono += seconds
        self._now = self._now + timedelta(seconds=seconds)


SYSTEM_CLOCK = Clock()
