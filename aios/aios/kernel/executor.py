"""Step execution.

The inner loop of the OS. For one step it owns the full cycle:

    resolve references → policy check → (approval) → invoke → verify → recover

and it keeps cycling until the step reaches a terminal outcome. Everything that
makes execution *trustworthy* is concentrated here:

- arguments are resolved from real upstream results, never guessed;
- the policy verdict is taken before the tool runs, not after;
- success is defined by the verifier, not by the tool's own report;
- a failure is routed through the recovery engine, which may rewrite the step's
  arguments or tool and send it around the loop again.

The executor never raises for an ordinary failure - it returns a
:class:`StepOutcome`. Only cancellation propagates, because that must unwind.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from ..cognition.plan import Plan, Step, StepState, resolve_references
from ..cognition.recovery import Action, Attempt, RecoveryEngine
from ..cognition.verifier import Verifier
from ..foundation.clock import Clock
from ..foundation.config import Config
from ..foundation.errors import (
    AiosError,
    ApprovalDenied,
    Cancelled,
    PermissionDenied,
    PlanError,
    classify,
)
from ..foundation.logging import get_logger, log_context
from ..runtime.events import EventBus, Topic
from ..security.approvals import ApprovalGate, ApprovalRequest
from ..security.policy import PolicyEngine, Verdict
from ..tools.base import ToolContext, ToolResult
from ..tools.registry import ToolRegistry

log = get_logger("kernel.executor")


@dataclass(slots=True)
class StepOutcome:
    step: Step
    state: StepState
    result: ToolResult | None = None
    error: AiosError | None = None
    attempts: int = 0
    recoveries: list[dict[str, Any]] = field(default_factory=list)
    spawned: list[Step] = field(default_factory=list)
    needs_human: str = ""

    @property
    def ok(self) -> bool:
        return self.state in {StepState.SUCCEEDED, StepState.SKIPPED}

    def binding_value(self) -> Any:
        """What later steps see as ``${step.…}``."""
        if self.result is None:
            return {}
        payload = self.result.output
        base: dict[str, Any] = dict(payload) if isinstance(payload, dict) else {"value": payload}
        base.setdefault("summary", self.result.summary)
        base.setdefault("ok", self.result.ok)
        if self.result.artifacts:
            base.setdefault("artifact_path", self.result.artifacts[0].path)
            base.setdefault("artifacts", [a.name for a in self.result.artifacts])
        return base


class StepExecutor:
    def __init__(
        self,
        *,
        registry: ToolRegistry,
        policy: PolicyEngine,
        gate: ApprovalGate,
        verifier: Verifier,
        recovery: RecoveryEngine,
        bus: EventBus,
        config: Config,
        clock: Clock,
        context_factory: Any,
    ) -> None:
        self.registry = registry
        self.policy = policy
        self.gate = gate
        self.verifier = verifier
        self.recovery = recovery
        self.bus = bus
        self.config = config
        self.clock = clock
        self._context_factory = context_factory

    async def execute(
        self, step: Step, plan: Plan, bindings: dict[str, Any], *, run_id: str
    ) -> StepOutcome:
        outcome = StepOutcome(step=step, state=StepState.RUNNING)
        step.state = StepState.RUNNING
        step.started_at = self.clock.monotonic()

        with log_context(run=run_id[-8:], step=step.name[:28]):
            await self.bus.publish(
                Topic.STEP_STARTED,
                {"name": step.name, "tool": step.tool, "optional": step.optional,
                 "rationale": step.rationale},
                run_id=run_id, step_id=step.id,
            )
            try:
                await self._cycle(step, plan, bindings, run_id, outcome)
            except asyncio.CancelledError:
                step.state = StepState.CANCELLED
                outcome.state = StepState.CANCELLED
                outcome.error = Cancelled(f"{step.name} cancelled")
                raise
            finally:
                step.ended_at = self.clock.monotonic()
                step.attempts = outcome.attempts

        topic = {
            StepState.SUCCEEDED: Topic.STEP_SUCCEEDED,
            StepState.SKIPPED: Topic.STEP_SKIPPED,
        }.get(outcome.state, Topic.STEP_FAILED)
        await self.bus.publish(
            topic,
            {"name": step.name, "tool": step.tool, "state": outcome.state.value,
             "attempts": outcome.attempts, "duration_s": round(step.duration, 3),
             "summary": (outcome.result.summary if outcome.result else "")[:400],
             "error": outcome.error.to_dict() if outcome.error else None,
             "recoveries": outcome.recoveries},
            run_id=run_id, step_id=step.id,
        )
        return outcome

    async def _cycle(
        self,
        step: Step,
        plan: Plan,
        bindings: dict[str, Any],
        run_id: str,
        outcome: StepOutcome,
    ) -> None:
        hard_cap = max(4, (step.max_attempts or self.config.execution.max_attempts) * 2)

        while outcome.attempts < hard_cap:
            outcome.attempts += 1
            try:
                result = await self._attempt(step, bindings, run_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                error = classify(exc)
            else:
                if result.ok:
                    step.state = StepState.SUCCEEDED
                    step.result = result.output
                    outcome.state = StepState.SUCCEEDED
                    outcome.result = result
                    return
                error = result.error or AiosError(result.summary or "step failed")
                outcome.result = result

            outcome.error = error
            step.error = error.to_dict()
            log.warning(
                "step failed",
                extra={"tool": step.tool, "error": error.code, "attempt": outcome.attempts,
                       "detail": error.message[:200]},
            )

            recovery = await self.recovery.decide(step, error, plan)
            outcome.recoveries.append(recovery.to_dict())
            self.recovery.record(
                step, Attempt(recovery.action, step.tool, error.code, error.message[:200])
            )
            await self.bus.publish(
                Topic.RECOVERY_ATTEMPT,
                {"step": step.name, "error": error.code, **recovery.to_dict()},
                run_id=run_id, step_id=step.id,
            )

            if recovery.action == Action.RETRY:
                await self.clock.sleep(recovery.delay_seconds)
                await self.bus.publish(
                    Topic.STEP_RETRYING,
                    {"step": step.name, "attempt": outcome.attempts + 1,
                     "delay_s": round(recovery.delay_seconds, 2), "reason": recovery.reason},
                    run_id=run_id, step_id=step.id,
                )
                continue

            if recovery.action == Action.REPAIR and recovery.arguments is not None:
                step.arguments = recovery.arguments
                continue

            if recovery.action == Action.SUBSTITUTE and recovery.tool:
                step.tool = recovery.tool
                continue

            if recovery.action == Action.DECOMPOSE and recovery.steps:
                outcome.spawned = recovery.steps
                step.state = StepState.SKIPPED
                outcome.state = StepState.SKIPPED
                return

            if recovery.action == Action.SKIP:
                step.state = StepState.SKIPPED
                outcome.state = StepState.SKIPPED
                return

            if recovery.action == Action.ESCALATE:
                outcome.needs_human = recovery.reason
                step.state = StepState.FAILED
                outcome.state = StepState.FAILED
                await self.bus.publish(
                    Topic.RECOVERY_EXHAUSTED,
                    {"step": step.name, "needs_human": recovery.reason},
                    run_id=run_id, step_id=step.id,
                )
                return

            step.state = StepState.FAILED
            outcome.state = StepState.FAILED
            await self.bus.publish(
                Topic.RECOVERY_EXHAUSTED,
                {"step": step.name, "reason": recovery.reason, "error": error.code},
                run_id=run_id, step_id=step.id,
            )
            return

        step.state = StepState.FAILED
        outcome.state = StepState.FAILED
        outcome.error = outcome.error or AiosError("step exhausted its attempt budget")

    async def _attempt(
        self, step: Step, bindings: dict[str, Any], run_id: str
    ) -> ToolResult:
        tool = self.registry.get(step.tool)
        try:
            arguments = resolve_references(step.arguments, bindings)
        except PlanError as exc:
            raise exc

        ctx: ToolContext = self._context_factory(step)
        action = tool.plan_action(arguments)
        action.run_id, action.step_id = run_id, step.id
        decision = self.policy.evaluate(action)

        if decision.verdict is Verdict.DENY:
            await self.bus.publish(
                Topic.POLICY_BLOCKED,
                {"step": step.name, "tool": tool.name, **decision.to_dict()},
                run_id=run_id, step_id=step.id,
            )
            raise PermissionDenied(
                f"policy denied {tool.name}: {decision.reason}",
                context={"rule": decision.rule, "tool": tool.name},
            )

        if decision.verdict is Verdict.CONFIRM:
            await self.bus.publish(
                Topic.APPROVAL_REQUESTED,
                {"step": step.name, "tool": tool.name, "summary": action.describe(),
                 **decision.to_dict()},
                run_id=run_id, step_id=step.id,
            )
            approval = await self.gate.ask(
                ApprovalRequest(
                    action=action,
                    decision=decision,
                    prompt=f"{step.name}: {action.describe()}",
                )
            )
            await self.bus.publish(
                Topic.APPROVAL_GRANTED if approval.approved else Topic.APPROVAL_DENIED,
                {"step": step.name, "tool": tool.name, **approval.to_dict()},
                run_id=run_id, step_id=step.id,
            )
            if not approval.approved:
                raise ApprovalDenied(
                    f"approval declined for {tool.name}: {approval.reason}",
                    context={"tool": tool.name, "rule": decision.rule},
                )

        ctx.budget.check(what=f"step {step.name}")
        result = await tool.run(arguments, ctx, timeout=step.timeout_seconds)

        # Verification asserts on real side effects. A dry run produces none by
        # design, so checking would fail every file contract and send a
        # simulation into the recovery loop.
        if result.ok and self.config.execution.verify and not ctx.dry_run:
            await self.verifier.verify(step, result, ctx)
        return result
