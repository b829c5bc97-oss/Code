"""The kernel: the OS loop.

Assembles every subsystem into the pipeline the whole product is built around:

    understand → plan → execute (parallel, verified, self-healing)
      → replan if needed → summarise → remember

Design decisions that matter here:

- **Nothing is a singleton.** Registry, model, memory, policy, approvals and
  clock are all injected, so a test constructs a kernel with a scripted model
  and a manual clock and drives a full run in milliseconds.
- **Replanning is bounded and additive.** When required steps fail, the kernel
  re-plans with the failure evidence in hand and executes only the new work,
  keeping everything that already succeeded. It gives up after
  ``execution.replan_limit`` rounds rather than looping forever.
- **The run always produces an account of itself**, including when it fails: a
  ledger, a report artifact and an honest status. A run that half-worked says
  so and names exactly which deliverables exist.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..cognition.intent import Intent, IntentResolver
from ..cognition.plan import Plan, Step, StepState
from ..cognition.planner import Planner
from ..cognition.recovery import RecoveryEngine
from ..cognition.verifier import Verifier
from ..foundation.clock import SYSTEM_CLOCK, Clock
from ..foundation.config import Config
from ..foundation.errors import Cancelled, classify
from ..foundation.ids import run_id as new_run_id
from ..foundation.logging import get_logger, log_context
from ..memory.store import MemoryStore, NullMemory
from ..model.client import ModelClient
from ..runtime.artifacts import Artifact, ArtifactStore
from ..runtime.budget import Budget
from ..runtime.events import EventBus, Topic
from ..runtime.ledger import Ledger, NullLedger
from ..security.approvals import ApprovalBroker, ApprovalGate, build_broker
from ..security.capabilities import CapabilitySet
from ..security.policy import PolicyEngine
from ..security.sandbox import PathJail
from ..tools.base import ToolContext
from ..tools.registry import ToolRegistry
from .executor import StepExecutor
from .scheduler import Scheduler, ScheduleResult

log = get_logger("kernel")


@dataclass(slots=True)
class RunResult:
    run_id: str
    goal: str
    status: str  # succeeded | partial | failed | cancelled
    intent: Intent | None = None
    plan: Plan | None = None
    schedule: ScheduleResult | None = None
    artifacts: list[Artifact] = field(default_factory=list)
    budget: dict[str, Any] = field(default_factory=dict)
    duration_s: float = 0.0
    ledger_path: str = ""
    summary: str = ""
    needs_human: list[str] = field(default_factory=list)
    error: dict[str, Any] | None = None
    replans: int = 0

    @property
    def ok(self) -> bool:
        return self.status == "succeeded"

    def deliverables(self) -> list[Artifact]:
        """Artifacts a user would actually care about: files, not scratch."""
        return [a for a in self.artifacts if a.kind in {"file", "directory"}]

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "goal": self.goal,
            "status": self.status,
            "duration_s": round(self.duration_s, 2),
            "replans": self.replans,
            "intent": self.intent.to_dict() if self.intent else None,
            "plan": self.plan.to_dict() if self.plan else None,
            "budget": self.budget,
            "artifacts": [a.to_dict() for a in self.artifacts],
            "needs_human": self.needs_human,
            "summary": self.summary,
            "ledger": self.ledger_path,
            "error": self.error,
        }


class Kernel:
    def __init__(
        self,
        config: Config,
        *,
        registry: ToolRegistry | None = None,
        model: ModelClient | None = None,
        memory: MemoryStore | NullMemory | None = None,
        bus: EventBus | None = None,
        approvals: ApprovalBroker | None = None,
        grant: CapabilitySet | None = None,
        clock: Clock | None = None,
    ) -> None:
        self.config = config
        self.clock = clock or SYSTEM_CLOCK
        self.bus = bus or EventBus(self.clock)
        self.grant = grant or CapabilitySet.standard()

        if registry is None:
            from ..tools import default_registry

            registry = default_registry()
        self.registry = registry

        if model is None:
            from ..model import build_client

            model = build_client(config.model, bus=self.bus, clock=self.clock)
        self.model = model

        if memory is None:
            config.ensure_dirs()
            memory = (
                MemoryStore(config.memory_db, config.memory)
                if config.memory.enabled
                else NullMemory()
            )
        self.memory = memory

        self.jail = PathJail(config.workspace_root)
        self.policy = PolicyEngine(config.security, self.grant, self.jail)
        self.gate = ApprovalGate(approvals or build_broker(config.security.approval_mode))
        self.intent_resolver = IntentResolver(model)
        self.planner = Planner(model, registry)
        self.verifier = Verifier(self.bus)

    # ------------------------------------------------------------------
    async def run(
        self,
        goal: str,
        *,
        dry_run: bool = False,
        plan: Plan | None = None,
        extra_context: str = "",
    ) -> RunResult:
        run_id = new_run_id()
        self.config.ensure_dirs()
        started = self.clock.monotonic()

        ledger: Ledger = (
            NullLedger() if dry_run else Ledger(self.config.runs_dir / f"{run_id}.jsonl")
        )
        ledger.attach(self.bus)

        budget = Budget(limits=self.config.budget, clock=self.clock)
        budget.start()
        self.model.budget = budget
        artifacts = ArtifactStore(self.config.blobs_dir)

        result = RunResult(run_id=run_id, goal=goal, status="failed", ledger_path=str(ledger.path))

        with log_context(run=run_id[-8:]):
            try:
                await self.bus.publish(
                    Topic.RUN_STARTED,
                    {"goal": goal, "workspace": str(self.config.workspace_root),
                     "dry_run": dry_run, "security_mode": self.config.security.mode,
                     "capabilities": sorted(self.grant), "model": self.model.primary.name},
                    run_id=run_id,
                )
                self.memory.start_run(run_id, goal, str(self.config.workspace_root))
                await self._pipeline(
                    goal, run_id, budget, artifacts, result, dry_run, plan, extra_context
                )
            except asyncio.CancelledError:
                result.status = "cancelled"
                result.error = Cancelled("run cancelled by the caller").to_dict()
                await self.bus.publish(Topic.RUN_CANCELLED, {"goal": goal}, run_id=run_id)
                raise
            except Exception as exc:
                error = classify(exc)
                result.status = "failed"
                result.error = error.to_dict()
                result.summary = f"Run failed before completion: {error.message}"
                log.error("run failed", extra={"error": error.code}, exc_info=True)
                await self.bus.publish(
                    Topic.RUN_FAILED, {"goal": goal, "error": error.to_dict()}, run_id=run_id
                )
            finally:
                result.duration_s = self.clock.monotonic() - started
                result.budget = budget.report()
                result.artifacts = artifacts.all()
                self.memory.finish_run(
                    run_id,
                    result.status,
                    steps=len(result.plan.steps) if result.plan else 0,
                    failed=len(result.schedule.failed) if result.schedule else 0,
                    usd=budget.usd,
                    summary=result.summary,
                )
                ledger.record(
                    "run.finalized",
                    {"status": result.status, "duration_s": round(result.duration_s, 2),
                     "budget": result.budget, "artifacts": len(result.artifacts)},
                    run_id=run_id,
                )
                ledger.close()
        return result

    async def _pipeline(
        self,
        goal: str,
        run_id: str,
        budget: Budget,
        artifacts: ArtifactStore,
        result: RunResult,
        dry_run: bool,
        supplied_plan: Plan | None,
        extra_context: str,
    ) -> None:
        # 1. understand -------------------------------------------------
        memory_context = self.memory.context_for(goal, scope=str(self.config.workspace_root))
        context = "\n\n".join(part for part in (memory_context, extra_context) if part)

        intent = await self.intent_resolver.resolve(goal, context=context, run_id=run_id)
        result.intent = intent
        await self.bus.publish(
            Topic.RUN_UNDERSTOOD, {"intent": intent.to_dict()}, run_id=run_id
        )
        log.info("understood goal", extra={"domain": intent.domain,
                                           "complexity": intent.complexity,
                                           "source": intent.source})

        # 2. plan -------------------------------------------------------
        plan = supplied_plan or await self.planner.plan(
            intent, self.grant, context=context, run_id=run_id
        )
        plan.normalize().validate()
        result.plan = plan
        await self.bus.publish(
            Topic.RUN_PLANNED,
            {"plan": plan.to_dict(include_state=False), "steps": len(plan.steps),
             "waves": len(plan.levels()), "origin": plan.origin},
            run_id=run_id,
        )
        artifacts.put_json("plan.json", plan.to_dict(include_state=False))
        log.info("planned", extra={"steps": len(plan.steps), "waves": len(plan.levels()),
                                   "origin": plan.origin})

        # 3. execute (with bounded replanning) --------------------------
        scheduler = self._build_execution(run_id, budget, artifacts, dry_run)
        schedule = await scheduler.run(plan, run_id=run_id)
        result.schedule = schedule

        rounds = 0
        while (
            not schedule.ok
            and not schedule.cancelled
            and rounds < self.config.execution.replan_limit
            and not schedule.stopped_reason
        ):
            rounds += 1
            addition = await self._replan(intent, plan, schedule, run_id, rounds)
            if addition is None:
                break
            result.replans = rounds
            await self.bus.publish(
                Topic.RUN_REPLANNED,
                {"round": rounds, "new_steps": len(addition.steps),
                 "strategy": addition.strategy},
                run_id=run_id,
            )
            for step in addition.steps:
                plan.steps.append(step)
            plan.revision += 1
            plan.normalize()
            schedule = await scheduler.run(plan, run_id=run_id)
            result.schedule = schedule

        # 4. account for the outcome ------------------------------------
        result.needs_human = schedule.needs_human()
        result.status = self._status(schedule)
        result.summary = self._summarize(intent, plan, schedule, artifacts, result.status)
        artifacts.put_text("run-summary.md", result.summary, media_type="text/markdown")

        await self.bus.publish(
            Topic.RUN_COMPLETED if result.status != "failed" else Topic.RUN_FAILED,
            {"status": result.status, "counts": plan.counts(),
             "artifacts": len(artifacts.all()), "budget": budget.snapshot()},
            run_id=run_id,
        )

        # 5. remember ---------------------------------------------------
        self._write_memories(intent, plan, schedule, result)

    def _build_execution(
        self,
        run_id: str,
        budget: Budget,
        artifacts: ArtifactStore,
        dry_run: bool,
    ) -> Scheduler:
        scratch = self.config.state_dir / "scratch" / run_id
        scratch.mkdir(parents=True, exist_ok=True)
        shared_inputs: dict[str, Any] = {}

        def context_factory(step: Step) -> ToolContext:
            deadline = None
            limit = step.timeout_seconds or self.config.execution.step_timeout_seconds
            if limit:
                deadline = self.clock.monotonic() + limit
            return ToolContext(
                config=self.config,
                jail=self.jail,
                artifacts=artifacts,
                bus=self.bus,
                budget=budget,
                scratch=scratch,
                run_id=run_id,
                step_id=step.id,
                inputs=shared_inputs,
                clock=self.clock,
                model=self.model,
                memory=self.memory,
                deadline=deadline,
                dry_run=dry_run,
            )

        recovery = RecoveryEngine(
            self.registry, self.config.execution, model=self.model, grant=self.grant
        )
        executor = StepExecutor(
            registry=self.registry,
            policy=self.policy,
            gate=self.gate,
            verifier=self.verifier,
            recovery=recovery,
            bus=self.bus,
            config=self.config,
            clock=self.clock,
            context_factory=context_factory,
        )
        scheduler = Scheduler(
            executor, self.bus, budget, self.clock,
            max_parallel=self.config.execution.max_parallel,
        )
        return scheduler

    async def _replan(
        self, intent: Intent, plan: Plan, schedule: ScheduleResult, run_id: str, round_number: int
    ) -> Plan | None:
        """Plan around the failures, keeping everything that already worked."""
        failures = [
            f"- {o.step.name} (tool {o.step.tool}) failed: "
            f"{(o.error.message if o.error else 'unknown')[:300]}"
            for o in schedule.failed
        ]
        blocked = [s.name for s in schedule.blocked]
        if not failures:
            return None

        completed = [
            f"- {s.name} → {s.tool}: {str(s.result)[:160]}"
            for s in plan.steps
            if s.state is StepState.SUCCEEDED
        ]
        context = (
            f"Replanning round {round_number}. Keep everything already completed; plan only the "
            f"remaining work.\n\nAlready done:\n" + ("\n".join(completed) or "- nothing") +
            "\n\nFailed:\n" + "\n".join(failures) +
            ("\n\nBlocked by those failures: " + ", ".join(blocked) if blocked else "") +
            "\n\nProduce steps that reach the goal a different way. Do not repeat a failed "
            "approach unchanged."
        )
        log.info("replanning", extra={"round": round_number, "failures": len(failures)})
        try:
            revised = await self.planner.plan(
                intent, self.grant, context=context, run_id=run_id, allow_fallback=False
            )
        except Exception:
            log.warning("replanning produced nothing usable", exc_info=True)
            return None

        existing = {(s.tool, str(s.arguments)) for s in plan.steps}
        fresh = [s for s in revised.steps if (s.tool, str(s.arguments)) not in existing]
        if not fresh:
            log.info("replanning produced no new work; stopping")
            return None
        # New steps must not depend on ids from the discarded plan revision.
        known = {s.binding or s.id for s in fresh}
        for step in fresh:
            step.depends_on = [d for d in step.depends_on if d in known]
        revised.steps = fresh
        return revised

    @staticmethod
    def _status(schedule: ScheduleResult) -> str:
        if schedule.cancelled:
            return "cancelled"
        if schedule.ok:
            return "succeeded"
        produced = [o for o in schedule.outcomes.values() if o.state is StepState.SUCCEEDED]
        return "partial" if produced else "failed"

    def _summarize(
        self,
        intent: Intent,
        plan: Plan,
        schedule: ScheduleResult,
        artifacts: ArtifactStore,
        status: str,
    ) -> str:
        counts = plan.counts()
        lines = [
            f"# {intent.restated or intent.goal}",
            "",
            f"**Status:** {status}",
            "",
            "## What was done",
            "",
        ]
        for step in plan.steps:
            marker = {"succeeded": "x", "skipped": "-", "failed": "!",
                      "blocked": "⊘"}.get(step.state.value, " ")
            detail = ""
            outcome = schedule.outcomes.get(step.id)
            if outcome and outcome.result and outcome.result.summary:
                detail = f" — {outcome.result.summary[:160]}"
            elif step.state is StepState.FAILED and step.error:
                detail = f" — failed: {str(step.error.get('message', ''))[:160]}"
            lines.append(f"- [{marker}] **{step.name}** (`{step.tool}`){detail}")

        deliverables = [a for a in artifacts.all() if a.kind in {"file", "directory"}]
        if deliverables:
            lines += ["", "## Deliverables", ""]
            for artifact in deliverables:
                lines.append(f"- `{artifact.name}` ({artifact.media_type}, {artifact.size} bytes)")

        failed = schedule.failed
        if failed:
            lines += ["", "## What did not work", ""]
            for outcome in failed:
                reason = outcome.error.message if outcome.error else "unknown"
                lines.append(f"- **{outcome.step.name}**: {reason[:300]}")
                if outcome.recoveries:
                    tried = ", ".join(r["action"] for r in outcome.recoveries)
                    lines.append(f"  - recovery attempted: {tried}")

        if schedule.needs_human():
            lines += ["", "## Needs a decision from you", ""]
            lines += [f"- {item}" for item in schedule.needs_human()]

        if intent.assumptions:
            lines += ["", "## Assumptions made", ""]
            lines += [f"- {a}" for a in intent.assumptions]

        lines += [
            "",
            "## Run statistics",
            "",
            f"- Steps: {counts}",
            f"- Replans: {plan.revision}",
        ]
        return "\n".join(lines)

    def _write_memories(
        self, intent: Intent, plan: Plan, schedule: ScheduleResult, result: RunResult
    ) -> None:
        scope = str(self.config.workspace_root)
        self.memory.remember(
            "episode",
            f"Goal: {intent.goal}\nOutcome: {result.status}. "
            f"Steps: {plan.counts()}. Deliverables: "
            f"{', '.join(a.name for a in result.deliverables()[:8]) or 'none'}.",
            scope=scope,
            metadata={"run_id": result.run_id, "domain": intent.domain},
            importance=0.55 if result.status == "succeeded" else 0.7,
        )
        # Failures are the memories worth keeping: they change future plans.
        for outcome in schedule.failed:
            if outcome.error is None:
                continue
            self.memory.remember(
                "lesson",
                f"Tool `{outcome.step.tool}` failed on {intent.domain} work "
                f"({outcome.error.code}): {outcome.error.message[:240]}. "
                f"Recovery tried: {', '.join(r['action'] for r in outcome.recoveries) or 'none'}.",
                scope=scope,
                metadata={"run_id": result.run_id, "tool": outcome.step.tool},
                importance=0.75,
            )

    # ------------------------------------------------------------------
    async def dry_run(self, goal: str) -> RunResult:
        """Plan and simulate without side effects."""
        return await self.run(goal, dry_run=True)

    def close(self) -> None:
        self.memory.close()
        self.bus.close()


def workspace_for(path: str | Path) -> Config:
    """Convenience: a default config rooted at ``path``."""
    config = Config()
    config.workspace.root = str(path)
    config.ensure_dirs()
    return config
