"""Planning.

Turns an :class:`Intent` into an executable DAG. Three properties matter more
than plan elegance:

1. **Grounding.** Every step names a tool that exists, with arguments that
   validate against that tool's schema. A plan is checked against the registry
   *before* execution and, when it fails, the specific errors are handed back to
   the model for repair. A plan referencing an invented tool never reaches the
   scheduler.
2. **Parallelism by default.** Steps declare only the dependencies they truly
   have, so independent work fans out. The planner is explicitly instructed
   about this, and the graph is normalised afterwards to catch what it missed.
3. **A working fallback.** :class:`HeuristicPlanner` produces a real, runnable
   plan from templates when no model is available or the model is failing. The
   OS degrades to less ambitious work, never to no work.
"""

from __future__ import annotations

import json
from typing import Any

from ..foundation.errors import PlanError
from ..foundation.logging import get_logger
from ..model.client import ModelClient
from ..security.capabilities import CapabilitySet
from ..tools.registry import ToolRegistry
from ..tools.schema import ValidationError, validate_and_coerce
from .intent import Intent
from .plan import Check, Plan, Step

log = get_logger("cognition.planner")

PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "strategy": {"type": "string", "description": "One paragraph: the approach and why."},
        "steps": {
            "type": "array",
            "minItems": 1,
            "maxItems": 60,
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string",
                           "description": "short snake_case identifier, unique in the plan"},
                    "name": {"type": "string", "description": "imperative, human readable"},
                    "tool": {"type": "string", "description": "exact name from the tool catalog"},
                    "arguments": {"type": "object"},
                    "depends_on": {"type": "array", "items": {"type": "string"},
                                   "description": "ids of steps that must finish first"},
                    "optional": {"type": "boolean", "default": False},
                    "rationale": {"type": "string"},
                    "verify": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": list(Check.KINDS)},
                                "target": {"type": "string"},
                                "expect": {},
                            },
                            "required": ["kind"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["id", "name", "tool", "arguments"],
                "additionalProperties": False,
            },
        },
        "risks": {"type": "array", "items": {"type": "string"}},
        "assumptions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["strategy", "steps"],
    "additionalProperties": False,
}

_SYSTEM = """You plan work for an autonomous operating system that will execute
your plan without further input. Produce a directed acyclic graph of steps.

Hard rules:
- Use ONLY tools from the catalog, with exactly the arguments their schema allows.
- One tool call per step. If something needs two tools, it is two steps.
- `depends_on` lists ONLY genuine dependencies. Steps that do not depend on each
  other run in parallel, so spurious dependencies directly cost the user time.
- Reference an earlier step's result with ${step_id.field}, e.g.
  ${fetch_data.path} or ${probe.duration_s}. Referencing a step implies a
  dependency on it.
- Attach `verify` checks that a program can evaluate. A step that writes a file
  should verify the file exists and contains something specific. Verification is
  what distinguishes finished work from work that merely ran.
- Prefer reading and inspecting before writing. Look at what exists first.
- Mark a step `optional` only when the goal is still met without it.
- Do not plan to ask the user questions. Proceed on stated assumptions.

Think about what "done" means for this goal, then plan backwards from it."""


class HeuristicPlanner:
    """Template planner: no model required, always produces a runnable plan."""

    def plan(self, intent: Intent, registry: ToolRegistry, grant: CapabilitySet) -> Plan:
        available = {t.name for t in registry.available_to(grant)}
        builder = _TEMPLATES.get(intent.domain, _generic_plan)
        steps = [s for s in builder(intent) if s.tool in available]
        if not steps:
            steps = [s for s in _generic_plan(intent) if s.tool in available]
        if not steps:
            raise PlanError(
                "no builtin tool is available for this goal under the current capability grant",
                context={"domain": intent.domain, "granted": sorted(grant)},
            )
        plan = Plan(
            goal=intent.goal,
            steps=steps,
            strategy=f"Heuristic {intent.domain} template (no model planning available).",
            assumptions=[*intent.assumptions, "plan generated from a builtin template"],
            risks=["template plans are conservative and may not cover the full request"],
            success_criteria=intent.success_criteria,
            origin="heuristic",
        )
        return plan.normalize()


