"""Run reports.

Every run produces an account of itself that a human can read without knowing
anything about the internals: what was asked, what was assumed, what ran, what
was verified, what failed and what it cost.

Failures are reported at least as prominently as successes. A report that
buries a failed step under a green header is how automation loses trust, so
"what did not work" is a top-level section and partial success is labelled
partial, never "done".
"""

from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any

from ..kernel.kernel import RunResult
from ..runtime.ledger import Ledger

_STATUS_STYLE = {
    "succeeded": ("#0f8a4a", "Succeeded"),
    "partial": ("#b07400", "Partially completed"),
    "failed": ("#c0392b", "Failed"),
    "cancelled": ("#5b6270", "Cancelled"),
}


def to_markdown(result: RunResult) -> str:
    lines = [
        f"# Run report — {result.goal}",
        "",
        f"- **Status:** {result.status}",
        f"- **Run id:** `{result.run_id}`",
        f"- **Duration:** {result.duration_s:.1f}s",
        f"- **Cost:** ${result.budget.get('used', {}).get('usd', 0):.4f}",
        "",
    ]
    if result.intent:
        lines += ["## Understood as", "", result.intent.render(), ""]

    if result.plan:
        lines += ["## Execution", ""]
        for index, wave in enumerate(result.plan.levels(), 1):
            lines.append(f"**Wave {index}**")
            lines.append("")
            for step in wave:
                marker = {"succeeded": "✔", "failed": "✘", "skipped": "–",
                          "blocked": "⊘", "cancelled": "◻"}.get(step.state.value, "·")
                lines.append(
                    f"- {marker} `{step.tool}` — {step.name}"
                    + (f" ({step.attempts} attempts)" if step.attempts > 1 else "")
                )
            lines.append("")

    deliverables = result.deliverables()
    if deliverables:
        lines += ["## Deliverables", "", "| File | Type | Size |", "|---|---|---|"]
        for artifact in deliverables:
            lines.append(f"| `{artifact.name}` | {artifact.media_type} | {artifact.size} bytes |")
        lines.append("")

    failures = result.schedule.failed if result.schedule else []
    if failures:
        lines += ["## What did not work", ""]
        for outcome in failures:
            lines.append(
                f"### {outcome.step.name}\n\n"
                f"- Tool: `{outcome.step.tool}`\n"
                f"- Error: {outcome.error.message if outcome.error else 'unknown'}\n"
                f"- Recovery attempted: "
                f"{', '.join(r['action'] for r in outcome.recoveries) or 'none'}\n"
            )

    if result.needs_human:
        lines += ["## Needs your decision", ""] + [f"- {item}" for item in result.needs_human] + [""]

    used = result.budget.get("used", {})
    lines += [
        "## Resources",
        "",
        "| Metric | Used |",
        "|---|---|",
        f"| Steps | {used.get('steps', 0)} |",
        f"| Tool calls | {used.get('tool_calls', 0)} |",
        f"| Model calls | {used.get('model_calls', 0)} |",
        f"| Tokens | {used.get('input_tokens', 0)} in / {used.get('output_tokens', 0)} out |",
        f"| Cost | ${used.get('usd', 0):.4f} |",
        "",
        f"Full event ledger: `{result.ledger_path}`",
    ]
    return "\n".join(lines)


def to_html(result: RunResult) -> str:
    from ..tools.builtin.docs import _document_shell, markdown_to_html

    color, label = _STATUS_STYLE.get(result.status, ("#5b6270", result.status))
    banner = (
        f'<p style="display:inline-block;padding:.35rem .8rem;border-radius:999px;'
        f'background:{color};color:#fff;font-weight:600;font-size:.85rem">{html.escape(label)}</p>'
    )
    body = banner + markdown_to_html(to_markdown(result))
    return _document_shell(
        f"Run report — {result.goal[:60]}", body, f"{result.run_id} · {result.duration_s:.1f}s"
    )


def write(result: RunResult, directory: str | Path) -> dict[str, str]:
    """Write markdown, HTML and JSON reports. Returns the paths written."""
    target = Path(directory)
    target.mkdir(parents=True, exist_ok=True)
    stem = f"report-{result.run_id}"
    paths = {
        "markdown": target / f"{stem}.md",
        "html": target / f"{stem}.html",
        "json": target / f"{stem}.json",
    }
    paths["markdown"].write_text(to_markdown(result), encoding="utf-8")
    paths["html"].write_text(to_html(result), encoding="utf-8")
    paths["json"].write_text(
        json.dumps(result.to_dict(), indent=2, default=str), encoding="utf-8"
    )
    return {k: str(v) for k, v in paths.items()}


def replay_summary(ledger_path: str | Path) -> dict[str, Any]:
    """Reconstruct a run's shape from its ledger alone."""
    summary = Ledger.summarize(ledger_path)
    steps: dict[str, dict[str, Any]] = {}
    for event in Ledger.read(ledger_path):
        if not event.step_id:
            continue
        entry = steps.setdefault(
            event.step_id, {"name": event.data.get("name", ""), "events": 0, "state": "unknown"}
        )
        entry["events"] += 1
        if event.topic.startswith("step."):
            entry["state"] = event.topic.split(".", 1)[1]
            entry["name"] = event.data.get("name") or entry["name"]
    summary["steps"] = list(steps.values())
    return summary


__all__ = ["replay_summary", "to_html", "to_markdown", "write"]
