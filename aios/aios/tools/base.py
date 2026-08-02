"""The tool contract.

A tool is the *only* way the OS touches the world. Everything else - planning,
verification, recovery - is pure reasoning over tool results. The contract is
therefore deliberately strict:

- **Declared, not discovered, authority.** ``capabilities``/``risk``/
  ``reversible`` are class attributes, so the policy engine can reason about an
  invocation *before* any code runs.
- **Typed inputs.** ``parameters`` is a JSON Schema; the base class validates
  and coerces before ``execute`` is reached, so tool bodies never defensively
  re-parse arguments.
- **Structured outputs.** A tool returns a :class:`ToolResult`, not a string,
  so the verifier has something to assert on and later steps have something to
  bind to.
- **No raised surprises.** :meth:`Tool.run` funnels every exception through the
  error taxonomy, so the recovery engine always gets a classified failure.
"""

from __future__ import annotations

import asyncio
import inspect
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..foundation.clock import SYSTEM_CLOCK, Clock
from ..foundation.config import Config
from ..foundation.errors import AiosError, InvalidArguments, ToolTimeout, classify
from ..foundation.logging import get_logger
from ..runtime.artifacts import Artifact, ArtifactStore
from ..runtime.budget import Budget
from ..runtime.events import EventBus, Topic
from ..security.capabilities import RiskLevel
from ..security.policy import ActionRequest
from ..security.sandbox import PathJail
from .schema import ValidationError, describe, validate_and_coerce

log = get_logger("tools")

#: Strong references to detached announcement tasks; see ToolContext._announce.
_BACKGROUND: set[asyncio.Task[Any]] = set()


@dataclass(slots=True)
class ToolContext:
    """Everything a tool is allowed to reach. Nothing global, nothing ambient."""

    config: Config
    jail: PathJail
    artifacts: ArtifactStore
    bus: EventBus
    budget: Budget
    scratch: Path
    run_id: str | None = None
    step_id: str | None = None
    inputs: dict[str, Any] = field(default_factory=dict)
    clock: Clock = SYSTEM_CLOCK
    model: Any = None  # ModelClient, for tools that reason
    memory: Any = None  # MemoryStore
    deadline: float | None = None  # monotonic timestamp
    dry_run: bool = False

    @property
    def workspace(self) -> Path:
        return self.jail.root

    def remaining_seconds(self) -> float:
        """Time left for this step - tools use it to size their own timeouts."""
        by_budget = self.budget.remaining_seconds
        if self.deadline is None:
            return by_budget
        return max(0.0, min(by_budget, self.deadline - self.clock.monotonic()))

    async def progress(self, message: str, **data: Any) -> None:
        await self.bus.publish(
            Topic.STEP_PROGRESS,
            {"message": message, **data},
            run_id=self.run_id,
            step_id=self.step_id,
        )

    def keep_file(self, path: str | Path, **kw: Any) -> Artifact:
        artifact = self.artifacts.put_file(path, produced_by=self.step_id, **kw)
        self._announce(artifact)
        return artifact

    def keep_text(self, name: str, text: str, **kw: Any) -> Artifact:
        artifact = self.artifacts.put_text(name, text, produced_by=self.step_id, **kw)
        self._announce(artifact)
        return artifact

    def _announce(self, artifact: Artifact) -> None:
        # Fire-and-forget: announcing an artifact must never block a tool that
        # is mid-render. The task is kept in a module-level set because asyncio
        # only holds a weak reference - an unreferenced task can be collected
        # before it runs, silently dropping the event.
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # pragma: no cover - called from sync context
            return
        task = loop.create_task(
            self.bus.publish(
                Topic.ARTIFACT_CREATED,
                {"id": artifact.id, "name": artifact.name, "kind": artifact.kind,
                 "size": artifact.size, "media_type": artifact.media_type},
                run_id=self.run_id,
                step_id=self.step_id,
            )
        )
        _BACKGROUND.add(task)
        task.add_done_callback(_BACKGROUND.discard)


@dataclass(slots=True)
class ToolResult:
    """The uniform shape every tool returns."""

    ok: bool = True
    output: Any = None
    summary: str = ""
    artifacts: list[Artifact] = field(default_factory=list)
    metrics: dict[str, Any] = field(default_factory=dict)
    error: AiosError | None = None
    logs: list[str] = field(default_factory=list)

    @classmethod
    def success(cls, output: Any = None, summary: str = "", **kw: Any) -> ToolResult:
        return cls(ok=True, output=output, summary=summary, **kw)

    @classmethod
    def failure(cls, error: AiosError, summary: str = "", **kw: Any) -> ToolResult:
        return cls(ok=False, error=error, summary=summary or error.message, **kw)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "summary": self.summary,
            "output": self.output,
            "artifacts": [
                {"id": a.id, "name": a.name, "kind": a.kind, "path": a.path, "size": a.size}
                for a in self.artifacts
            ],
            "metrics": self.metrics,
            "error": self.error.to_dict() if self.error else None,
        }

    def brief(self, limit: int = 600) -> str:
        """Compact rendering fed back into planner/verifier prompts."""
        head = self.summary or ("ok" if self.ok else "failed")
        body = ""
        if self.output is not None:
            import json

            try:
                body = json.dumps(self.output, default=str)[:limit]
            except (TypeError, ValueError):  # pragma: no cover
                body = str(self.output)[:limit]
        names = ", ".join(a.name for a in self.artifacts[:6])
        parts = [head]
        if body and body not in {"null", '""'}:
            parts.append(body)
        if names:
            parts.append(f"artifacts: {names}")
        return " | ".join(parts)