def _generic_plan(intent: Intent) -> list[Step]:
    """Understand the workspace, then record findings. Always safe to run."""
    return [
        Step(
            id="survey", binding="survey", name="Survey the workspace",
            tool="fs.list", arguments={"path": ".", "recursive": False, "max_entries": 200},
            rationale="establish what already exists before changing anything",
            verify=[Check("no_error")],
        ),
        Step(
            id="record", binding="record", name="Record the goal and workspace state",
            tool="doc.report",
            arguments={
                "output": "aios-brief.md",
                "title": intent.restated or intent.goal,
                "summary": (
                    f"Goal: {intent.goal}\n\nDomain: {intent.domain}. "
                    f"Deliverables: {', '.join(intent.deliverables) or 'unspecified'}."
                ),
                "sections": [
                    {"heading": "Workspace contents",
                     "body": "Entries found: ${survey.count}"},
                    {"heading": "Success criteria",
                     "body": "\n".join(f"- {c}" for c in intent.success_criteria) or "- not specified"},
                ],
            },
            depends_on=["survey"],
            verify=[Check("file_exists", "aios-brief.md"),
                    Check("file_contains", "aios-brief.md", expect="Success criteria")],
        ),
    ]


def _software_plan(intent: Intent) -> list[Step]:
    return [
        Step(id="survey", binding="survey", name="Inventory the repository",
             tool="fs.list", arguments={"path": ".", "recursive": True, "max_entries": 400},
             verify=[Check("no_error")]),
        Step(id="analyze", binding="analyze", name="Analyse code structure",
             tool="code.analyze", arguments={"path": "."}, depends_on=["survey"],
             optional=True, verify=[Check("no_error")]),
        Step(id="vcs", binding="vcs", name="Check version control state",
             tool="git.status", arguments={"path": "."}, optional=True),
        Step(id="tests", binding="tests", name="Run the existing test suite",
             tool="code.test", arguments={"path": "."}, depends_on=["survey"], optional=True),
        Step(id="report", binding="report", name="Write an engineering brief",
             tool="doc.report",
             arguments={
                 "output": "engineering-brief.md",
                 "title": intent.restated or intent.goal,
                 "summary": f"Automated assessment for: {intent.goal}",
                 "sections": [
                     {"heading": "Codebase", "body":
                      "Files: ${analyze.files}. Functions: ${analyze.symbols.functions}. "
                      "Duplicate blocks: ${analyze.duplicate_logic}."},
                     {"heading": "Tests", "body": "Result: ${tests.passed} passed."},
                 ],
             },
             depends_on=["analyze", "tests"],
             verify=[Check("file_exists", "engineering-brief.md")]),
    ]


def _web_plan(intent: Intent) -> list[Step]:
    title = intent.restated or intent.goal
    # Deliverables are prose ("a working index.html"), so derive the project
    # name from the goal instead of using one as a directory name.
    name = _slug(title) or "site"
    return [
        Step(id="scaffold", binding="scaffold", name="Scaffold the site",
             tool="code.scaffold",
             arguments={"path": "site", "kind": "static-site", "name": name,
                        "description": title},
             verify=[Check("file_exists", "site/index.html"),
                     Check("file_contains", "site/index.html", expect="<title>")]),
        Step(id="readme", binding="readme", name="Document how to run it",
             tool="fs.write",
             arguments={"path": "site/RUNNING.md",
                        "content": f"# {title}\n\nServe locally:\n\n```bash\n"
                                   "python3 -m http.server 8000 --directory site\n```\n"},
             depends_on=["scaffold"],
             verify=[Check("file_exists", "site/RUNNING.md")]),
    ]


def _data_plan(intent: Intent) -> list[Step]:
    source = next((d for d in intent.deliverables if d.endswith((".csv", ".tsv", ".json"))), "data.csv")
    return [
        Step(id="find", binding="find", name="Locate data files",
             tool="fs.search", arguments={"path": ".", "name_glob": "*.csv", "max_results": 50},
             verify=[Check("no_error")]),
        Step(id="profile", binding="profile", name="Profile the dataset",
             tool="data.inspect", arguments={"path": source}, depends_on=["find"],
             verify=[Check("no_error")]),
        Step(id="report", binding="report", name="Write the analysis report",
             tool="doc.report",
             arguments={"output": "analysis.md", "title": intent.restated or intent.goal,
                        "summary": "Automated data profile.",
                        "sections": [{"heading": "Data quality",
                                      "body": "Issues found: ${profile.issues}"}]},
             depends_on=["profile"],
             verify=[Check("file_exists", "analysis.md")]),
    ]


