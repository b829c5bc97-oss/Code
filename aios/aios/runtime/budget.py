"""Budget accounting.

An autonomous agent with a retry loop and a planner is, structurally, an
infinite money and time sink. The budget is the thing that makes it safe to
walk away from: hard ceilings on wall-clock, steps, tool calls, model calls,
tokens and dollars, checked before each consuming action rather than after.

Soft thresholds emit a warning event at 80% so the UI (and the planner) can
start cutting scope before the hard stop lands.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..foundation.clock import SYSTEM_CLOCK, Clock
from ..foundation.config import BudgetConfig
from ..foundation.errors import BudgetExceeded

WARN_RATIO = 0.8

# USD per 1M tokens (input, output). Unknown models fall back to a mid estimate
# so cost accounting degrades to "roughly right" rather than "silently zero".
PRICING: dict[str, tuple[float, float]] = {
    "claude-opus-5": (5.0, 25.0),
    "claude-sonnet-5": (3.0, 15.0),
    "claude-haiku-4-5-20251001": (1.0, 5.0),
    "_default": (3.0, 15.0),
}


@dataclass(slots=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cached_tokens: int = 0

    @property
    def total(self) -> int:
        return self.input_tokens + self.output_tokens

    def __add__(self, other: Usage) -> Usage:
        return Usage(
            self.input_tokens + other.input_tokens,
            self.output_tokens + other.output_tokens,
            self.cached_tokens + other.cached_tokens,
        )


def estimate_cost(model: str, usage: Usage) -> float:
    price_in, price_out = PRICING.get(model, PRICING["_default"])
    # Cached reads are billed at a large discount; 0.1x is the common ratio.
    billed_input = usage.input_tokens - usage.cached_tokens + usage.cached_tokens * 0.1
    return (billed_input * price_in + usage.output_tokens * price_out) / 1_000_000


@dataclass(slots=True)
class Budget:
    """Mutable accounting for one run."""

    limits: BudgetConfig = field(default_factory=BudgetConfig)
    clock: Clock = field(default=SYSTEM_CLOCK)

    # None until `start()`; a plain 0.0 sentinel is wrong because a monotonic
    # clock legitimately reads 0.0 at process start, which silently disabled
    # wall-clock enforcement for the first run.
    started_at: float | None = None
    steps: int = 0
    tool_calls: int = 0
    model_calls: int = 0
    usage: Usage = field(default_factory=Usage)
    usd: float = 0.0
    _warned: set[str] = field(default_factory=set)

    def start(self) -> None:
        self.started_at = self.clock.monotonic()

    # -- accounting ------------------------------------------------------
    @property
    def elapsed(self) -> float:
        if self.started_at is None:
            return 0.0
        return max(0.0, self.clock.monotonic() - self.started_at)

    @property
    def remaining_seconds(self) -> float:
        return max(0.0, self.limits.wall_clock_seconds - self.elapsed)

    def charge_step(self, n: int = 1) -> None:
        self.steps += n

    def charge_tool(self, n: int = 1) -> None:
        self.tool_calls += n

    def charge_model(self, model: str, usage: Usage) -> None:
        self.model_calls += 1
        self.usage = self.usage + usage
        self.usd += estimate_cost(model, usage)

    # -- enforcement -----------------------------------------------------
    def _dimensions(self) -> list[tuple[str, float, float]]:
        return [
            ("wall_clock_seconds", self.elapsed, self.limits.wall_clock_seconds),
            ("max_steps", self.steps, self.limits.max_steps),
            ("max_tool_calls", self.tool_calls, self.limits.max_tool_calls),
            ("max_model_calls", self.model_calls, self.limits.max_model_calls),
            ("max_tokens", self.usage.total, self.limits.max_tokens),
            ("max_usd", self.usd, self.limits.max_usd),
        ]

    def check(self, *, what: str = "action") -> None:
        """Raise :class:`BudgetExceeded` if any hard limit is breached.

        Deliberately side-effect free: enforcement is called from several places
        (scheduler admission, executor dispatch, model client), and folding
        warning bookkeeping in here meant whichever caller happened to check
        first silently consumed the warning. Reporting lives in
        :meth:`new_warnings`, which exactly one caller owns.
        """
        for name, used, limit in self._dimensions():
            if limit > 0 and used >= limit:
                raise BudgetExceeded(
                    f"budget exhausted before {what}: {name} {used:.2f} >= {limit:.2f}",
                    context={"limit": name, "used": used, "allowed": limit, **self.snapshot()},
                )

    def new_warnings(self) -> list[str]:
        """Dimensions that have just crossed the soft threshold. Reported once."""
        crossed: list[str] = []
        for name, used, limit in self._dimensions():
            if limit <= 0 or name in self._warned:
                continue
            if used >= limit * WARN_RATIO:
                self._warned.add(name)
                crossed.append(name)
        return crossed

    def would_exceed(self, *, steps: int = 0, seconds: float = 0.0) -> bool:
        """Non-raising lookahead used by the scheduler before admitting work."""
        if self.limits.max_steps and self.steps + steps > self.limits.max_steps:
            return True
        return bool(
            self.limits.wall_clock_seconds
            and self.elapsed + seconds > self.limits.wall_clock_seconds
        )

    def snapshot(self) -> dict[str, Any]:
        return {
            "elapsed_s": round(self.elapsed, 2),
            "steps": self.steps,
            "tool_calls": self.tool_calls,
            "model_calls": self.model_calls,
            "input_tokens": self.usage.input_tokens,
            "output_tokens": self.usage.output_tokens,
            "cached_tokens": self.usage.cached_tokens,
            "usd": round(self.usd, 4),
        }

    def report(self) -> dict[str, Any]:
        used = self.snapshot()
        limits = {
            "wall_clock_seconds": self.limits.wall_clock_seconds,
            "max_steps": self.limits.max_steps,
            "max_tool_calls": self.limits.max_tool_calls,
            "max_model_calls": self.limits.max_model_calls,
            "max_tokens": self.limits.max_tokens,
            "max_usd": self.limits.max_usd,
        }
        return {"used": used, "limits": limits}
