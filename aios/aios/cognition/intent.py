"""Intent understanding.

The first stage of the pipeline, and the one that most determines output
quality. A request like "make me a site for my bakery" carries an unstated
deliverable (files on disk, not a description of files), unstated constraints
(it should actually open in a browser) and an unstated definition of done.
Turning that into an explicit :class:`Intent` before planning is what stops the
system from confidently building the wrong thing.

Ambiguity is *recorded*, not silently resolved: questions land in
``open_questions``, and each gets a working assumption so execution proceeds
rather than blocking on a human - the assumptions are surfaced in the final
report so a wrong one is cheap to correct.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from ..foundation.logging import get_logger
from ..model.client import ModelClient

log = get_logger("cognition.intent")


@dataclass(slots=True)
class Intent:
    goal: str
    restated: str = ""
    domain: str = "general"
    complexity: str = "moderate"  # simple | moderate | complex
    deliverables: list[str] = field(default_factory=list)
    constraints: list[str] = field(default_factory=list)
    success_criteria: list[str] = field(default_factory=list)
    open_questions: list[str] = field(default_factory=list)
    assumptions: list[str] = field(default_factory=list)
    sensitive_actions: list[str] = field(default_factory=list)
    source: str = "heuristic"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def render(self) -> str:
        lines = [f"Goal: {self.restated or self.goal}", f"Domain: {self.domain} ({self.complexity})"]
        if self.deliverables:
            lines.append("Deliverables: " + "; ".join(self.deliverables))
        if self.success_criteria:
            lines.append("Done when: " + "; ".join(self.success_criteria))
        if self.assumptions:
            lines.append("Assuming: " + "; ".join(self.assumptions))
        if self.sensitive_actions:
            lines.append("Needs approval: " + "; ".join(self.sensitive_actions))
        return "\n".join(lines)


INTENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "restated": {"type": "string",
                     "description": "The goal restated precisely and unambiguously."},
        "domain": {"type": "string",
                   "enum": ["software", "web", "data", "research", "media", "document",
                            "automation", "system", "business", "general"]},
        "complexity": {"type": "string", "enum": ["simple", "moderate", "complex"]},
        "deliverables": {"type": "array", "items": {"type": "string"},
                         "description": "Concrete artifacts that must exist when done."},
        "constraints": {"type": "array", "items": {"type": "string"}},
        "success_criteria": {"type": "array", "items": {"type": "string"},
                             "description": "Objectively checkable conditions."},
        "open_questions": {"type": "array", "items": {"type": "string"}},
        "assumptions": {"type": "array", "items": {"type": "string"},
                        "description": "One working assumption per open question."},
        "sensitive_actions": {"type": "array", "items": {"type": "string"},
                              "description": "Steps that would need human approval."},
    },
    "required": ["restated", "domain", "complexity", "deliverables", "success_criteria"],
    "additionalProperties": False,
}

_SYSTEM = """You analyse a user's request before any work begins.

Be concrete. "Deliverables" are files or services that will exist on disk when
the work is done, not descriptions of work. "Success criteria" must be things a
program could check - "index.html exists and contains a <title>", not "looks
professional".

Name every action that would send data outside this machine, spend money,
delete user data, or publish anything, under sensitive_actions.

