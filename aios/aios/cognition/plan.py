"""Plan representation.

A plan is a **directed acyclic graph of steps**, not a list. That single choice
is what makes the rest of the system possible:

- independent work runs in parallel because the graph says it is independent;
- a failure only cancels the sub-graph that actually depended on it;
- a replan can splice new nodes into a running graph without restarting;
- the critical path is computable, so the scheduler prioritises the work that
  determines total run time.

Steps consume each other's results through ``${...}`` references resolved at
dispatch time, which keeps the plan a *value* - serializable, inspectable and
diffable - rather than a closure over live objects.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any

from ..foundation.errors import CyclicPlan, PlanError
from ..foundation.ids import new_id

_REFERENCE = re.compile(r"\$\{([a-zA-Z0-9_.\[\]-]+)\}")


class StepState(str, Enum):
    PENDING = "pending"
    READY = "ready"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"
    BLOCKED = "blocked"  # an upstream dependency failed
    CANCELLED = "cancelled"

    @property
    def terminal(self) -> bool:
        return self in {
            StepState.SUCCEEDED, StepState.FAILED, StepState.SKIPPED,
            StepState.BLOCKED, StepState.CANCELLED,
        }


@dataclass(slots=True)
class Check:
    """A verification contract attached to a step.

    Steps assert their own success criteria so "it ran without raising" is never
    mistaken for "it worked".
    """

    kind: str
    target: str = ""
    expect: Any = None
    description: str = ""

    KINDS = (
        "file_exists",       # target path exists
        "file_contains",     # target file contains `expect` (substring or /regex/)
        "file_min_size",     # target file is at least `expect` bytes
        "dir_not_empty",     # target directory has at least one entry
        "output_contains",   # the step result mentions `expect`
        "output_equals",     # a field of the result equals `expect`
        "json_parses",       # target file parses as JSON
        "artifact_produced", # the step registered at least one artifact
        "exit_zero",         # the step's command exited 0
        "no_error",          # the step result is ok
        "command_succeeds",  # run `target` and require exit 0
        "url_ok",            # GET `target` returns < 400
    )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class Step:
    """One unit of work: exactly one tool invocation plus its contract."""

    name: str
    tool: str
    arguments: dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: new_id("stp_"))
    depends_on: list[str] = field(default_factory=list)
    verify: list[Check] = field(default_factory=list)

    rationale: str = ""
    optional: bool = False  # failure does not fail the run
    priority: int = 0  # higher runs first among ready steps
    timeout_seconds: float | None = None
    max_attempts: int | None = None
    binding: str = ""  # name later steps reference: ${binding.field}

    # -- mutable execution state (not part of plan identity)
    state: StepState = StepState.PENDING
    attempts: int = 0
    result: Any = None
    error: dict[str, Any] | None = None
    started_at: float = 0.0
    ended_at: float = 0.0

    @property
    def ref(self) -> str:
        return self.binding or self.id

    @property
    def duration(self) -> float:
        return max(0.0, self.ended_at - self.started_at) if self.ended_at else 0.0

    def references(self) -> set[str]:
        """Binding names this step's arguments interpolate."""
        found: set[str] = set()
        for match in _REFERENCE.finditer(_flatten(self.arguments)):
            found.add(match.group(1).split(".")[0])
        return found

    def to_dict(self, *, include_state: bool = True) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "tool": self.tool,
            "arguments": self.arguments,
            "depends_on": list(self.depends_on),
            "verify": [c.to_dict() for c in self.verify],
            "rationale": self.rationale,
            "optional": self.optional,
            "priority": self.priority,
            "binding": self.binding,
        }
        if include_state:
            payload |= {
                "state": self.state.value,
                "attempts": self.attempts,
                "duration_s": round(self.duration, 3),
                "error": self.error,
            }
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> Step:
        return cls(
            name=payload["name"],
            tool=payload["tool"],
            arguments=payload.get("arguments") or {},
            id=payload.get("id") or new_id("stp_"),
            depends_on=list(payload.get("depends_on") or []),
            verify=[Check(**c) if isinstance(c, dict) else c for c in payload.get("verify") or []],
            rationale=payload.get("rationale", ""),
            optional=bool(payload.get("optional", False)),
            priority=int(payload.get("priority", 0)),
            timeout_seconds=payload.get("timeout_seconds"),
            max_attempts=payload.get("max_attempts"),
            binding=payload.get("binding", ""),
        )


