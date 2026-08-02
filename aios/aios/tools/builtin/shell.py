"""Process execution.

The most powerful and most dangerous tool in the box, so it is also the most
constrained one:

- the working directory is jailed;
- the child environment is scrubbed of credentials by default, with an explicit
  allowlist for the variables a build actually needs;
- output is capped and streamed, so a runaway process cannot exhaust memory and
  a long build still reports progress;
- the process group is killed on timeout, so an orphaned child cannot outlive
  the step that spawned it.

Static risk analysis happens earlier, in the policy engine, which is what turns
``rm -rf /`` into a refusal instead of an incident.
"""

from __future__ import annotations

import asyncio
import os
import platform
import shutil
import signal
import sys
from typing import Any

from ...foundation.errors import InvalidArguments, ToolExecutionError, ToolTimeout
from ...security import capabilities as caps
from ...security.capabilities import RiskLevel
from ...security.policy import ActionRequest
from ...security.sandbox import analyse_command
from ..base import Tool, ToolContext, ToolResult

_TAIL_LINES = 60


class RunCommand(Tool):
    """Run a shell command inside the workspace."""

    name = "shell.run"
    summary = "Execute a shell command in the workspace and capture its output."
    tags = ("shell", "execute", "build", "system")
    capabilities = frozenset({caps.SHELL_EXEC, caps.PROCESS_SPAWN})
    risk = RiskLevel.MODERATE
    idempotent = False
    default_timeout = 900.0
    parameters = {
        "type": "object",
        "properties": {
            "command": {"type": "string", "minLength": 1},
            "cwd": {"type": "string", "default": "."},
            "timeout": {"type": "number", "minimum": 1, "default": 600},
            "env": {"type": "object", "description": "Extra environment variables."},
            "expect_success": {"type": "boolean", "default": True,
                               "description": "Treat a non-zero exit code as a failure."},
            "stdin": {"type": "string"},
        },
        "required": ["command"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        command = str(args.get("command", ""))
        analysis = analyse_command(command)
        return ActionRequest(
            tool=self.name,
            arguments=args,
            capabilities=self.capabilities,
            risk=RiskLevel.HIGH if analysis.destructive else RiskLevel.MODERATE,
            reversible=not analysis.destructive,
            summary=f"run: {command[:200]}",
            command=command,
            paths=[str(args.get("cwd", "."))],
        )

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        command: str = args["command"]
        cwd = ctx.jail.resolve(args.get("cwd", "."), must_exist=True)
        if not cwd.is_dir():
            raise InvalidArguments(f"cwd is not a directory: {args.get('cwd')}")

        timeout = float(args.get("timeout", 600))
        remaining = ctx.remaining_seconds()
        if remaining > 0:
            timeout = min(timeout, remaining)

        env = _build_env(ctx, args.get("env") or {})
        cap = ctx.config.security.max_output_bytes

        process = await asyncio.create_subprocess_shell(
            command,
            cwd=str(cwd),
            env=env,
            stdin=asyncio.subprocess.PIPE if args.get("stdin") else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            # New session so a timeout can kill the whole tree, not just the shell.
            start_new_session=True,
        )

        if args.get("stdin") and process.stdin:
            process.stdin.write(str(args["stdin"]).encode())
            await process.stdin.drain()
            process.stdin.close()

        stdout_buf: list[bytes] = []
        stderr_buf: list[bytes] = []
        try:
            await asyncio.wait_for(
                asyncio.gather(
                    _pump(process.stdout, stdout_buf, cap, ctx, "stdout"),
                    _pump(process.stderr, stderr_buf, cap, ctx, "stderr"),
                    process.wait(),
                ),
                timeout=timeout,
            )
        except TimeoutError as exc:
            _terminate(process)
            stdout = b"".join(stdout_buf).decode("utf-8", "replace")
            stderr = b"".join(stderr_buf).decode("utf-8", "replace")
            raise ToolTimeout(
                f"command exceeded {timeout:.0f}s and was terminated",
                context={"command": command[:200], "stdout_tail": _tail(stdout),
                         "stderr_tail": _tail(stderr)},
                cause=exc,
            ) from exc

        stdout = b"".join(stdout_buf).decode("utf-8", "replace")
        stderr = b"".join(stderr_buf).decode("utf-8", "replace")
        code = process.returncode if process.returncode is not None else -1
        payload = {
            "command": command,
            "cwd": ctx.jail.relative(cwd),
            "exit_code": code,
            "stdout": stdout,
            "stderr": stderr,
            "truncated": sum(len(c) for c in stdout_buf) >= cap,
        }

        if code != 0 and args.get("expect_success", True):
            return ToolResult.failure(
                ToolExecutionError(
                    f"command exited with status {code}",
                    context={"command": command[:200], "exit_code": code,
                             "stderr_tail": _tail(stderr), "stdout_tail": _tail(stdout)},
                ),
                summary=f"exit {code}: {command[:80]}",
                metrics={"exit_code": code},
            )
        return ToolResult.success(
            payload,
            summary=f"exit {code}: {command[:80]}",
            metrics={"exit_code": code, "stdout_bytes": len(stdout), "stderr_bytes": len(stderr)},
        )


async def _pump(
    stream: asyncio.StreamReader | None,
    sink: list[bytes],
    cap: int,
    ctx: ToolContext,
    channel: str,
) -> None:
    """Read a stream to EOF, capping retained bytes and emitting progress."""
    if stream is None:
        return
    total = 0
    lines_seen = 0
    while True:
        try:
            chunk = await stream.readline()
        except (ValueError, asyncio.LimitOverrunError):
            # A single absurdly long line; drain it in fixed blocks instead.
            chunk = await stream.read(65536)
        if not chunk:
            break
        lines_seen += 1
        if total < cap:
            sink.append(chunk[: max(0, cap - total)])
        total += len(chunk)
        if lines_seen % 50 == 0:
            await ctx.progress(
                f"{channel}: {lines_seen} lines", channel=channel, bytes=total
            )


def _terminate(process: asyncio.subprocess.Process) -> None:
    """Kill the whole process group; a shell's children must not survive it."""
    if process.returncode is not None:
        return
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            process.terminate()
        except ProcessLookupError:  # pragma: no cover
            return
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):  # pragma: no cover
        pass


def _build_env(ctx: ToolContext, extra: dict[str, Any]) -> dict[str, str]:
    from ...foundation.redaction import scrub_env

    base = scrub_env(dict(os.environ), allow=ctx.config.security.subprocess_env_allowlist)
    base.setdefault("PATH", os.defpath)
    base["AIOS_RUN_ID"] = ctx.run_id or ""
    base["AIOS_WORKSPACE"] = str(ctx.jail.root)
    # Keep child processes from opening interactive pagers/prompts that would hang.
    base.setdefault("GIT_TERMINAL_PROMPT", "0")
    base.setdefault("DEBIAN_FRONTEND", "noninteractive")
    base.setdefault("PAGER", "cat")
    base.setdefault("CI", "1")
    base.update({str(k): str(v) for k, v in extra.items()})
    return base


def _tail(text: str, lines: int = _TAIL_LINES) -> str:
    parts = text.splitlines()
    return "\n".join(parts[-lines:])


class WhichTool(Tool):
    name = "shell.which"
    summary = "Check whether executables are available on PATH, with versions."
    tags = ("shell", "system", "inspect", "read")
    capabilities = frozenset({caps.PROCESS_SPAWN})
    risk = RiskLevel.SAFE
    default_timeout = 60.0
    parameters = {
        "type": "object",
        "properties": {
            "binaries": {"type": "array", "items": {"type": "string"}, "minItems": 1},
        },
        "required": ["binaries"],
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        found: dict[str, Any] = {}
        for binary in args["binaries"]:
            name = str(binary).strip()
            if not name or not name.replace("-", "").replace("_", "").replace(".", "").isalnum():
                found[name] = {"available": False, "reason": "invalid binary name"}
                continue
            path = shutil.which(name)
            entry: dict[str, Any] = {"available": bool(path), "path": path}
            if path:
                entry["version"] = await _probe_version(path)
            found[name] = entry
        available = [k for k, v in found.items() if v["available"]]
        return ToolResult.success(
            {"binaries": found, "available": available,
             "missing": [k for k in found if k not in available]},
            summary=f"{len(available)}/{len(found)} available",
        )


async def _probe_version(path: str) -> str:
    for flag in ("--version", "-version", "-V"):
        try:
            process = await asyncio.create_subprocess_exec(
                path, flag,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                stdin=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(process.communicate(), timeout=10)
        except (TimeoutError, OSError):
            continue
        if process.returncode == 0 and out:
            return out.decode("utf-8", "replace").splitlines()[0][:120]
    return ""


class SystemInfo(Tool):
    name = "sys.info"
    summary = "Report OS, CPU, memory, disk and runtime versions."
    tags = ("system", "inspect", "read", "maintenance")
    capabilities = frozenset()
    risk = RiskLevel.SAFE
    default_timeout = 30.0
    parameters = {"type": "object", "properties": {}, "additionalProperties": False}

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        info: dict[str, Any] = {
            "platform": platform.platform(),
            "system": platform.system(),
            "machine": platform.machine(),
            "python": sys.version.split()[0],
            "cpu_count": os.cpu_count(),
        }
        try:
            usage = shutil.disk_usage(ctx.jail.root)
            info["disk"] = {
                "total_gb": round(usage.total / 1e9, 2),
                "free_gb": round(usage.free / 1e9, 2),
                "used_pct": round(100 * usage.used / usage.total, 1) if usage.total else 0,
            }
        except OSError:  # pragma: no cover
            pass
        if hasattr(os, "getloadavg"):
            try:
                info["load_average"] = [round(v, 2) for v in os.getloadavg()]
            except OSError:  # pragma: no cover
                pass
        info["memory"] = _read_memory()
        return ToolResult.success(
            info,
            summary=f"{info['system']} {info['machine']}, "
            f"{info.get('cpu_count', '?')} cpus, "
            f"{info.get('disk', {}).get('free_gb', '?')} GB free",
        )


def _read_memory() -> dict[str, Any]:
    """Linux /proc/meminfo; other platforms report what they can."""
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            fields = {}
            for line in fh:
                key, _, rest = line.partition(":")
                value = rest.strip().split()
                if value and value[0].isdigit():
                    fields[key] = int(value[0])
        total = fields.get("MemTotal", 0) / 1e6
        available = fields.get("MemAvailable", 0) / 1e6
        return {"total_gb": round(total, 2), "available_gb": round(available, 2)}
    except OSError:
        return {}


class KillProcess(Tool):
    name = "sys.kill"
    summary = "Terminate a process by pid."
    tags = ("system", "process")
    capabilities = frozenset({caps.PROCESS_SPAWN, caps.SYSTEM_CONFIG})
    risk = RiskLevel.HIGH
    reversible = False
    idempotent = False
    parameters = {
        "type": "object",
        "properties": {
            "pid": {"type": "integer", "minimum": 2},
            "force": {"type": "boolean", "default": False},
        },
        "required": ["pid"],
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        pid = int(args["pid"])
        if pid in (os.getpid(), os.getppid()):
            raise InvalidArguments("refusing to kill the agent's own process")
        sig = signal.SIGKILL if args.get("force") else signal.SIGTERM
        try:
            os.kill(pid, sig)
        except ProcessLookupError as exc:
            raise InvalidArguments(f"no such process: {pid}", cause=exc) from exc
        return ToolResult.success(
            {"pid": pid, "signal": sig.name}, summary=f"sent {sig.name} to {pid}"
        )


def tools() -> list[Tool]:
    return [RunCommand(), WhichTool(), SystemInfo(), KillProcess()]


__all__ = ["tools"]
