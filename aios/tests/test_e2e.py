"""End-to-end kernel runs.

Full pipeline - understand, plan, execute, verify, recover, replan, report -
driven by a scripted model so the whole control plane is exercised
deterministically, offline, in milliseconds.
"""

from __future__ import annotations

import json

import pytest
from conftest import scripted

from aios.cognition.plan import Plan, Step
from aios.interfaces import report as report_module
from aios.kernel.kernel import Kernel
from aios.memory.store import MemoryStore
from aios.model.providers.deterministic import ScriptedProvider
from aios.runtime.events import Recorder
from aios.runtime.ledger import Ledger
from aios.security.approvals import AutoApprove, DenyAll
from aios.security.capabilities import CapabilitySet
from aios.tools import default_registry


def intent_payload(**overrides):
    base = {
        "restated": "Create a project README describing the tool",
        "domain": "document",
        "complexity": "simple",
        "deliverables": ["README.md"],
        "success_criteria": ["README.md exists and mentions Installation"],
        "constraints": [],
        "open_questions": [],
        "assumptions": [],
        "sensitive_actions": [],
    }
    return {**base, **overrides}


def plan_payload(steps, **overrides):
    return {"strategy": "write the file, then confirm it", "steps": steps, **overrides}


WRITE_README = {
    "id": "write_readme",
    "name": "Write the README",
    "tool": "fs.write",
    "arguments": {
        "path": "README.md",
        "content": "# Tool\n\n## Installation\n\npip install tool\n",
    },
    "verify": [
        {"kind": "file_exists", "target": "README.md"},
        {"kind": "file_contains", "target": "README.md", "expect": "Installation"},
    ],
}


@pytest.fixture
def kernel_for(config, bus):
    def build(*responses, approvals=None, grant=None, registry=None, memory=None):
        provider = ScriptedProvider([json.dumps(r) if isinstance(r, dict) else r
                                     for r in responses])
        from aios.model.client import ModelClient

        model = ModelClient([provider], config.model, bus=bus)
        from aios.memory.store import NullMemory

        return Kernel(
            config,
            registry=registry or default_registry(),
            model=model,
            memory=memory if memory is not None else NullMemory(),
            bus=bus,
            approvals=approvals or AutoApprove(),
            grant=grant or CapabilitySet.standard(),
        )

    return build


class TestHappyPath:
    async def test_a_full_run_produces_verified_deliverables(self, kernel_for, config, recorder):
        kernel = kernel_for(intent_payload(), plan_payload([WRITE_README]))
        result = await kernel.run("write a README for this project")

        assert result.status == "succeeded"
        assert (config.workspace_root / "README.md").exists()
        assert "Installation" in (config.workspace_root / "README.md").read_text()
        assert result.plan.origin == "model"
        assert any(a.name == "README.md" for a in result.artifacts)

    async def test_lifecycle_events_are_complete(self, kernel_for, recorder):
        kernel = kernel_for(intent_payload(), plan_payload([WRITE_README]))
        await kernel.run("write a README")
        topics = set(recorder.topics())
        assert {"run.started", "run.understood", "run.planned", "step.started",
                "step.succeeded", "verify.passed", "run.completed"} <= topics

    async def test_the_ledger_records_the_whole_run(self, kernel_for, config):
        kernel = kernel_for(intent_payload(), plan_payload([WRITE_README]))
        result = await kernel.run("write a README")
        events = list(Ledger.read(result.ledger_path))
        assert len(events) > 8
        assert any(e.topic == "run.finalized" for e in events)

    async def test_parallel_steps_share_no_state(self, kernel_for, config):
        steps = [
            {"id": f"w{i}", "name": f"Write file {i}", "tool": "fs.write",
             "arguments": {"path": f"out/file{i}.txt", "content": f"content {i}"},
             "verify": [{"kind": "file_exists", "target": f"out/file{i}.txt"}]}
            for i in range(4)
        ]
        kernel = kernel_for(intent_payload(deliverables=["out/"]), plan_payload(steps))
        result = await kernel.run("write four files")
        assert result.status == "succeeded"
        for i in range(4):
            assert (config.workspace_root / "out" / f"file{i}.txt").read_text() == f"content {i}"

    async def test_step_outputs_flow_into_later_steps(self, kernel_for, config):
        steps = [
            {"id": "make", "name": "Create the source", "tool": "fs.write",
             "arguments": {"path": "source.txt", "content": "payload"}},
            {"id": "copy", "name": "Copy it", "tool": "fs.copy",
             "arguments": {"source": "${make.path}", "destination": "copy.txt"},
             "depends_on": ["make"],
             "verify": [{"kind": "file_exists", "target": "copy.txt"}]},
        ]
        kernel = kernel_for(intent_payload(), plan_payload(steps))
        result = await kernel.run("create and copy a file")
        assert result.status == "succeeded"
        assert (config.workspace_root / "copy.txt").read_text() == "payload"