def _media_plan(intent: Intent) -> list[Step]:
    source = next(
        (d for d in intent.deliverables if d.endswith((".mp4", ".mov", ".mkv", ".wav", ".mp3"))),
        "input.mp4",
    )
    return [
        Step(id="probe", binding="probe", name="Inspect the media file",
             tool="media.probe", arguments={"input": source},
             verify=[Check("no_error")]),
        Step(id="analyze", binding="analyze", name="Analyse silence without editing",
             tool="media.remove_silence",
             arguments={"input": source, "analyze_only": True},
             depends_on=["probe"], optional=True),
        Step(id="thumb", binding="thumb", name="Capture a poster frame",
             tool="media.thumbnail", arguments={"input": source, "at": "10%"},
             depends_on=["probe"], optional=True),
    ]


def _research_plan(intent: Intent) -> list[Step]:
    return [
        Step(id="search", binding="search", name="Search for sources",
             tool="net.search", arguments={"query": intent.restated or intent.goal, "count": 8},
             optional=True, verify=[Check("no_error")]),
        Step(id="brief", binding="brief", name="Write the research brief",
             tool="doc.report",
             arguments={"output": "research-brief.md", "title": intent.restated or intent.goal,
                        "summary": f"Research question: {intent.goal}",
                        "sections": [{"heading": "Sources", "body": "${search.results}"}]},
             depends_on=["search"],
             verify=[Check("file_exists", "research-brief.md")]),
    ]


def _system_plan(intent: Intent) -> list[Step]:
    return [
        Step(id="info", binding="info", name="Read system state", tool="sys.info", arguments={}),
        Step(id="usage", binding="usage", name="Measure workspace storage",
             tool="fs.usage", arguments={"path": ".", "top": 25}),
        Step(id="preview", binding="preview", name="Preview a tidy-up (no changes yet)",
             tool="fs.organize", arguments={"path": ".", "strategy": "kind", "apply": False},
             depends_on=["usage"],
             verify=[Check("no_error")]),
        Step(id="report", binding="report", name="Write the maintenance report",
             tool="doc.report",
             arguments={"output": "maintenance-report.md", "title": "Workspace maintenance",
                        "summary": "Storage and organisation assessment.",
                        "sections": [
                            {"heading": "Storage", "body": "Total bytes: ${usage.total_bytes}"},
                            {"heading": "Proposed moves", "body": "${preview.planned} file(s)"},
                        ]},
             depends_on=["info", "preview"],
             verify=[Check("file_exists", "maintenance-report.md")]),
    ]


def _document_plan(intent: Intent) -> list[Step]:
    return [
        Step(id="survey", binding="survey", name="Gather workspace context",
             tool="fs.list", arguments={"path": ".", "max_entries": 200}),
        Step(id="doc", binding="doc", name="Write the document",
             tool="doc.report",
             arguments={"output": "document.md", "title": intent.restated or intent.goal,
                        "summary": intent.goal,
                        "sections": [{"heading": "Overview", "body": intent.goal}]},
             depends_on=["survey"],
             verify=[Check("file_exists", "document.md")]),
    ]


def _slug(text: str, limit: int = 40) -> str:
    import re

    cleaned = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return cleaned[:limit].rstrip("-")


_TEMPLATES = {
    "software": _software_plan,
    "web": _web_plan,
    "data": _data_plan,
    "media": _media_plan,
    "research": _research_plan,
    "system": _system_plan,
    "document": _document_plan,
    "business": _document_plan,
    "general": _generic_plan,
    "automation": _generic_plan,
}


