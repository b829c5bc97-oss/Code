"""Kernel behaviour: scheduling, recovery, verification, blast radius, budgets.

This is the control plane under adversarial conditions - flaky tools, broken
tools, denied approvals, exhausted budgets - driven by a manual clock so multi
minute backoff schedules run in microseconds.
"""

from __future__ import annotations

import asyncio

import pytest
from conftest import AlwaysFailsTool, FlakyTool, RecordingTool, make_plan, step

from aios.cognition.plan import Check, Step, StepState
from aios.cognition.recovery import Action, RecoveryEngine
from aios.cognition.verifier import Verifier
from aios.kernel.executor import StepExecutor
from aios.kernel.scheduler import Scheduler
from aios.runtime.artifacts import ArtifactStore
from aios.runtime.budget import Budget
from aios.security.approvals import ApprovalGate, AutoApprove, DenyAll
from aios.security.capabilities import CapabilitySet
from aios.security.policy import PolicyEngine
from aios.security.sandbox import PathJail
from aios.tools.base import ToolContext


@pytest.fixture
def harness(config, registry, bus, clock):
    """A fully wired executor + scheduler over the fake tool registry."""

    def build(*, approvals=None, grant=None, model=None, max_parallel=4):
        grant = grant or CapabilitySet.all()
        jail = PathJail(config.workspace_root)
        artifacts = ArtifactStore(config.blobs_dir)
        budget = Budget(limits=config.budget, clock=clock)
        budget.start()

        def context_factory(step_obj: Step) -> ToolContext:
            return ToolContext(
                config=config, jail=jail, artifacts=artifacts, bus=bus, budget=budget,
                scratch=config.state_dir / "scratch", run_id="run_test",
                step_id=step_obj.id, clock=clock,
            )

        executor = StepExecutor(
            registry=registry,
            policy=PolicyEngine(config.security, grant, jail),
            gate=ApprovalGate(approvals or AutoApprove()),
            verifier=Verifier(bus),
            recovery=RecoveryEngine(registry, config.execution, model=model, grant=grant),
            bus=bus,
            config=config,
            clock=clock,
            context_factory=context_factory,
        )
        scheduler = Scheduler(executor, bus, budget, clock, max_parallel=max_parallel)
        return executor, scheduler, budget

    return build


class TestScheduling:
    async def test_independent_steps_run_concurrently(self, harness, tools, config):
        config.execution.max_parallel = 4
        _, scheduler, _ = harness(max_parallel=4)
        plan = make_plan(*[step(f"s{i}", sleep=0.02) for i in range(4)])
        result = await scheduler.run(plan, run_id="run_test")
        assert result.ok
        assert tools["record"].max_concurrent >= 2, "independent steps must overlap"

    async def test_parallelism_respects_the_limit(self, harness, tools):
        _, scheduler, _ = harness(max_parallel=2)
        plan = make_plan(*[step(f"s{i}", sleep=0.02) for i in range(6)])
        await scheduler.run(plan, run_id="run_test")
        assert tools["record"].max_concurrent <= 2

    async def test_dependencies_are_honoured(self, harness, tools):
        _, scheduler, _ = harness()
        plan = make_plan(
            step("first", value="1"),
            step("second", value="2", depends_on=["first"]),
            step("third", value="3", depends_on=["second"]),
        )
        result = await scheduler.run(plan, run_id="run_test")
        assert result.ok
        assert [c["value"] for c in tools["record"].calls] == ["1", "2", "3"]

    async def test_step_outputs_bind_into_later_steps(self, harness, tools):
        _, scheduler, _ = harness()
        plan = make_plan(
            step("produce", value="hello"),
            step("consume", value="${produce.value}-world", depends_on=["produce"]),
        )
        result = await scheduler.run(plan, run_id="run_test")
        assert result.ok
        assert tools["record"].calls[-1]["value"] == "hello-world"

    async def test_failure_blocks_only_its_dependents(self, harness, tools):
        _, scheduler, _ = harness()
        plan = make_plan(
            step("bad", tool="test.broken"),
            step("downstream", depends_on=["bad"]),
            step("independent", value="still runs"),
        )
        result = await scheduler.run(plan, run_id="run_test")
        assert not result.ok
        assert plan.by_id("downstream").state is StepState.BLOCKED
        assert plan.by_id("independent").state is StepState.SUCCEEDED
        assert "still runs" in [c.get("value") for c in tools["record"].calls]

    async def test_optional_failure_does_not_fail_the_run(self, harness):
        _, scheduler, _ = harness()
        bad = step("bad", tool="test.broken")
        bad.optional = True
        plan = make_plan(bad, step("good"))
        result = await scheduler.run(plan, run_id="run_test")
        assert result.ok

    async def test_unsatisfiable_graph_is_reported_not_hung(self, harness):
        _, scheduler, _ = harness()
        blocked = step("blocked", depends_on=["missing"])
        plan = make_plan(step("normal"), blocked)
        # Point at a step id that will never complete.
        blocked.depends_on = ["stp_never_exists"]
        result = await asyncio.wait_for(scheduler.run(plan, run_id="run_test"), timeout=5)
        assert result.ok or result.stopped_reason