class TestGrounding:
    async def test_invented_tools_are_rejected_and_repaired(self, kernel_for, config):
        bad = dict(WRITE_README, tool="fs.write_file_now")
        kernel = kernel_for(
            intent_payload(),
            plan_payload([bad]),            # references a tool that does not exist
            plan_payload([WRITE_README]),   # repaired after being told
        )
        result = await kernel.run("write a README")
        assert result.status == "succeeded"
        assert (config.workspace_root / "README.md").exists()

    async def test_repair_prompt_names_the_missing_tool(self, config, bus):
        provider = ScriptedProvider(
            [json.dumps(intent_payload()),
             json.dumps(plan_payload([dict(WRITE_README, tool="fs.wrte")])),
             json.dumps(plan_payload([WRITE_README]))]
        )
        from aios.memory.store import NullMemory
        from aios.model.client import ModelClient

        kernel = Kernel(config, model=ModelClient([provider], config.model), bus=bus,
                        memory=NullMemory(), approvals=AutoApprove())
        await kernel.run("write a README")
        repair_prompt = provider.requests[-1].messages[0].content
        assert "fs.wrte" in repair_prompt and "fs.write" in repair_prompt

    async def test_plans_needing_ungranted_capabilities_are_rejected(self, kernel_for, config):
        push = {"id": "push", "name": "Publish", "tool": "git.push", "arguments": {}}
        kernel = kernel_for(
            intent_payload(),
            plan_payload([push]),
            plan_payload([WRITE_README]),
            grant=CapabilitySet.standard(),  # no `publish`
        )
        result = await kernel.run("publish the work")
        assert result.status == "succeeded"
        assert all(s.tool != "git.push" for s in result.plan.steps)

    async def test_a_hopeless_plan_falls_back_to_heuristics(self, kernel_for, config):
        bad = plan_payload([dict(WRITE_README, tool="not.a.tool")])
        kernel = kernel_for(intent_payload(), bad, bad, bad)
        result = await kernel.run("write a README")
        assert result.plan.origin == "heuristic"
        assert result.status in {"succeeded", "partial"}


class TestFailureHandling:
    async def test_partial_success_is_labelled_partial(self, kernel_for, config):
        steps = [
            WRITE_README,
            {"id": "boom", "name": "Read a missing file", "tool": "fs.read",
             "arguments": {"path": "does-not-exist.txt"}},
        ]
        kernel = kernel_for(intent_payload(), plan_payload(steps))
        result = await kernel.run("do two things, one impossible")
        assert result.status == "partial"
        assert (config.workspace_root / "README.md").exists()
        assert "What did not work" in result.summary

    async def test_summary_names_the_failing_step(self, kernel_for):
        steps = [{"id": "boom", "name": "Read a missing file", "tool": "fs.read",
                  "arguments": {"path": "ghost.txt"}}]
        kernel = kernel_for(intent_payload(), plan_payload(steps),
                            *[plan_payload([]) for _ in range(4)])
        result = await kernel.run("read a missing file")
        assert result.status == "failed"
        assert "Read a missing file" in result.summary

    async def test_replanning_routes_around_a_failure(self, config, bus):
        """The first plan cannot work; the kernel must find another route.

        Driven by a request-aware brain rather than a flat script, because the
        recovery engine legitimately makes its own model calls (argument
        repair) in between - and a positional script would make the test
        sensitive to how many of those happen.
        """
        broken = [{"id": "boom", "name": "Impossible read", "tool": "fs.read",
                   "arguments": {"path": "ghost.txt"}}]
        state = {"plans": 0}

        def brain(request):
            from aios.model.types import Completion

            system = request.system or ""
            if "restated" in system:
                return Completion(text=json.dumps(intent_payload()))
            if '"steps"' in system:
                state["plans"] += 1
                payload = plan_payload(broken if state["plans"] == 1 else [WRITE_README])
                return Completion(text=json.dumps(payload))
            # Argument repair for the failing read: no useful fix exists.
            return Completion(text=json.dumps({"path": "ghost.txt"}))

        from aios.memory.store import NullMemory
        from aios.model.client import ModelClient

        provider = ScriptedProvider([brain] * 30)
        kernel = Kernel(config, model=ModelClient([provider], config.model), bus=bus,
                        memory=NullMemory(), approvals=AutoApprove())
        result = await kernel.run("produce a README somehow")
        assert result.replans >= 1
        assert (config.workspace_root / "README.md").exists()

    async def test_replanning_is_bounded(self, kernel_for, config):
        broken = plan_payload([{"id": "boom", "name": "Impossible", "tool": "fs.read",
                                "arguments": {"path": "ghost.txt"}}])
        kernel = kernel_for(intent_payload(), *[broken for _ in range(8)])
        result = await kernel.run("keep failing")
        assert result.replans <= config.execution.replan_limit

    async def test_a_run_always_returns_a_result(self, kernel_for):
        kernel = kernel_for("this is not json at all", "still not json", "nope", "no")
        result = await kernel.run("something")
        assert result.run_id and result.status in {"succeeded", "partial", "failed"}
        assert result.budget