@dataclass(slots=True)
class Plan:
    goal: str
    steps: list[Step] = field(default_factory=list)
    id: str = field(default_factory=lambda: new_id("pln_"))
    strategy: str = ""
    assumptions: list[str] = field(default_factory=list)
    risks: list[str] = field(default_factory=list)
    success_criteria: list[str] = field(default_factory=list)
    revision: int = 0
    origin: str = "planner"

    # -- graph -----------------------------------------------------------
    def by_id(self, step_id: str) -> Step | None:
        for step in self.steps:
            if step.id == step_id or step.binding == step_id:
                return step
        return None

    def index(self) -> dict[str, Step]:
        table: dict[str, Step] = {}
        for step in self.steps:
            table[step.id] = step
            if step.binding:
                table[step.binding] = step
        return table

    def validate(self) -> None:
        """Reject a plan that cannot be executed, before anything runs."""
        if not self.steps:
            raise PlanError("plan has no steps")
        seen: set[str] = set()
        table = self.index()
        for step in self.steps:
            if step.id in seen:
                raise PlanError(f"duplicate step id {step.id}")
            seen.add(step.id)
            if not step.tool:
                raise PlanError(f"step {step.name!r} has no tool")
            for dependency in step.depends_on:
                if dependency not in table:
                    raise PlanError(
                        f"step {step.name!r} depends on unknown step {dependency!r}",
                        context={"known": sorted(table)[:40]},
                    )
            for reference in step.references():
                if reference not in table:
                    raise PlanError(
                        f"step {step.name!r} references unknown binding ${{{reference}}}",
                        context={"known": sorted(table)[:40]},
                    )
        self.topological_order()  # raises CyclicPlan

    def normalize(self) -> Plan:
        """Make implicit data dependencies explicit.

        A step that interpolates ``${build.path}`` obviously depends on
        ``build``; requiring the planner to also say so is a reliable source of
        subtly wrong plans, so it is inferred here instead.
        """
        table = self.index()
        for step in self.steps:
            for reference in step.references():
                target = table.get(reference)
                if target and target.id != step.id and target.id not in step.depends_on:
                    step.depends_on.append(target.id)
            # Normalise binding-name dependencies to ids for stable comparison.
            step.depends_on = list(
                dict.fromkeys(
                    table[d].id for d in step.depends_on if d in table
                )
            )
        return self

    def topological_order(self) -> list[Step]:
        """Kahn's algorithm; raises :class:`CyclicPlan` on a cycle."""
        table = self.index()
        indegree = {s.id: 0 for s in self.steps}
        adjacency: dict[str, list[str]] = {s.id: [] for s in self.steps}
        for step in self.steps:
            for dependency in step.depends_on:
                target = table.get(dependency)
                if target is None:
                    continue
                indegree[step.id] += 1
                adjacency[target.id].append(step.id)

        # Deterministic tie-break keeps runs reproducible.
        frontier = sorted(
            [s for s in self.steps if indegree[s.id] == 0],
            key=lambda s: (-s.priority, self.steps.index(s)),
        )
        ordered: list[Step] = []
        while frontier:
            step = frontier.pop(0)
            ordered.append(step)
            for successor_id in adjacency[step.id]:
                indegree[successor_id] -= 1
                if indegree[successor_id] == 0:
                    successor = table[successor_id]
                    frontier.append(successor)
                    frontier.sort(key=lambda s: (-s.priority, self.steps.index(s)))
        if len(ordered) != len(self.steps):
            stuck = [s.name for s in self.steps if s not in ordered]
            raise CyclicPlan(
                "plan contains a dependency cycle",
                context={"steps_in_cycle": stuck[:20]},
            )
        return ordered

    def dependents(self, step_id: str) -> list[Step]:
        """Transitive downstream steps - what a failure blocks."""
        table = self.index()
        target = table.get(step_id)
        if target is None:
            return []
        blocked: list[Step] = []
        frontier = [target.id]
        seen = {target.id}
        while frontier:
            current = frontier.pop()
            for step in self.steps:
                if step.id in seen:
                    continue
                if any(table.get(d) and table[d].id == current for d in step.depends_on):
                    seen.add(step.id)
                    blocked.append(step)
                    frontier.append(step.id)
        return blocked

    def critical_path(self, estimate: dict[str, float] | None = None) -> list[Step]:
        """Longest dependency chain by estimated cost - what to prioritise."""
        estimate = estimate or {}
        table = self.index()
        best: dict[str, tuple[float, list[Step]]] = {}
        for step in self.topological_order():
            cost = estimate.get(step.id, 1.0)
            incoming = [
                best[table[d].id]
                for d in step.depends_on
                if table.get(d) and table[d].id in best
            ]
            if incoming:
                weight, path = max(incoming, key=lambda item: item[0])
                best[step.id] = (weight + cost, [*path, step])
            else:
                best[step.id] = (cost, [step])
        return max(best.values(), key=lambda item: item[0])[1] if best else []

    def levels(self) -> list[list[Step]]:
        """Steps grouped into parallelisable waves; used for display."""
        table = self.index()
        depth: dict[str, int] = {}
        for step in self.topological_order():
            parents = [depth.get(table[d].id, 0) for d in step.depends_on if table.get(d)]
            depth[step.id] = (max(parents) + 1) if parents else 0
        waves: dict[int, list[Step]] = {}
        for step in self.steps:
            waves.setdefault(depth.get(step.id, 0), []).append(step)
        return [waves[key] for key in sorted(waves)]

    # -- state -----------------------------------------------------------
    @property
    def done(self) -> bool:
        return all(s.state.terminal for s in self.steps)

    @property
    def succeeded(self) -> bool:
        return all(
            s.state in {StepState.SUCCEEDED, StepState.SKIPPED} or s.optional for s in self.steps
        )

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for step in self.steps:
            out[step.state.value] = out.get(step.state.value, 0) + 1
        return out

    def add(self, step: Step, *, after: str | None = None) -> Step:
        """Splice a step in - used by decomposition recovery."""
        if after:
            step.depends_on = list(dict.fromkeys([*step.depends_on, after]))
        self.steps.append(step)
        return step

    # -- serialization ---------------------------------------------------
    def to_dict(self, *, include_state: bool = True) -> dict[str, Any]:
        return {
            "id": self.id,
            "goal": self.goal,
            "strategy": self.strategy,
            "assumptions": self.assumptions,
            "risks": self.risks,
            "success_criteria": self.success_criteria,
            "revision": self.revision,
            "origin": self.origin,
            "steps": [s.to_dict(include_state=include_state) for s in self.steps],
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> Plan:
        plan = cls(
            goal=payload.get("goal", ""),
            steps=[Step.from_dict(s) for s in payload.get("steps") or []],
            id=payload.get("id") or new_id("pln_"),
            strategy=payload.get("strategy", ""),
            assumptions=list(payload.get("assumptions") or []),
            risks=list(payload.get("risks") or []),
            success_criteria=list(payload.get("success_criteria") or []),
            revision=int(payload.get("revision", 0)),
            origin=payload.get("origin", "planner"),
        )
        return plan

    def render(self) -> str:
        """Human-readable outline, grouped into parallel waves."""
        lines = [f"Goal: {self.goal}"]
        if self.strategy:
            lines.append(f"Strategy: {self.strategy}")
        for index, wave in enumerate(self.levels(), 1):
            lines.append(f"\n  Wave {index} ({len(wave)} in parallel):")
            for step in wave:
                marker = {"succeeded": "✔", "failed": "✘", "skipped": "–",
                          "running": "▸", "blocked": "⊘"}.get(step.state.value, "·")
                flag = " [optional]" if step.optional else ""
                lines.append(f"    {marker} {step.name} → {step.tool}{flag}")
        return "\n".join(lines)


def _flatten(value: Any) -> str:
    import json

    try:
        return json.dumps(value, default=str)
    except (TypeError, ValueError):  # pragma: no cover
        return str(value)


def resolve_references(value: Any, bindings: dict[str, Any]) -> Any:
    """Substitute ``${binding.path.to.field}`` using completed step results.

    A reference that is the *entire* string resolves to the typed value (so a
    number stays a number); an embedded reference interpolates as text.
    """
    if isinstance(value, str):
        whole = _REFERENCE.fullmatch(value.strip())
        if whole:
            return _lookup(whole.group(1), bindings)

        def replace(match: re.Match[str]) -> str:
            resolved = _lookup(match.group(1), bindings)
            return resolved if isinstance(resolved, str) else _flatten(resolved)

        return _REFERENCE.sub(replace, value)
    if isinstance(value, dict):
        return {k: resolve_references(v, bindings) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_references(v, bindings) for v in value]
    return value


def _lookup(path: str, bindings: dict[str, Any]) -> Any:
    parts = path.replace("[", ".").replace("]", "").split(".")
    current: Any = bindings
    for part in parts:
        if part == "":
            continue
        if isinstance(current, dict):
            if part not in current:
                raise PlanError(
                    f"unresolved reference ${{{path}}}: no {part!r}",
                    context={"available": sorted(current)[:25] if isinstance(current, dict) else []},
                )
            current = current[part]
        elif isinstance(current, list | tuple) and part.isdigit():
            index = int(part)
            if index >= len(current):
                raise PlanError(f"unresolved reference ${{{path}}}: index {index} out of range")
            current = current[index]
        else:
            raise PlanError(f"unresolved reference ${{{path}}}: cannot descend into {part!r}")
    return current
