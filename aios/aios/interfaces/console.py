"""Live console rendering.

A subscriber on the event bus, nothing more - which is the point. The kernel
has no idea a terminal exists, and swapping this for a web UI is one
subscription.

The user must always know what is happening, so the renderer shows work
starting, not just finishing (a 90-second build should not look like a hang),
names the tool doing it, and reports recovery attempts explicitly rather than
hiding them: "retrying after a timeout" is reassuring, silence is not.
"""

from __future__ import annotations

import shutil
import sys
from typing import Any, TextIO

from ..runtime.events import Event, EventBus

RESET = "\x1b[0m"
DIM = "\x1b[38;5;244m"
BOLD = "\x1b[1m"
GREEN = "\x1b[38;5;41m"
RED = "\x1b[38;5;203m"
YELLOW = "\x1b[38;5;214m"
BLUE = "\x1b[38;5;39m"
PURPLE = "\x1b[38;5;141m"


class ConsoleRenderer:
    def __init__(
        self,
        bus: EventBus,
        *,
        stream: TextIO | None = None,
        verbose: bool = False,
        color: bool | None = None,
    ) -> None:
        self.out = stream or sys.stderr
        self.verbose = verbose
        self.color = (
            color if color is not None else bool(getattr(self.out, "isatty", lambda: False)())
        )
        self.width = shutil.get_terminal_size((100, 24)).columns
        self.started: dict[str, str] = {}
        bus.subscribe("*", self._on_event)

    # -- formatting ------------------------------------------------------
    def _c(self, text: str, code: str) -> str:
        return f"{code}{text}{RESET}" if self.color else text

    def _write(self, line: str) -> None:
        self.out.write(line + "\n")
        self.out.flush()

    def _clip(self, text: str, reserve: int = 22) -> str:
        limit = max(24, self.width - reserve)
        text = " ".join(str(text).split())
        return text if len(text) <= limit else text[: limit - 1] + "…"

    # -- event handling --------------------------------------------------
    def _on_event(self, event: Event) -> None:
        handler = getattr(self, "_on_" + event.topic.replace(".", "_"), None)
        if handler is not None:
            handler(event.data)
        elif self.verbose:
            self._write(self._c(f"  · {event.topic} {self._clip(event.data)}", DIM))

    def _on_run_started(self, data: dict[str, Any]) -> None:
        self._write("")
        self._write(self._c("▌ " + self._clip(data.get("goal", ""), 4), BOLD))
        self._write(
            self._c(
                f"  workspace {data.get('workspace')} · {data.get('security_mode')} mode · "
                f"model {data.get('model')}" + (" · DRY RUN" if data.get("dry_run") else ""),
                DIM,
            )
        )

    def _on_run_understood(self, data: dict[str, Any]) -> None:
        intent = data.get("intent") or {}
        self._write(
            self._c(
                f"  understood: {intent.get('domain')} / {intent.get('complexity')} → "
                + self._clip(
                    ", ".join(intent.get("deliverables") or []) or "no explicit deliverable", 30
                ),
                DIM,
            )
        )

    def _on_run_planned(self, data: dict[str, Any]) -> None:
        self._write(
            self._c(
                f"  plan: {data.get('steps')} steps in {data.get('waves')} parallel wave(s) "
                f"({data.get('origin')})",
                BLUE,
            )
        )
        plan = data.get("plan") or {}
        if plan.get("strategy") and self.verbose:
            self._write(self._c("  " + self._clip(plan["strategy"], 4), DIM))
        self._write("")

    def _on_run_replanned(self, data: dict[str, Any]) -> None:
        self._write(
            self._c(
                f"  ↻ replanning (round {data.get('round')}): {data.get('new_steps')} new step(s)",
                PURPLE,
            )
        )

    def _on_step_started(self, data: dict[str, Any]) -> None:
        name = data.get("name", "step")
        self._write(
            f"  {self._c('▸', BLUE)} {self._clip(name, 30)} "
            + self._c(f"[{data.get('tool')}]", DIM)
        )

    def _on_step_progress(self, data: dict[str, Any]) -> None:
        if self.verbose:
            self._write(self._c(f"      {self._clip(data.get('message', ''), 8)}", DIM))

    def _on_step_succeeded(self, data: dict[str, Any]) -> None:
        detail = data.get("summary") or ""
        self._write(
            f"  {self._c('✔', GREEN)} {self._clip(data.get('name', ''), 40)} "
            + self._c(f"{data.get('duration_s', 0):.1f}s", DIM)
            + (self._c(f"  {self._clip(detail, 50)}", DIM) if detail else "")
        )

    def _on_step_failed(self, data: dict[str, Any]) -> None:
        error = (data.get("error") or {}).get("message", "failed")
        self._write(
            f"  {self._c('✘', RED)} {self._clip(data.get('name', ''), 40)} "
            + self._c(self._clip(error, 46), RED)
        )

    def _on_step_skipped(self, data: dict[str, Any]) -> None:
        self._write(f"  {self._c('–', DIM)} {self._c(self._clip(data.get('name', '')), DIM)}")

    def _on_step_blocked(self, data: dict[str, Any]) -> None:
        self._write(
            self._c(
                f"  ⊘ {self._clip(data.get('name', ''), 40)} blocked by {data.get('blocked_by')}",
                DIM,
            )
        )

    def _on_step_retrying(self, data: dict[str, Any]) -> None:
        self._write(
            self._c(
                f"      ↻ retry {data.get('attempt')} in {data.get('delay_s')}s "
                f"— {self._clip(data.get('reason', ''), 20)}",
                YELLOW,
            )
        )

    def _on_recovery_attempt(self, data: dict[str, Any]) -> None:
        if data.get("action") == "retry":
            return  # already announced by step.retrying
        self._write(
            self._c(f"      ⚑ {data.get('action')}: {self._clip(data.get('reason', ''), 20)}", YELLOW)
        )

    def _on_verify_failed(self, data: dict[str, Any]) -> None:
        for failure in (data.get("failed") or [])[:3]:
            self._write(
                self._c(
                    f"      ✘ check {failure.get('kind')}({failure.get('target')}): "
                    f"{self._clip(failure.get('detail', ''), 24)}",
                    RED,
                )
            )

    def _on_approval_requested(self, data: dict[str, Any]) -> None:
        self._write(
            self._c(f"      ⚠ approval needed: {self._clip(data.get('summary', ''), 24)}", YELLOW)
        )

    def _on_policy_blocked(self, data: dict[str, Any]) -> None:
        self._write(
            self._c(f"      ⛔ blocked by policy ({data.get('rule')}): {data.get('reason')}", RED)
        )

    def _on_budget_warning(self, data: dict[str, Any]) -> None:
        self._write(self._c(f"      ⚠ budget: {data.get('limit')} is at 80%", YELLOW))

    def _on_budget_exceeded(self, data: dict[str, Any]) -> None:
        self._write(self._c(f"  ⛔ budget exhausted: {data.get('reason')}", RED))

    def _on_artifact_created(self, data: dict[str, Any]) -> None:
        if self.verbose:
            self._write(self._c(f"      + {data.get('name')} ({data.get('size')} bytes)", DIM))

    def _on_run_completed(self, data: dict[str, Any]) -> None:
        status = data.get("status", "?")
        color = {"succeeded": GREEN, "partial": YELLOW}.get(status, RED)
        budget = data.get("budget") or {}
        self._write("")
        self._write(
            self._c(f"▌ {status.upper()}", color)
            + self._c(
                f"  {budget.get('elapsed_s', 0):.1f}s · {budget.get('steps', 0)} steps · "
                f"{budget.get('model_calls', 0)} model calls · ${budget.get('usd', 0):.4f}",
                DIM,
            )
        )

    def _on_run_failed(self, data: dict[str, Any]) -> None:
        if "status" in data:
            self._on_run_completed(data)
            return
        error = (data.get("error") or {}).get("message", "unknown error")
        self._write("")
        self._write(self._c(f"▌ FAILED  {self._clip(error, 12)}", RED))

    def _on_run_cancelled(self, data: dict[str, Any]) -> None:
        self._write("")
        self._write(self._c("▌ CANCELLED", YELLOW))