class TestSecurityEndToEnd:
    async def test_sandbox_escape_in_a_plan_is_blocked(self, kernel_for, config, tmp_path):
        escape = {"id": "escape", "name": "Write outside the workspace", "tool": "fs.write",
                  "arguments": {"path": "../../escaped.txt", "content": "leaked"}}
        kernel = kernel_for(intent_payload(), plan_payload([escape]),
                            *[plan_payload([]) for _ in range(4)])
        result = await kernel.run("write outside")
        assert result.status == "failed"
        assert not (tmp_path / "escaped.txt").exists()

    async def test_denied_approval_prevents_the_action(self, kernel_for, config, recorder):
        delete = {"id": "rm", "name": "Delete the file", "tool": "fs.delete",
                  "arguments": {"path": "keep.txt"}}
        (config.workspace_root / "keep.txt").write_text("precious", encoding="utf-8")
        kernel = kernel_for(intent_payload(), plan_payload([delete]),
                                            approvals=DenyAll())
        result = await kernel.run("delete the file")
        assert result.status == "failed"
        assert (config.workspace_root / "keep.txt").read_text() == "precious"
        assert recorder.of("approval.denied")

    async def test_dry_run_changes_nothing(self, kernel_for, config):
        kernel = kernel_for(intent_payload(), plan_payload([WRITE_README]))
        result = await kernel.run("write a README", dry_run=True)
        assert not (config.workspace_root / "README.md").exists()
        assert result.status in {"succeeded", "partial"}

    async def test_secrets_in_arguments_never_reach_the_ledger(self, kernel_for, config):
        leaky = {"id": "w", "name": "Write config", "tool": "fs.write",
                 "arguments": {"path": "config.env",
                               "content": "API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123"}}
        kernel = kernel_for(intent_payload(), plan_payload([leaky]))
        result = await kernel.run("write a config file")
        ledger_text = "".join(
            json.dumps(e.to_dict()) for e in Ledger.read(result.ledger_path)
        )
        assert "abcdefghijklmnopqrstuvwxyz0123" not in ledger_text


class TestBudgetsEndToEnd:
    async def test_a_cost_ceiling_stops_the_run(self, kernel_for, config):
        config.budget.max_steps = 1
        steps = [
            {"id": f"w{i}", "name": f"Write {i}", "tool": "fs.write",
             "arguments": {"path": f"f{i}.txt", "content": "x"}}
            for i in range(5)
        ]
        kernel = kernel_for(intent_payload(), plan_payload(steps),
                            *[plan_payload([]) for _ in range(4)])
        result = await kernel.run("write five files")
        assert result.status in {"partial", "failed"}
        assert result.budget["used"]["steps"] <= 2

    async def test_budget_is_always_reported(self, kernel_for):
        kernel = kernel_for(intent_payload(), plan_payload([WRITE_README]))
        result = await kernel.run("write a README")
        assert result.budget["used"]["model_calls"] >= 2
        assert "limits" in result.budget


