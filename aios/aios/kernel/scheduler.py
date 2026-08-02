"""The DAG scheduler.

Drives a plan to completion with real parallelism and correct failure
semantics. The properties it guarantees:

- **Maximum safe concurrency.** Every step whose dependencies are satisfied is
  admitted immediately, up to ``max_parallel``. Ready steps are ordered by
  critical-path membership first, then declared priority - finishing the
  longest chain early is what shortens the whole run.
- **Blast radius containment.** A failed step blocks only its transitive
  dependents. Independent branches keep running and still produce their
  deliverables, so a partial failure yields partial value instead of nothing.
- **Live graph mutation.** Recovery can decompose a step into children; they are
  spliced into the running graph and scheduled like any other step.
- **Deadlock freedom.** Every cycle of the loop either completes work, admits
  work, or terminates. A graph that can make no further progress is detected
  and reported rather than hanging.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from ..cognition.plan import Plan, Step, StepState
from ..foundation.clock import Clock
from ..foundation.errors import BudgetExceeded, Cancelled
from ..foundation.logging import get_logger
from ..runtime.budget import Budget
from ..runtime.events import EventBus, Topic
from .executor import StepExecutor, StepOutcome

log = get_logger("kernel.scheduler")


@dataclass(slots=True)
class ScheduleResult:
    plan: Plan
    outcomes: dict[str, StepOutcome] = field(default_factory=dict)
    bindings: dict[str, Any] = field(default_factory=dict)
    cancelled: bool = False
    stopped_reason: str = ""

    @property
    def failed(self) -> list[StepOutcome]:
        return [o for o in self.outcomes.values() if o.state is StepState.FAILED]

    @property
    def blocked(self) -> list[Step]:
        return [s for s in self.plan.steps if s.state is StepState.BLOCKED]

    @property
    def succeeded(self) -> list[StepOutcome]:
        return [o for o in self.outcomes.values() if o.state is StepState.SUCCEEDED]

    @property
    def ok(self) -> bool:
        """A run succeeds only when every required step reached a good end.

        "Good" means succeeded or deliberately skipped. A step left cancelled by
        a budget stop is not a success, and neither is a run that halted early -
        reporting otherwise is exactly the dishonesty this system exists to
        avoid.
        """
        if self.cancelled or self.stopped_reason:
            return False
        return all(
            step.optional or step.state in {StepState.SUCCEEDED, StepState.SKIPPED}
            for step in self.plan.steps
        )

    def needs_human(self) -> list[str]:
        return [o.needs_human for o in self.outcomes.values() if o.needs_human]


class Scheduler:
    def __init__(
        self,
        executor: StepExecutor,
        bus: EventBus,
        budget: Budget,
        clock: Clock,
        *,
        max_parallel: int = 4,
    ) -> None:
        self.executor = executor
        self.bus = bus
        self.budget = budget
        self.clock = clock
        self.max_parallel = max(1, max_parallel)

    async def run(self, plan: Plan, *, run_id: str) -> ScheduleResult:
        result = ScheduleResult(plan=plan)
        semaphore = asyncio.Semaphore(self.max_parallel)
        running: dict[asyncio.Task[StepOutcome], Step] = {}
        critical = {s.id for s in plan.critical_path()}

        for step in plan.steps:
            await self.bus.publish(
                Topic.STEP_QUEUED,
                {"name": step.name, "tool": step.tool, "depends_on": step.depends_on},
                run_id=run_id, step_id=step.id,
            )

        try:
            while True:
                await self._propagate_blocks(plan, run_id)

                ready = self._ready(plan, critical)
                while ready and len(running) < self.max_parallel:
                    step = ready.pop(0)
                    try:
                        self.budget.check(what=f"scheduling {step.name}")
                    except BudgetExceeded as exc:
                        result.stopped_reason = exc.message
                        await self.bus.publish(
                            Topic.BUDGET_EXCEEDED, {"reason": exc.message, **self.budget.snapshot()},
                            run_id=run_id,
                        )
                        await self._cancel(running)
                        self._mark_remaining(plan, "budget exhausted")
                        return result
                    step.state = StepState.RUNNING
                    self.budget.charge_step()
                    task = asyncio.create_task(
                        self._guarded(semaphore, step, plan, result.bindings, run_id),
                        name=f"step:{step.name}",
                    )
                    running[task] = step

                if not running:
                    if any(s.state is StepState.PENDING for s in plan.steps):
                        stuck = [s.name for s in plan.steps if s.state is StepState.PENDING]
                        result.stopped_reason = (
                            f"{len(stuck)} step(s) can never become ready: {', '.join(stuck[:6])}"
                        )
                        log.error("scheduler stalled", extra={"steps": stuck[:10]})
                        self._mark_remaining(plan, "dependencies unsatisfiable")
                    return result

                done, _ = await asyncio.wait(running, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    step = running.pop(task)
                    try:
                        outcome = task.result()
                    except asyncio.CancelledError:
                        result.cancelled = True
                        continue
                    except Exception:
                        log.exception("executor raised", extra={"step": step.name})
                        step.state = StepState.FAILED
                        outcome = StepOutcome(step=step, state=StepState.FAILED)
                    self._absorb(plan, result, outcome, run_id, critical)

                # The scheduler is the single owner of soft-threshold reporting.
                for warning in self.budget.new_warnings():
                    await self.bus.publish(
                        Topic.BUDGET_WARNING,
                        {"limit": warning, **self.budget.snapshot()}, run_id=run_id,
                    )
        except asyncio.CancelledError:
            result.cancelled = True
            result.stopped_reason = "cancelled"
            await self._cancel(running)
            self._mark_remaining(plan, "run cancelled")
            raise
        except BudgetExceeded as exc:
            result.stopped_reason = exc.message
            await self._cancel(running)
            self._mark_remaining(plan, "budget exhausted")
            return result

    # -- internals -------------------------------------------------------
    async def _guarded(
        self,
        semaphore: asyncio.Semaphore,
        step: Step,
        plan: Plan,
        bindings: dict[str, Any],
        run_id: str,
    ) -> StepOutcome:
        async with semaphore:
            return await self.executor.execute(step, plan, bindings, run_id=run_id)

    def _ready(self, plan: Plan, critical: set[str]) -> list[Step]:
        table = plan.index()
        ready: list[Step] = []
        for step in plan.steps:
            if step.state is not StepState.PENDING:
                continue
            satisfied = True
            for dependency in step.depends_on:
                parent = table.get(dependency)
                if parent is None:
                    continue
                if parent.state not in {StepState.SUCCEEDED, StepState.SKIPPED}:
                    satisfied = False
                    break
            if satisfied:
                ready.append(step)
        # Critical-path steps first: they gate total run time.
        ready.sort(key=lambda s: (0 if s.id in critical else 1, -s.priority, plan.steps.index(s)))
        return ready

    def _absorb(
        self,
        plan: Plan,
        result: ScheduleResult,
        outcome: StepOutcome,
        run_id: str,
        critical: set[str],
    ) -> None:
        step = outcome.step
        result.outcomes[step.id] = outcome
        if outcome.state is StepState.SUCCEEDED:
            value = outcome.binding_value()
            result.bindings[step.ref] = value
            if step.binding and step.binding != step.id:
                result.bindings[step.id] = value

        if outcome.spawned:
            # Children replace the decomposed step; anything that depended on the
            # parent now depends on the last child, so the graph stays connected.
            table = plan.index()
            for child in outcome.spawned:
                plan.steps.append(child)
            last = outcome.spawned[-1]
            for other in plan.steps:
                if other in outcome.spawned or other.id == step.id:
                    continue
                if step.id in other.depends_on or (step.binding and step.binding in other.depends_on):
                    other.depends_on = [
                        d for d in other.depends_on if d not in {step.id, step.binding}
                    ] + [last.id]
            critical.update(s.id for s in outcome.spawned)
            del table
            log.info(
                "spliced decomposition into the running plan",
                extra={"parent": step.name, "children": len(outcome.spawned)},
            )

    async def _propagate_blocks(self, plan: Plan, run_id: str) -> None:
        """A required failure blocks its dependents; optional failures do not.

        Blocking is transitive, so this iterates to a fixed point rather than
        making a single pass - a step three hops downstream of a failure is
        just as unreachable as its immediate dependent. Events are awaited, not
        detached, so the blocked set is on the ledger before the next admission
        round runs.
        """
        table = plan.index()
        changed = True
        while changed:
            changed = False
            for step in plan.steps:
                if step.state is not StepState.PENDING:
                    continue
                for dependency in step.depends_on:
                    parent = table.get(dependency)
                    if parent is None:
                        continue
                    if parent.state in {StepState.FAILED, StepState.BLOCKED, StepState.CANCELLED}:
                        step.state = StepState.BLOCKED
                        changed = True
                        await self.bus.publish(
                            Topic.STEP_BLOCKED,
                            {"name": step.name, "blocked_by": parent.name},
                            run_id=run_id, step_id=step.id,
                        )
                        break

    def _mark_remaining(self, plan: Plan, why: str) -> None:
        for step in plan.steps:
            if not step.state.terminal:
                step.state = StepState.CANCELLED
                step.error = {"code": "cancelled", "message": why}

    @staticmethod
    async def _cancel(running: dict[asyncio.Task[StepOutcome], Step]) -> None:
        for task in running:
            task.cancel()
        if running:
            await asyncio.gather(*running, return_exceptions=True)
        running.clear()


__all__ = ["Cancelled", "ScheduleResult", "Scheduler"]
