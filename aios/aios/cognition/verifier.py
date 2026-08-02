"""Verification.

The rule the whole system rests on: **a step that ran is not a step that
worked.** A tool can exit 0 having written an empty file, a build can succeed
into the wrong directory, a download can save a 404 page.

So every step carries a contract of :class:`Check` objects, and the executor
treats a failed contract exactly like a raised exception - it feeds the
recovery engine. Checks are cheap, deterministic and independent of the tool
that produced the output, which is what makes them meaningful evidence rather
than self-report.

An optional LLM rubric is available for qualities that genuinely cannot be
expressed programmatically, but it is never the only check on a step: it grades
what mechanical checks have already proven exists.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from ..foundation.errors import VerificationFailed
from ..foundation.logging import get_logger
from ..runtime.events import EventBus, Topic
from ..tools.base import ToolContext, ToolResult
from .plan import Check, Step

log = get_logger("cognition.verifier")


@dataclass(slots=True)
class CheckResult:
    kind: str
    target: str
    passed: bool
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "target": self.target, "passed": self.passed,
                "detail": self.detail}


class Verifier:
    def __init__(self, bus: EventBus | None = None) -> None:
        self.bus = bus

    async def verify(
        self, step: Step, result: ToolResult, ctx: ToolContext
    ) -> list[CheckResult]:
        """Run every contract. Raises :class:`VerificationFailed` on any miss."""
        checks = list(step.verify) or self.implicit(step, result)
        if not checks:
            return []

        if self.bus:
            await self.bus.publish(
                Topic.VERIFY_STARTED, {"step": step.name, "checks": len(checks)},
                run_id=ctx.run_id, step_id=step.id,
            )

        outcomes: list[CheckResult] = []
        for check in checks:
            try:
                outcome = await self._run_check(check, result, ctx)
            except Exception as exc:
                outcome = CheckResult(check.kind, check.target, False, f"check errored: {exc}")
            outcomes.append(outcome)

        failed = [o for o in outcomes if not o.passed]
        topic = Topic.VERIFY_FAILED if failed else Topic.VERIFY_PASSED
        if self.bus:
            await self.bus.publish(
                topic,
                {"step": step.name, "passed": len(outcomes) - len(failed),
                 "failed": [o.to_dict() for o in failed]},
                run_id=ctx.run_id, step_id=step.id,
            )
        if failed:
            raise VerificationFailed(
                f"{step.name}: {len(failed)} of {len(outcomes)} verification check(s) failed",
                checks=[o.to_dict() for o in outcomes],
                context={"failures": [f"{o.kind}({o.target}): {o.detail}" for o in failed]},
            )
        return outcomes

    @staticmethod
    def implicit(step: Step, result: ToolResult) -> list[Check]:
        """Default contract when a plan does not supply one.

        Derived from the tool's own arguments, so even an unverified plan gets
        a real check rather than none: a step that wrote a path must have
        produced that path.
        """
        checks: list[Check] = [Check("no_error", description="tool reported success")]
        for key in ("output", "destination", "path"):
            value = step.arguments.get(key)
            if isinstance(value, str) and value and not value.startswith("${"):
                if step.tool.split(".")[0] in {"fs", "doc", "media", "data", "code", "net"} and (
                    step.tool not in {"fs.read", "fs.list", "fs.search", "data.inspect"}
                ):
                    checks.append(Check("file_exists", value))
                break
        return checks

    async def _run_check(
        self, check: Check, result: ToolResult, ctx: ToolContext
    ) -> CheckResult:
        kind = check.kind
        target = str(check.target or "")

        if kind == "no_error":
            detail = "" if result.ok else (result.error.message if result.error else "failed")
            return CheckResult(kind, target, result.ok, detail)

        if kind == "artifact_produced":
            count = len(result.artifacts)
            return CheckResult(kind, target, count > 0, f"{count} artifact(s)")

        if kind == "exit_zero":
            code = (result.output or {}).get("exit_code") if isinstance(result.output, dict) else None
            return CheckResult(kind, target, code == 0, f"exit_code={code}")

        if kind == "output_contains":
            haystack = json.dumps(result.output, default=str) + " " + result.summary
            needle = str(check.expect or target)
            return CheckResult(kind, needle, needle.lower() in haystack.lower(),
                               "" if needle.lower() in haystack.lower() else "not present in result")

        if kind == "output_equals":
            actual = _dig(result.output, target)
            passed = actual == check.expect
            return CheckResult(kind, target, passed, f"got {actual!r}, expected {check.expect!r}")

        if kind in {"file_exists", "file_contains", "file_min_size", "json_parses", "dir_not_empty"}:
            return self._file_check(kind, check, ctx)

        if kind == "url_ok":
            return await self._url_check(target, ctx)

        if kind == "command_succeeds":
            return await self._command_check(target, ctx)

        return CheckResult(kind, target, True, f"unknown check kind {kind!r}; skipped")

    def _file_check(self, kind: str, check: Check, ctx: ToolContext) -> CheckResult:
        target = str(check.target)
        try:
            path = ctx.jail.resolve(target)
        except Exception as exc:
            return CheckResult(kind, target, False, f"path rejected: {exc}")

        if not path.exists():
            return CheckResult(kind, target, False, "does not exist")
        if kind == "file_exists":
            size = path.stat().st_size if path.is_file() else 0
            if path.is_file() and size == 0:
                return CheckResult(kind, target, False, "exists but is empty")
            return CheckResult(kind, target, True, f"{size} bytes")
        if kind == "dir_not_empty":
            if not path.is_dir():
                return CheckResult(kind, target, False, "not a directory")
            count = sum(1 for _ in path.iterdir())
            return CheckResult(kind, target, count > 0, f"{count} entries")
        if kind == "file_min_size":
            size = path.stat().st_size
            minimum = int(check.expect or 1)
            return CheckResult(kind, target, size >= minimum, f"{size} bytes (need {minimum})")
        if kind == "json_parses":
            try:
                json.loads(path.read_text("utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                return CheckResult(kind, target, False, str(exc)[:200])
            return CheckResult(kind, target, True, "valid JSON")
        if kind == "file_contains":
            expected = str(check.expect or "")
            try:
                text = path.read_text("utf-8", errors="replace")
            except OSError as exc:
                return CheckResult(kind, target, False, str(exc))
            if expected.startswith("/") and expected.endswith("/") and len(expected) > 2:
                found = bool(re.search(expected[1:-1], text))
            else:
                found = expected in text
            return CheckResult(kind, target, found,
                               "" if found else f"{expected[:60]!r} not found in {path.name}")
        return CheckResult(kind, target, True, "")  # pragma: no cover

    async def _url_check(self, url: str, ctx: ToolContext) -> CheckResult:
        import asyncio

        from ..tools.builtin.net import _request

        try:
            response = await asyncio.to_thread(
                _request, url, method="GET", timeout=15.0, max_bytes=65536,
                allowed_hosts=ctx.config.security.allowed_hosts,
            )
        except Exception as exc:
            return CheckResult("url_ok", url, False, str(exc)[:200])
        ok = response["status"] < 400
        return CheckResult("url_ok", url, ok, f"HTTP {response['status']}")

    async def _command_check(self, command: str, ctx: ToolContext) -> CheckResult:
        import asyncio

        from ..tools.builtin.shell import _build_env

        process = await asyncio.create_subprocess_shell(
            command, cwd=str(ctx.jail.root), env=_build_env(ctx, {}),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.DEVNULL, start_new_session=True,
        )
        try:
            out, _ = await asyncio.wait_for(process.communicate(), timeout=180)
        except TimeoutError:
            process.kill()
            await process.wait()
            return CheckResult("command_succeeds", command, False, "timed out after 180s")
        code = process.returncode or 0
        return CheckResult(
            "command_succeeds", command, code == 0,
            f"exit {code}: {out.decode('utf-8', 'replace')[-400:]}",
        )


def _dig(payload: Any, path: str) -> Any:
    current = payload
    for part in (path or "").split("."):
        if not part:
            continue
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list | tuple) and part.isdigit():
            index = int(part)
            current = current[index] if index < len(current) else None
        else:
            return None
    return current