class TestMemoryIntegration:
    async def test_runs_and_lessons_are_remembered(self, config, bus, tmp_path):
        store = MemoryStore(tmp_path / "memory.db")
        provider = ScriptedProvider([
            json.dumps(intent_payload()),
            json.dumps(plan_payload([WRITE_README])),
        ])
        from aios.model.client import ModelClient

        kernel = Kernel(config, model=ModelClient([provider], config.model), bus=bus,
                        memory=store, approvals=AutoApprove())
        result = await kernel.run("write a README")
        assert store.recent_runs()[0]["run_id"] == result.run_id
        assert store.recall("README")
        store.close()

    async def test_failures_become_lessons(self, config, bus, tmp_path):
        store = MemoryStore(tmp_path / "memory.db")
        provider = ScriptedProvider(
            [json.dumps(intent_payload()),
             json.dumps(plan_payload([{"id": "b", "name": "Bad read", "tool": "fs.read",
                                       "arguments": {"path": "ghost.txt"}}]))]
        )
        from aios.model.client import ModelClient

        kernel = Kernel(config, model=ModelClient([provider], config.model), bus=bus,
                        memory=store, approvals=AutoApprove())
        await kernel.run("read a missing file")
        assert any(m.kind == "lesson" for m in store.recall("fs.read failed"))
        store.close()


class TestReporting:
    async def test_reports_are_written_in_three_formats(self, kernel_for, tmp_path):
        kernel = kernel_for(intent_payload(), plan_payload([WRITE_README]))
        result = await kernel.run("write a README")
        paths = report_module.write(result, tmp_path / "reports")
        from pathlib import Path

        assert all(Path(p).exists() for p in paths.values())
        assert "<html" in Path(paths["html"]).read_text()
        assert json.loads(Path(paths["json"]).read_text())["status"] == "succeeded"

    async def test_a_failure_report_leads_with_the_failure(self, kernel_for, tmp_path):
        kernel = kernel_for(
            intent_payload(),
            plan_payload([{"id": "b", "name": "Bad read", "tool": "fs.read",
                           "arguments": {"path": "ghost.txt"}}]),
        )
        result = await kernel.run("read a missing file")
        markdown = report_module.to_markdown(result)
        assert "What did not work" in markdown
        assert "Bad read" in markdown

    async def test_replay_reconstructs_the_run_from_the_ledger(self, kernel_for):
        kernel = kernel_for(intent_payload(), plan_payload([WRITE_README]))
        result = await kernel.run("write a README")
        summary = report_module.replay_summary(result.ledger_path)
        assert summary["run_id"] == result.run_id
        assert any(s["state"] == "succeeded" for s in summary["steps"])


class TestSuppliedPlan:
    async def test_a_hand_written_plan_can_be_executed_directly(self, kernel_for, config):
        plan = Plan(
            goal="write a file",
            steps=[Step(name="Write it", tool="fs.write", binding="w",
                        arguments={"path": "manual.txt", "content": "by hand"})],
        )
        kernel = kernel_for(intent_payload())
        result = await kernel.run("write a file", plan=plan)
        assert result.status == "succeeded"
        assert (config.workspace_root / "manual.txt").read_text() == "by hand"


class TestOfflineOperation:
    async def test_the_os_runs_with_no_model_at_all(self, config, bus):
        from aios.foundation.config import ModelConfig
        from aios.memory.store import NullMemory
        from aios.model.client import ModelClient
        from aios.model.providers.deterministic import OfflineProvider

        kernel = Kernel(
            config,
            model=ModelClient([OfflineProvider()], ModelConfig()),
            memory=NullMemory(),
            bus=bus,
            approvals=AutoApprove(),
        )
        result = await kernel.run("organise this workspace and report on storage")
        assert result.plan.origin == "heuristic"
        assert result.status in {"succeeded", "partial"}
        assert result.budget["used"]["model_calls"] == 0, "heuristics must not call the model"


def test_scripted_helper_is_available():
    assert scripted("x") is not None


def test_recorder_helper_is_available(bus):
    assert Recorder(bus) is not None