class TestRecovery:
    async def test_transient_failure_is_retried_to_success(self, harness, tools):
        _, scheduler, _ = harness()
        plan = make_plan(step("flaky", tool="test.flaky", fail_times=2))
        result = await scheduler.run(plan, run_id="run_test")
        assert result.ok
        assert tools["flaky"].attempts == 3
        assert plan.by_id("flaky").attempts == 3

    async def test_backoff_grows_between_retries(self, harness, clock, tools):
        _, scheduler, _ = harness()
        plan = make_plan(step("flaky", tool="test.flaky", fail_times=2))
        await scheduler.run(plan, run_id="run_test")
        assert len(clock.slept) >= 2
        assert clock.slept[1] >= clock.slept[0], "backoff must not shrink"

    async def test_retries_are_bounded(self, harness, config, tools):
        config.execution.max_attempts = 2
        _, scheduler, _ = harness()
        plan = make_plan(step("flaky", tool="test.flaky", fail_times=99))
        result = await scheduler.run(plan, run_id="run_test")
        assert not result.ok
        assert tools["flaky"].attempts <= 4, "attempts must stay bounded"

    async def test_permanent_failure_stops_without_thrash(self, harness, recorder):
        _, scheduler, _ = harness()
        plan = make_plan(step("bad", tool="test.broken"))
        result = await scheduler.run(plan, run_id="run_test")
        assert not result.ok
        assert recorder.of("recovery.exhausted"), "exhaustion must be announced"

    async def test_optional_step_is_skipped_rather_than_failed(self, harness):
        _, scheduler, _ = harness()
        bad = step("bad", tool="test.broken")
        bad.optional = True
        plan = make_plan(bad)
        result = await scheduler.run(plan, run_id="run_test")
        assert plan.by_id("bad").state is StepState.SKIPPED
        assert result.ok

    async def test_recovery_history_prevents_repeating_a_strategy(self, config, registry):
        engine = RecoveryEngine(registry, config.execution)
        from aios.foundation.errors import TransientError

        target = step("flaky", tool="test.flaky")
        seen = []
        for _ in range(6):
            decision = await engine.decide(target, TransientError("boom"), make_plan(target))
            seen.append(decision.action)
            engine.record(target, _attempt(decision.action, target.tool))
        assert seen.count(Action.RETRY) <= config.execution.max_attempts

    async def test_sandbox_violations_are_never_retried(self, config, registry):
        from aios.foundation.errors import SandboxViolation

        engine = RecoveryEngine(registry, config.execution)
        target = step("escape")
        decision = await engine.decide(
            target, SandboxViolation("tried to escape"), make_plan(target)
        )
        assert decision.action == Action.ABORT

    async def test_mechanical_repair_drops_unknown_arguments(self, config, registry):
        from aios.foundation.errors import InvalidArguments

        engine = RecoveryEngine(registry, config.execution)
        target = step("bad-args", tool="test.record", value="x")
        target.arguments["bogus"] = 1
        error = InvalidArguments(
            "invalid", context={"errors": ["$: unexpected property bogus; allowed: value, sleep"]}
        )
        decision = await engine.decide(target, error, make_plan(target))
        assert decision.action == Action.REPAIR
        assert "bogus" not in (decision.arguments or {})


class TestVerification:
    async def test_missing_file_fails_the_step(self, harness):
        _, scheduler, _ = harness()
        target = step("write")
        target.verify = [Check("file_exists", "never-created.txt")]
        plan = make_plan(target)
        result = await scheduler.run(plan, run_id="run_test")
        assert not result.ok

    async def test_existing_file_passes(self, harness, config):
        (config.workspace_root / "made.txt").write_text("content", encoding="utf-8")
        _, scheduler, _ = harness()
        target = step("write")
        target.verify = [Check("file_exists", "made.txt"),
                         Check("file_contains", "made.txt", expect="content")]
        result = await scheduler.run(make_plan(target), run_id="run_test")
        assert result.ok

    async def test_empty_file_is_not_a_success(self, harness, config):
        (config.workspace_root / "empty.txt").write_text("", encoding="utf-8")
        _, scheduler, _ = harness()
        target = step("write")
        target.verify = [Check("file_exists", "empty.txt")]
        result = await scheduler.run(make_plan(target), run_id="run_test")
        assert not result.ok, "an empty file must not count as a produced deliverable"

    async def test_regex_content_check(self, harness, config):
        (config.workspace_root / "page.html").write_text("<title>Hi</title>", encoding="utf-8")
        _, scheduler, _ = harness()
        target = step("write")
        target.verify = [Check("file_contains", "page.html", expect="/<title>.+<\\/title>/")]
        assert (await scheduler.run(make_plan(target), run_id="run_test")).ok

    async def test_output_contains_check(self, harness):
        _, scheduler, _ = harness()
        target = step("emit", value="the-answer")
        target.verify = [Check("output_contains", expect="the-answer")]
        assert (await scheduler.run(make_plan(target), run_id="run_test")).ok

    async def test_verification_failure_is_retried_once(self, harness, recorder):
        _, scheduler, _ = harness()
        target = step("write")
        target.verify = [Check("file_exists", "nope.txt")]
        await scheduler.run(make_plan(target), run_id="run_test")
        assert target.attempts >= 2, "a failed contract should get one clean retry"

    async def test_verify_events_are_published(self, harness, recorder, config):
        (config.workspace_root / "ok.txt").write_text("x", encoding="utf-8")
        _, scheduler, _ = harness()
        target = step("write")
        target.verify = [Check("file_exists", "ok.txt")]
        await scheduler.run(make_plan(target), run_id="run_test")
        assert recorder.of("verify.passed")


