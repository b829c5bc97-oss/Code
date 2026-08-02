"""Failure recovery.

The premise: **a failure is information, not a stop condition.** When a step
fails, the engine picks the cheapest strategy with a real chance of working,
escalating only when it runs out of options.

Strategy ladder, cheapest first:

``RETRY``       transient - network blip, lock contention, rate limit
``REPAIR``      the arguments were wrong; a model fixes them against the schema
``SUBSTITUTE``  this tool cannot do it; an equivalent tool can
``DECOMPOSE``   the step was too coarse; break it into smaller ones
``SKIP``        the step was optional and the goal survives without it
``ESCALATE``    a human decision is genuinely required
``ABORT``       nothing left to try

Two safeguards keep this from becoming an expensive infinite loop: every
attempt is recorded in a per-step history so the same repair is never tried
twice, and the total number of recovery actions per step is bounded.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any

from ..foundation.config import ExecutionConfig
from ..foundation.errors import (
    AiosError,
    ApprovalDenied,
    BudgetExceeded,
    Cancelled,
    InvalidArguments,
    Remedy,
    SandboxViolation,
    ToolNotFound,
    VerificationFailed,
)
from ..foundation.logging import get_logger
from ..model.client import ModelClient
from ..security.capabilities import CapabilitySet
from ..tools.registry import ToolRegistry
from .plan import Plan, Step

log = get_logger("cognition.recovery")


class Action(str):
    RETRY = "retry"
    REPAIR = "repair"
    SUBSTITUTE = "substitute"
    DECOMPOSE = "decompose"
    SKIP = "skip"
    ESCALATE = "escalate"
    ABORT = "abort"


@dataclass(slots=True)
class Recovery:
    action: str
    reason: str
    delay_seconds: float = 0.0
    tool: str | None = None
    arguments: dict[str, Any] | None = None
    steps: list[Step] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "reason": self.reason,
            "delay_s": round(self.delay_seconds, 2),
            "tool": self.tool,
            "arguments": self.arguments,
            "steps": [s.name for s in self.steps],
        }


@dataclass(slots=True)
class Attempt:
    action: str
    tool: str
    error_code: str
    detail: str = ""


class RecoveryEngine:
    def __init__(
        self,
        registry: ToolRegistry,
        config: ExecutionConfig,
        *,
        model: ModelClient | None = None,
        grant: CapabilitySet | None = None,
    ) -> None:
        self.registry = registry
        self.config = config
        self.model = model
        self.grant = grant or CapabilitySet.standard()
        self.history: dict[str, list[Attempt]] = {}

    def record(self, step: Step, attempt: Attempt) -> None:
        self.history.setdefault(step.id, []).append(attempt)

    def attempts_for(self, step: Step) -> list[Attempt]:
        return self.history.get(step.id, [])

    async def decide(self, step: Step, error: AiosError, plan: Plan) -> Recovery:
        """Choose the next move for a failed step."""
        past = self.attempts_for(step)
        max_attempts = step.max_attempts or self.config.max_attempts

        # --- unrecoverable by construction --------------------------------
        if isinstance(error, Cancelled | BudgetExceeded):
            return Recovery(Action.ABORT, f"{error.code}: not recoverable")
        if isinstance(error, SandboxViolation):
            return Recovery(
                Action.ABORT,
                "the step tried to leave the workspace; refusing to retry a sandbox escape",
            )
        if isinstance(error, ApprovalDenied):
            return self._optional_or(step, Action.ABORT, "the user declined this action")

        # --- needs a person ------------------------------------------------
        if error.remedy is Remedy.ESCALATE:
            return self._optional_or(step, Action.ESCALATE, error.message)

        # --- transient: retry with jittered backoff -------------------------
        retries = sum(1 for a in past if a.action == Action.RETRY)
        if error.retryable and retries < max_attempts - 1:
            delay = _backoff(
                retries + 1,
                base=self.config.backoff_base_seconds,
                cap=self.config.backoff_max_seconds,
                jitter=self.config.backoff_jitter,
            )
            hinted = getattr(error, "retry_after", None)
            return Recovery(
                Action.RETRY,
                f"{error.code} is transient (attempt {retries + 2}/{max_attempts})",
                delay_seconds=float(hinted) if hinted else delay,
            )

        # --- bad arguments: repair against the schema -----------------------
        repaired = sum(1 for a in past if a.action == Action.REPAIR)
        if (
            isinstance(error, InvalidArguments | VerificationFailed)
            or error.remedy is Remedy.REPAIR_INPUT
        ) and repaired < 2:
            fixed = await self._repair_arguments(step, error)
            if fixed is not None and fixed != step.arguments:
                return Recovery(
                    Action.REPAIR,
                    f"repairing arguments after {error.code}",
                    arguments=fixed,
                )

        # --- a different tool might do it -----------------------------------
        substituted = {a.tool for a in past if a.action == Action.SUBSTITUTE}
        if isinstance(error, ToolNotFound) or error.remedy is Remedy.SUBSTITUTE or repaired >= 1:
            alternative = self._find_alternative(step, exclude=substituted | {step.tool})
            if alternative:
                return Recovery(
                    Action.SUBSTITUTE,
                    f"trying {alternative} instead of {step.tool} after {error.code}",
                    tool=alternative,
                )

        # --- break it into smaller pieces ------------------------------------
        decomposed = sum(1 for a in past if a.action == Action.DECOMPOSE)
        if error.remedy is Remedy.DECOMPOSE and decomposed == 0:
            children = await self._decompose(step, error, plan)
            if children:
                return Recovery(
                    Action.DECOMPOSE,
                    f"splitting {step.name!r} into {len(children)} smaller steps",
                    steps=children,
                )

        # --- verification specifically: one clean retry is often enough -------
        if isinstance(error, VerificationFailed) and retries == 0:
            return Recovery(
                Action.RETRY,
                "output did not satisfy its contract; retrying once",
                delay_seconds=self.config.backoff_base_seconds,
            )

        return self._optional_or(
            step, Action.ABORT, f"no recovery strategy left for {error.code}"
        )

    def _optional_or(self, step: Step, otherwise: str, reason: str) -> Recovery:
        if step.optional and self.config.continue_on_optional_failure:
            return Recovery(Action.SKIP, f"optional step skipped: {reason}")
        return Recovery(otherwise, reason)

    # -- strategies ------------------------------------------------------
    async def _repair_arguments(self, step: Step, error: AiosError) -> dict[str, Any] | None:
        tool = self.registry.try_get(step.tool)
        if tool is None:
            return None

        mechanical = _mechanical_repair(step.arguments, error, tool.parameters)
        if mechanical is not None:
            return mechanical
        if self.model is None:
            return None

        import json

        schema = tool.parameters
        prompt = (
            f"A step failed and must be retried with corrected arguments.\n\n"
            f"Step: {step.name}\nTool: {tool.name} - {tool.summary}\n"
            f"Arguments used:\n{json.dumps(step.arguments, indent=2, default=str)[:2000]}\n\n"
            f"Failure ({error.code}): {error.message}\n"
            f"Details: {json.dumps(error.context, default=str)[:1500]}\n\n"
            "Return corrected arguments for the same tool. Change only what the failure "
            "requires. If the arguments were already correct, return them unchanged."
        )
        try:
            repaired = await self.model.structured(
                prompt, schema, system=f"Tool schema:\n{json.dumps(schema)[:3000]}",
                purpose="recovery/repair",
            )
        except Exception:
            log.debug("argument repair failed", exc_info=True)
            return None
        return repaired if isinstance(repaired, dict) else None

    def _find_alternative(self, step: Step, *, exclude: set[str]) -> str | None:
        for candidate in self.registry.alternatives(step.tool, grant=self.grant):
            if candidate.name in exclude:
                continue
            # Never substitute upward in risk - a recovery must not escalate authority.
            original = self.registry.try_get(step.tool)
            if original is not None and candidate.risk > original.risk:
                continue
            return candidate.name
        return None

    async def _decompose(self, step: Step, error: AiosError, plan: Plan) -> list[Step]:
        if self.model is None:
            return []
        import json

        from .planner import PLAN_SCHEMA

        catalog = self.registry.catalog(self.grant)
        prompt = (
            f"This single step was too large and failed:\n"
            f"  name: {step.name}\n  tool: {step.tool}\n"
            f"  arguments: {json.dumps(step.arguments, default=str)[:1200]}\n"
            f"  failure ({error.code}): {error.message}\n\n"
            f"Overall goal: {plan.goal}\n\n"
            f"Available tools:\n{catalog}\n\n"
            "Replace it with 2-5 smaller steps that together accomplish the same thing."
        )
        try:
            payload = await self.model.structured(
                prompt, PLAN_SCHEMA, purpose="recovery/decompose"
            )
        except Exception:
            log.debug("decomposition failed", exc_info=True)
            return []

        children: list[Step] = []
        for index, raw in enumerate((payload.get("steps") or [])[:5]):
            if not self.registry.has(raw.get("tool", "")):
                continue
            child = Step(
                name=raw.get("name") or f"{step.name} ({index + 1})",
                tool=raw["tool"],
                arguments=raw.get("arguments") or {},
                binding=f"{step.ref}_{index + 1}",
                depends_on=list(step.depends_on) if index == 0 else [children[-1].id],
                optional=step.optional,
                rationale=f"decomposed from {step.name!r}",
            )
            children.append(child)
        return children


def _mechanical_repair(
    arguments: dict[str, Any], error: AiosError, schema: dict[str, Any]
) -> dict[str, Any] | None:
    """Fixes that need no model: drop unknown keys, fill missing defaults.

    Worth doing first because it is free, instant and deterministic - the most
    common argument failures are exactly these two shapes.
    """
    errors = error.context.get("errors") or []
    if not errors:
        return None
    properties: dict[str, Any] = schema.get("properties", {})
    repaired = dict(arguments)
    changed = False

    for message in errors:
        if "unexpected propert" in message:
            for key in list(repaired):
                if key not in properties:
                    repaired.pop(key)
                    changed = True
        if "missing required property" in message:
            name = message.split("property")[-1].strip().strip("'\"")
            spec = properties.get(name, {})
            if "default" in spec:
                repaired[name] = spec["default"]
                changed = True
    return repaired if changed else None


def _backoff(attempt: int, *, base: float, cap: float, jitter: float) -> float:
    delay = min(cap, base * (2 ** (attempt - 1)))
    return max(0.0, delay * (1 - jitter + random.random() * 2 * jitter))