If the request is ambiguous, record the question AND the assumption you would
proceed with. Never invent requirements the user did not express."""

# Domain signals, scored rather than first-match-wins.
#
# First-match ordering gets this wrong in a way that matters: "organise this
# workspace and report on storage" is a maintenance task, but "report" is a
# *format* word that would otherwise claim it for the document domain. So every
# domain is scored across all its signals and the strongest wins, with
# multi-word signals weighted double because they are far less accidental.
#
# Order still breaks ties, so it runs most-specific-first.
_DOMAIN_SIGNALS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("media", ("video", "audio", "footage", "subtitle", "podcast", "thumbnail", "silence",
               "transcode", "edit the clip", "mp4", "render")),
    ("data", ("csv", "spreadsheet", "excel", "dataset", "sql", "analyz", "analys", "chart",
              "pivot", "aggregate", "dataframe")),
    ("web", ("website", "landing page", "web app", "frontend", "html", "css", "site for")),
    ("software", ("code", "bug", "test", "refactor", "api", "function", "compile", "deploy",
                  "repository", "library", "script", "debug", "implement")),
    ("research", ("research", "find out", "compare", "investigate", "summar", "review the",
                  "look up", "what is", "who is")),
    ("document", ("report", "document", "presentation", "slide", "deck", "write up", "memo",
                  "proposal", "essay", "article")),
    ("automation", ("automate", "workflow", "every day", "schedule", "pipeline", "browser",
                    "scrape", "fill in the form")),
    ("system", ("organize", "organise", "tidy", "clean up", "declutter", "disk", "install",
                "storage", "rename", "folder", "directory", "backup", "maintenance",
                "free up space", "duplicate file")),
    ("business", ("marketing", "campaign", "seo", "business plan", "pricing", "customers")),
)

_SENSITIVE_SIGNALS: tuple[tuple[str, str], ...] = (
    (r"\b(send|email|mail)\b", "sending email or messages"),
    (r"\b(publish|deploy|release|go live|push to (prod|production))\b", "publishing publicly"),
    (r"\b(delete|remove|wipe|clear out|purge)\b", "deleting files"),
    (r"\b(pay|purchase|buy|invoice|charge|subscribe)\b", "financial transactions"),
    (r"\b(credential|password|api key|secret|token)\b", "handling credentials"),
    (r"\b(install|uninstall|sudo|system setting)\b", "changing system configuration"),
    (r"\bgit\s+push\b|\bpull request\b|\bpr\b", "pushing code to a remote"),
)


class IntentResolver:
    """Model-backed with a heuristic fallback that always produces something."""

    def __init__(self, model: ModelClient | None = None) -> None:
        self.model = model

    async def resolve(self, goal: str, *, context: str = "", run_id: str | None = None) -> Intent:
        goal = (goal or "").strip()
        if not goal:
            raise ValueError("goal is empty")
        if self.model is not None and self.model.can_generate():
            try:
                return await self._with_model(goal, context, run_id)
            except Exception:
                log.warning("intent model call failed; using heuristics", exc_info=True)
        return self.heuristic(goal)

    async def _with_model(self, goal: str, context: str, run_id: str | None) -> Intent:
        prompt = f"Request:\n{goal}"
        if context:
            prompt += f"\n\nRelevant context from previous work:\n{context}"
        payload = await self.model.structured(
            prompt, INTENT_SCHEMA, system=_SYSTEM, purpose="intent", run_id=run_id
        )
        fallback = self.heuristic(goal)
        return Intent(
            goal=goal,
            restated=payload.get("restated") or goal,
            domain=payload.get("domain") or fallback.domain,
            complexity=payload.get("complexity") or fallback.complexity,
            deliverables=payload.get("deliverables") or fallback.deliverables,
            constraints=payload.get("constraints") or [],
            success_criteria=payload.get("success_criteria") or fallback.success_criteria,
            open_questions=payload.get("open_questions") or [],
            assumptions=payload.get("assumptions") or [],
            sensitive_actions=payload.get("sensitive_actions") or fallback.sensitive_actions,
            source="model",
        )

    @staticmethod
    def heuristic(goal: str) -> Intent:
        """Signal-based classification. Deterministic, and never fabricates."""
        lowered = goal.lower()

        scores: list[tuple[int, int, str]] = []
        for rank, (name, signals) in enumerate(_DOMAIN_SIGNALS):
            score = sum(
                (2 if " " in signal else 1) for signal in signals if signal in lowered
            )
            if score:
                scores.append((-score, rank, name))
        domain = min(scores)[2] if scores else "general"

        # Complexity tracks the number of distinct actions requested, not just
        # length. Clause separators are the cheapest reliable proxy: "read the
        # config, update the version, and rebuild the docs" is short but is
        # plainly three pieces of work.
        words = len(goal.split())
        separators = len(
            re.findall(r"[,;]|\band\b|\bthen\b|\bafter that\b|\balso\b|\bplus\b", lowered)
        )
        if words < 12 and separators == 0:
            complexity = "simple"
        elif words > 45 or separators >= 4:
            complexity = "complex"
        else:
            complexity = "moderate"

        sensitive = [label for pattern, label in _SENSITIVE_SIGNALS if re.search(pattern, lowered)]

        deliverables: list[str] = []
        file_pattern = r"\b([\w\-/.]+\.(?:html|md|py|js|ts|csv|json|mp4|pdf|xlsx|pptx|txt))\b"
        for match in re.finditer(file_pattern, goal):
            deliverables.append(match.group(1))
        if not deliverables:
            deliverables = [_DEFAULT_DELIVERABLE.get(domain, "a written summary of the result")]

        return Intent(
            goal=goal,
            restated=goal,
            domain=domain,
            complexity=complexity,
            deliverables=deliverables,
            success_criteria=[f"{d} exists and is non-empty" for d in deliverables],
            sensitive_actions=sensitive,
            assumptions=["classified without model assistance; scope inferred from wording"],
            source="heuristic",
        )


_DEFAULT_DELIVERABLE = {
    "web": "a working index.html in the workspace",
    "software": "working source files plus a passing test run",
    "data": "an analysis output file (CSV or report)",
    "research": "a research brief in Markdown",
    "media": "an exported media file",
    "document": "a rendered document",
    "automation": "an executable automation script",
    "system": "a report of what changed on disk",
    "business": "a written plan document",
}