class Tool(ABC):
    """Base class for every capability the OS can invoke."""

    # -- identity
    name: str = ""
    version: str = "1.0.0"
    summary: str = ""
    tags: tuple[str, ...] = ()

    # -- authority (read by the policy engine before execution)
    capabilities: frozenset[str] = frozenset()
    risk: RiskLevel = RiskLevel.SAFE
    reversible: bool = True

    # -- contract
    parameters: dict[str, Any] = {"type": "object", "properties": {}, "additionalProperties": False}
    returns: str = "structured result"

    # -- scheduling hints
    max_concurrency: int = 0  # 0 = unlimited
    default_timeout: float = 300.0
    idempotent: bool = True  # safe for the retry loop to repeat verbatim

    def __init_subclass__(cls, **kw: Any) -> None:
        super().__init_subclass__(**kw)
        if not inspect.isabstract(cls) and not cls.name:
            raise TypeError(f"{cls.__name__} must define a `name`")

    # -- lifecycle -------------------------------------------------------
    @abstractmethod
    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        """Do the work. Arguments are already validated and coerced."""

    async def dry_run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        """Describe what ``execute`` would do without doing it."""
        return ToolResult.success(
            {"dry_run": True, "tool": self.name, "args": args},
            summary=f"[dry-run] {self.describe(args)}",
        )

    async def run(
        self, args: dict[str, Any], ctx: ToolContext, *, timeout: float | None = None
    ) -> ToolResult:
        """Validate, execute, time-bound, and classify failures. Never raises."""
        try:
            prepared = self.validate_args(args)
        except AiosError as exc:
            return ToolResult.failure(exc)

        limit = timeout or self.default_timeout
        remaining = ctx.remaining_seconds()
        if remaining > 0:
            limit = min(limit, remaining)

        await ctx.bus.publish(
            Topic.TOOL_INVOKED,
            {"tool": self.name, "version": self.version, "args": prepared, "timeout": limit},
            run_id=ctx.run_id,
            step_id=ctx.step_id,
        )
        ctx.budget.charge_tool()
        started = ctx.clock.monotonic()
        try:
            runner = self.dry_run(prepared, ctx) if ctx.dry_run else self.execute(prepared, ctx)
            result = await asyncio.wait_for(runner, timeout=limit if limit > 0 else None)
        except TimeoutError as exc:
            result = ToolResult.failure(
                ToolTimeout(
                    f"{self.name} exceeded its {limit:.0f}s time limit",
                    context={"tool": self.name},
                    cause=exc,
                )
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            result = ToolResult.failure(classify(exc))
            log.debug("tool raised", exc_info=True, extra={"tool": self.name})

        result.metrics.setdefault("duration_s", round(ctx.clock.monotonic() - started, 3))
        await ctx.bus.publish(
            Topic.TOOL_RETURNED if result.ok else Topic.TOOL_FAILED,
            {"tool": self.name, "ok": result.ok, "summary": result.summary[:400],
             "metrics": result.metrics,
             "error": result.error.to_dict() if result.error else None},
            run_id=ctx.run_id,
            step_id=ctx.step_id,
        )
        return result

    # -- introspection ---------------------------------------------------
    def validate_args(self, args: dict[str, Any]) -> dict[str, Any]:
        try:
            return validate_and_coerce(dict(args or {}), self.parameters)
        except ValidationError as exc:
            raise InvalidArguments(
                f"invalid arguments for {self.name}: {'; '.join(exc.errors)}",
                context={"tool": self.name, "errors": exc.errors, "schema": describe(self.parameters)},
                cause=exc,
            ) from exc

    def describe(self, args: dict[str, Any] | None = None) -> str:
        if not args:
            return self.name
        rendered = ", ".join(f"{k}={_clip(v)}" for k, v in list(args.items())[:4])
        return f"{self.name}({rendered})"

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        """What the policy engine sees. Override to surface paths/urls/commands."""
        return ActionRequest(
            tool=self.name,
            arguments=args,
            capabilities=self.capabilities,
            risk=self.risk,
            reversible=self.reversible,
            summary=self.describe(args),
        )

    def spec(self) -> dict[str, Any]:
        """Model-facing tool definition."""
        return {
            "name": self.name,
            "description": self.summary or (self.__doc__ or "").strip().split("\n")[0],
            "input_schema": self.parameters,
        }

    def manifest(self) -> dict[str, Any]:
        return {
            **self.spec(),
            "version": self.version,
            "tags": list(self.tags),
            "capabilities": sorted(self.capabilities),
            "risk": self.risk.name,
            "reversible": self.reversible,
            "idempotent": self.idempotent,
            "returns": self.returns,
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Tool {self.name}@{self.version} risk={self.risk.name}>"


def _clip(value: Any, limit: int = 48) -> str:
    text = str(value).replace("\n", " ")
    return text if len(text) <= limit else text[: limit - 1] + "…"
