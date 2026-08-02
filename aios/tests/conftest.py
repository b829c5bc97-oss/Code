from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from aios.cognition.plan import Check, Plan, Step
from aios.foundation.clock import ManualClock
from aios.foundation.config import Config
from aios.model.client import ModelClient
from aios.model.providers.deterministic import ScriptedProvider
from aios.model.types import Completion
from aios.runtime.artifacts import ArtifactStore
from aios.runtime.budget import Budget
from aios.runtime.events import EventBus, Recorder
from aios.security.approvals import AutoApprove, DenyAll
from aios.security.capabilities import CapabilitySet, RiskLevel
from aios.tools.base import Tool, ToolContext, ToolResult
from aios.tools.registry import ToolRegistry


@pytest.fixture
def clock() -> ManualClock:
    return ManualClock()


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    root.mkdir()
    return root


@pytest.fixture
def config(workspace: Path) -> Config:
    cfg = Config()
    cfg.workspace.root = str(workspace)
    cfg.memory.enabled = False
    cfg.security.approval_mode = "auto"
    cfg.execution.backoff_base_seconds = 0.01
    cfg.model.cache_enabled = False
    cfg.ensure_dirs()
    return cfg


@pytest.fixture
def bus() -> EventBus:
    return EventBus()


@pytest.fixture
def recorder(bus: EventBus) -> Recorder:
    return Recorder(bus)


def scripted(*responses: Any) -> ModelClient:
    """A model client backed by a fixed script of completions."""
    provider = ScriptedProvider(
        [r if isinstance(r, Completion | str) or callable(r) else json.dumps(r) for r in responses]
    )
    from aios.foundation.config import ModelConfig

    return ModelClient([provider], ModelConfig(cache_enabled=False, max_retries=1))


# --------------------------------------------------------------------------
# Instrumented fake tools - the substrate for kernel-level tests.
# --------------------------------------------------------------------------


class RecordingTool(Tool):
    """Succeeds, recording each invocation. Optionally sleeps to test overlap."""

    name = "test.record"
    summary = "record invocations"
    tags = ("test",)
    capabilities = frozenset()
    risk = RiskLevel.SAFE
    parameters = {
        "type": "object",
        "properties": {"value": {"type": "string", "default": "ok"},
                       "sleep": {"type": "number", "default": 0}},
        "additionalProperties": False,
    }

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.concurrent = 0
        self.max_concurrent = 0

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        self.concurrent += 1
        self.max_concurrent = max(self.max_concurrent, self.concurrent)
        try:
            self.calls.append(dict(args))
            if args.get("sleep"):
                await asyncio.sleep(float(args["sleep"]))
            return ToolResult.success({"value": args.get("value", "ok")},
                                      summary=f"recorded {args.get('value', 'ok')}")
        finally:
            self.concurrent -= 1


class FlakyTool(Tool):
    """Fails `fail_times` times with a retryable error, then succeeds."""

    name = "test.flaky"
    summary = "fail then succeed"
    tags = ("test",)
    capabilities = frozenset()
    risk = RiskLevel.SAFE
    parameters = {
        "type": "object",
        "properties": {"fail_times": {"type": "integer", "default": 2}},
        "additionalProperties": False,
    }

    def __init__(self) -> None:
        self.attempts = 0

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        from aios.foundation.errors import TransientError

        self.attempts += 1
        if self.attempts <= int(args.get("fail_times", 2)):
            raise TransientError(f"transient failure #{self.attempts}")
        return ToolResult.success({"attempts": self.attempts}, summary="recovered")


class AlwaysFailsTool(Tool):
    name = "test.broken"
    summary = "always fails"
    tags = ("test",)
    capabilities = frozenset()
    risk = RiskLevel.SAFE
    parameters = {"type": "object", "properties": {}, "additionalProperties": False}

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        from aios.foundation.errors import ToolExecutionError

        raise ToolExecutionError("this tool is permanently broken")


class DangerousTool(Tool):
    name = "test.dangerous"
    summary = "irreversible action"
    tags = ("test", "danger")
    capabilities = frozenset({"publish"})
    risk = RiskLevel.CRITICAL
    reversible = False
    parameters = {"type": "object", "properties": {}, "additionalProperties": False}

    def __init__(self) -> None:
        self.ran = False

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        self.ran = True
        return ToolResult.success({"published": True}, summary="published")


@pytest.fixture
def tools() -> dict[str, Tool]:
    return {
        "record": RecordingTool(),
        "flaky": FlakyTool(),
        "broken": AlwaysFailsTool(),
        "dangerous": DangerousTool(),
    }


@pytest.fixture
def registry(tools: dict[str, Tool]) -> ToolRegistry:
    reg = ToolRegistry()
    reg.register_all(tools.values(), origin="test")
    return reg


@pytest.fixture
def tool_context(config: Config, bus: EventBus, clock: ManualClock) -> ToolContext:
    from aios.security.sandbox import PathJail

    return ToolContext(
        config=config,
        jail=PathJail(config.workspace_root),
        artifacts=ArtifactStore(config.blobs_dir),
        bus=bus,
        budget=Budget(limits=config.budget, clock=clock),
        scratch=config.state_dir / "scratch",
        run_id="run_test",
        step_id="stp_test",
        clock=clock,
    )


def make_plan(*steps: Step, goal: str = "test goal") -> Plan:
    plan = Plan(goal=goal, steps=list(steps))
    return plan.normalize()


def step(
    name: str,
    tool: str = "test.record",
    *,
    binding: str = "",
    depends_on: list[str] | None = None,
    **arguments: Any,
) -> Step:
    verify = arguments.pop("verify", None)
    return Step(
        name=name,
        tool=tool,
        binding=binding or name,
        arguments=arguments,
        depends_on=depends_on or [],
        verify=verify or [Check("no_error")],
    )


__all__ = [
    "AlwaysFailsTool",
    "AutoApprove",
    "CapabilitySet",
    "DangerousTool",
    "DenyAll",
    "FlakyTool",
    "RecordingTool",
    "make_plan",
    "scripted",
    "step",
]