class TestSecurityInExecution:
    async def test_denied_approval_stops_the_action(self, harness, tools):
        _, scheduler, _ = harness(approvals=DenyAll(), grant=CapabilitySet.all())
        plan = make_plan(step("publish", tool="test.dangerous"))
        result = await scheduler.run(plan, run_id="run_test")
        assert not result.ok
        assert not tools["dangerous"].ran, "a denied action must never execute"

    async def test_ungranted_capability_blocks_before_execution(self, harness, tools):
        _, scheduler, _ = harness(grant=CapabilitySet.standard())
        plan = make_plan(step("publish", tool="test.dangerous"))
        result = await scheduler.run(plan, run_id="run_test")
        assert not result.ok
        assert not tools["dangerous"].ran

    async def test_approval_events_are_auditable(self, harness, recorder):
        _, scheduler, _ = harness(approvals=AutoApprove(), grant=CapabilitySet.all())
        await scheduler.run(make_plan(step("publish", tool="test.dangerous")),
                            run_id="run_test")
        assert recorder.of("approval.requested") and recorder.of("approval.granted")


class TestBudgets:
    async def test_step_ceiling_halts_the_run(self, harness, config):
        config.budget.max_steps = 2
        _, scheduler, _ = harness()
        plan = make_plan(*[step(f"s{i}") for i in range(6)])
        result = await scheduler.run(plan, run_id="run_test")
        assert not result.ok
        assert "max_steps" in result.stopped_reason

    async def test_budget_warning_fires_before_the_ceiling(self, harness, config, recorder):
        config.budget.max_steps = 5
        _, scheduler, _ = harness(max_parallel=1)
        plan = make_plan(*[step(f"s{i}") for i in range(4)])
        await scheduler.run(plan, run_id="run_test")
        assert recorder.of("budget.warning")

    async def test_remaining_steps_are_cancelled_not_left_pending(self, harness, config):
        config.budget.max_steps = 1
        _, scheduler, _ = harness(max_parallel=1)
        plan = make_plan(*[step(f"s{i}") for i in range(4)])
        await scheduler.run(plan, run_id="run_test")
        assert all(s.state.terminal for s in plan.steps)


class TestEventStream:
    async def test_a_run_emits_a_complete_lifecycle(self, harness, recorder):
        _, scheduler, _ = harness()
        await scheduler.run(make_plan(step("a"), step("b", depends_on=["a"])),
                            run_id="run_test")
        topics = set(recorder.topics())
        assert {"step.queued", "step.started", "step.succeeded",
                "tool.invoked", "tool.returned"} <= topics

    async def test_events_are_ordered_and_sequenced(self, recorder, harness):
        _, scheduler, _ = harness()
        await scheduler.run(make_plan(step("a")), run_id="run_test")
        sequence = [e.seq for e in recorder.events]
        assert sequence == sorted(sequence)

    async def test_a_failing_subscriber_cannot_break_a_run(self, bus, harness):
        def explode(event):
            raise RuntimeError("subscriber is broken")

        bus.subscribe("*", explode)
        _, scheduler, _ = harness()
        result = await scheduler.run(make_plan(step("a")), run_id="run_test")
        assert result.ok


class TestCancellation:
    async def test_cancelling_a_run_unwinds_cleanly(self, harness):
        _, scheduler, _ = harness(max_parallel=2)
        plan = make_plan(*[step(f"s{i}", sleep=5) for i in range(4)])
        task = asyncio.create_task(scheduler.run(plan, run_id="run_test"))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert all(s.state.terminal for s in plan.steps)


def _attempt(action: str, tool: str):
    from aios.cognition.recovery import Attempt

    return Attempt(action=action, tool=tool, error_code="transient_error")


def test_fixtures_are_wired():
    assert RecordingTool().name and FlakyTool().name and AlwaysFailsTool().name