class Planner:
    """Model planner with grounding, repair and heuristic fallback."""

    def __init__(
        self,
        model: ModelClient | None,
        registry: ToolRegistry,
        *,
        repair_attempts: int = 2,
    ) -> None:
        self.model = model
        self.registry = registry
        self.repair_attempts = repair_attempts
        self.fallback = HeuristicPlanner()

    async def plan(
        self,
        intent: Intent,
        grant: CapabilitySet,
        *,
        context: str = "",
        run_id: str | None = None,
        allow_fallback: bool = True,
    ) -> Plan:
        """Produce a grounded plan.

        ``allow_fallback`` is on for the initial plan - a template plan beats no
        plan. It is off when *re*planning: splicing a generic template into a
        run that is already half-done adds unrelated work instead of routing
        around the actual failure, so failing to replan is the honest outcome.
        """
        if self.model is not None and self.model.can_generate():
            try:
                return await self._model_plan(intent, grant, context, run_id)
            except Exception as exc:
                if not allow_fallback:
                    raise
                log.warning("model planning failed; using heuristic plan",
                            extra={"error": str(exc)[:200]}, exc_info=True)
        elif not allow_fallback:
            raise PlanError("replanning requires a generative model")
        else:
            log.info("no generative model available; planning from builtin templates")
        return self.fallback.plan(intent, self.registry, grant)

    async def _model_plan(
        self, intent: Intent, grant: CapabilitySet, context: str, run_id: str | None
    ) -> Plan:
        catalog = self.registry.catalog(grant)
        prompt = (
            f"{intent.render()}\n\n"
            f"Available tools:\n{catalog}\n\n"
            + (f"Context:\n{context}\n\n" if context else "")
            + "Produce the plan."
        )
        errors: list[str] = []
        for attempt in range(self.repair_attempts + 1):
            payload = await self.model.structured(
                prompt if attempt == 0 else (
                    f"{prompt}\n\nThe previous plan was rejected:\n- "
                    + "\n- ".join(errors[:12])
                    + "\n\nProduce a corrected plan."
                ),
                PLAN_SCHEMA,
                system=_SYSTEM,
                purpose="plan" if attempt == 0 else f"plan/repair{attempt}",
                run_id=run_id,
            )
            plan = self._materialize(intent, payload)
            errors = self.ground(plan, grant)
            if not errors:
                plan.normalize().validate()
                return plan
            log.warning("plan failed grounding", extra={"attempt": attempt + 1,
                                                        "errors": errors[:5]})
        raise PlanError(
            "model could not produce a grounded plan", context={"errors": errors[:12]}
        )

    def _materialize(self, intent: Intent, payload: dict[str, Any]) -> Plan:
        steps: list[Step] = []
        for raw in payload.get("steps") or []:
            steps.append(
                Step(
                    id=str(raw.get("id") or "").strip() or f"step_{len(steps) + 1}",
                    binding=str(raw.get("id") or "").strip(),
                    name=raw.get("name") or raw.get("id") or "step",
                    tool=raw.get("tool", ""),
                    arguments=raw.get("arguments") or {},
                    depends_on=list(raw.get("depends_on") or []),
                    optional=bool(raw.get("optional", False)),
                    rationale=raw.get("rationale", ""),
                    verify=[
                        Check(kind=c["kind"], target=str(c.get("target", "")), expect=c.get("expect"))
                        for c in (raw.get("verify") or [])
                        if isinstance(c, dict) and c.get("kind")
                    ],
                )
            )
        return Plan(
            goal=intent.goal,
            steps=steps,
            strategy=payload.get("strategy", ""),
            assumptions=[*intent.assumptions, *(payload.get("assumptions") or [])],
            risks=payload.get("risks") or [],
            success_criteria=intent.success_criteria,
            origin="model",
        )

    def ground(self, plan: Plan, grant: CapabilitySet) -> list[str]:
        """Check the plan against reality. Returns actionable error strings."""
        errors: list[str] = []
        if not plan.steps:
            return ["the plan contains no steps"]
        ids = [s.binding or s.id for s in plan.steps]
        duplicates = {i for i in ids if ids.count(i) > 1}
        if duplicates:
            errors.append(f"duplicate step ids: {', '.join(sorted(duplicates))}")

        for step in plan.steps:
            tool = self.registry.try_get(step.tool)
            if tool is None:
                suggestions = self.registry.suggest(step.tool)
                errors.append(
                    f"step {step.name!r}: unknown tool {step.tool!r}"
                    + (f" (did you mean {', '.join(suggestions)}?)" if suggestions else "")
                )
                continue
            missing = grant.missing(tool.capabilities)
            if missing:
                errors.append(
                    f"step {step.name!r}: tool {tool.name} needs ungranted "
                    f"capabilities {', '.join(sorted(missing))}"
                )
            # Skip schema validation for arguments that are references - their
            # concrete values only exist at dispatch time.
            concrete = {
                k: v for k, v in step.arguments.items()
                if not (isinstance(v, str) and "${" in v)
            }
            try:
                validate_and_coerce(concrete, _relaxed(tool.parameters, step.arguments))
            except ValidationError as exc:
                errors.append(f"step {step.name!r} ({tool.name}): " + "; ".join(exc.errors[:4]))

            for dependency in step.depends_on:
                if dependency not in ids and not any(s.id == dependency for s in plan.steps):
                    errors.append(f"step {step.name!r}: depends on unknown step {dependency!r}")
        return errors


def _relaxed(schema: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    """Drop `required` entries supplied as unresolved references."""
    referenced = {k for k, v in arguments.items() if isinstance(v, str) and "${" in v}
    if not referenced:
        return schema
    relaxed = dict(schema)
    relaxed["required"] = [r for r in schema.get("required", []) if r not in referenced]
    return relaxed


def plan_to_json(plan: Plan) -> str:
    return json.dumps(plan.to_dict(include_state=False), indent=2)
