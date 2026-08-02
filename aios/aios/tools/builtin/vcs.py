"""Git tools.

Version control is the agent's undo button, so these are treated as first-class
rather than "just shell commands":

- ``git.checkpoint`` commits the working tree to a scratch branch before a risky
  step, which is what lets recovery roll back a bad edit instead of trying to
  reason its way out of it;
- ``git.push`` is the only tool here holding ``publish``, because pushing is the
  moment work leaves the machine and therefore always involves a person;
- arguments are passed as an argv list, never interpolated into a shell string,
  so a branch name can never become a command.
"""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path
from typing import Any

from ...foundation.errors import InvalidArguments, ToolExecutionError
from ...security import capabilities as caps
from ...security.capabilities import RiskLevel
from ...security.policy import ActionRequest
from ..base import Tool, ToolContext, ToolResult


async def _git(argv: list[str], cwd: Path, *, timeout: float = 120.0) -> tuple[int, str, str]:
    binary = shutil.which("git")
    if not binary:
        raise ToolExecutionError("git is not installed or not on PATH")
    process = await asyncio.create_subprocess_exec(
        binary, *argv,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
        # Minimal environment: no credentials leak into git, and no interactive
        # prompt can hang the step waiting for input nobody is there to give.
        env={
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_PAGER": "cat",
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": os.environ.get("HOME", ""),
        },
    )
    out, err = await asyncio.wait_for(process.communicate(), timeout=timeout)
    return (
        process.returncode or 0,
        out.decode("utf-8", "replace"),
        err.decode("utf-8", "replace"),
    )


class GitBase(Tool):
    tags = ("git", "vcs", "code")
    capabilities = frozenset({caps.PROCESS_SPAWN, caps.FS_READ})
    risk = RiskLevel.SAFE

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", "."))]
        return action

    @staticmethod
    async def _repo(args: dict[str, Any], ctx: ToolContext) -> Path:
        root = ctx.jail.resolve(args.get("path", "."), must_exist=True)
        code, out, _ = await _git(["rev-parse", "--show-toplevel"], root)
        if code != 0:
            raise InvalidArguments(f"{ctx.jail.relative(root)} is not inside a git repository")
        return Path(out.strip())


class GitStatus(GitBase):
    name = "git.status"
    summary = "Show branch, upstream state and working-tree changes."
    tags = ("git", "vcs", "code", "read", "inspect")
    parameters = {
        "type": "object",
        "properties": {"path": {"type": "string", "default": "."}},
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        repo = await self._repo(args, ctx)
        _, porcelain, _ = await _git(["status", "--porcelain=v1", "--branch"], repo)
        lines = porcelain.splitlines()
        branch_line = lines[0][3:] if lines and lines[0].startswith("##") else ""
        changes = []
        for line in lines[1:]:
            if len(line) > 3:
                changes.append({"status": line[:2].strip(), "path": line[3:]})
        _, head, _ = await _git(["rev-parse", "--short", "HEAD"], repo)
        return ToolResult.success(
            {
                "repo": str(repo),
                "branch": branch_line.split("...")[0].strip(),
                "upstream": branch_line.split("...")[1].split()[0] if "..." in branch_line else None,
                "head": head.strip(),
                "changes": changes,
                "clean": not changes,
            },
            summary=(
                f"{branch_line.split('...')[0].strip() or 'detached'}: "
                f"{len(changes)} change(s)" + ("" if changes else " (clean)")
            ),
        )


class GitDiff(GitBase):
    name = "git.diff"
    summary = "Show the diff of working-tree, staged or committed changes."
    tags = ("git", "vcs", "code", "read", "inspect")
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "default": "."},
            "staged": {"type": "boolean", "default": False},
            "ref": {"type": "string", "description": "Diff against this ref instead."},
            "max_chars": {"type": "integer", "minimum": 500, "default": 60000},
            "stat_only": {"type": "boolean", "default": False},
        },
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        repo = await self._repo(args, ctx)
        argv = ["diff"]
        if args.get("staged"):
            argv.append("--cached")
        if args.get("ref"):
            argv.append(str(args["ref"]))
        if args.get("stat_only"):
            argv.append("--stat")
        code, out, err = await _git(argv, repo, timeout=180)
        if code != 0:
            raise ToolExecutionError(f"git diff failed: {err.strip()[:400]}")
        limit = int(args.get("max_chars", 60000))
        stat_argv = [a for a in argv if a != "--stat"] + ["--stat"]
        _, stat, _ = await _git(stat_argv, repo)
        return ToolResult.success(
            {"diff": out[:limit], "truncated": len(out) > limit, "stat": stat[-4000:],
             "empty": not out.strip()},
            summary=(stat.strip().splitlines() or ["no changes"])[-1][:160],
        )


class GitLog(GitBase):
    name = "git.log"
    summary = "List recent commits."
    tags = ("git", "vcs", "code", "read", "inspect")
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "default": "."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 500, "default": 20},
            "file": {"type": "string"},
        },
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        repo = await self._repo(args, ctx)
        argv = ["log", f"-{int(args.get('limit', 20))}",
                "--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s"]
        if args.get("file"):
            argv += ["--", str(args["file"])]
        code, out, err = await _git(argv, repo)
        if code != 0:
            raise ToolExecutionError(f"git log failed: {err.strip()[:300]}")
        commits = []
        for line in out.splitlines():
            parts = line.split("\x1f")
            if len(parts) == 5:
                commits.append(dict(zip(
                    ["sha", "short", "author", "date", "subject"], parts, strict=True
                )))
        return ToolResult.success(
            {"commits": commits, "count": len(commits)},
            summary=f"{len(commits)} commit(s)",
        )


class GitCommit(GitBase):
    name = "git.commit"
    summary = "Stage paths and create a commit."
    tags = ("git", "vcs", "code", "write")
    capabilities = frozenset({caps.PROCESS_SPAWN, caps.FS_WRITE})
    risk = RiskLevel.LOW
    idempotent = False
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "default": "."},
            "message": {"type": "string", "minLength": 3},
            "paths": {"type": "array", "items": {"type": "string"}, "default": ["-A"]},
            "allow_empty": {"type": "boolean", "default": False},
        },
        "required": ["message"],
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        repo = await self._repo(args, ctx)
        targets = args.get("paths") or ["-A"]
        code, _, err = await _git(["add", *[str(t) for t in targets]], repo)
        if code != 0:
            raise ToolExecutionError(f"git add failed: {err.strip()[:400]}")
        argv = ["commit", "-m", args["message"]]
        if args.get("allow_empty"):
            argv.append("--allow-empty")
        code, out, err = await _git(argv, repo)
        if code != 0:
            if "nothing to commit" in (out + err).lower():
                return ToolResult.success(
                    {"committed": False, "reason": "nothing to commit"},
                    summary="nothing to commit; working tree clean",
                )
            raise ToolExecutionError(f"git commit failed: {(err or out).strip()[:400]}")
        _, sha, _ = await _git(["rev-parse", "--short", "HEAD"], repo)
        return ToolResult.success(
            {"committed": True, "sha": sha.strip(), "message": args["message"]},
            summary=f"committed {sha.strip()}: {args['message'][:80]}",
        )


class GitBranch(GitBase):
    name = "git.branch"
    summary = "List, create or switch branches."
    tags = ("git", "vcs", "code", "write")
    capabilities = frozenset({caps.PROCESS_SPAWN, caps.FS_WRITE})
    risk = RiskLevel.LOW
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "default": "."},
            "action": {"type": "string", "enum": ["list", "create", "switch"], "default": "list"},
            "name": {"type": "string"},
        },
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        repo = await self._repo(args, ctx)
        action = args.get("action", "list")
        if action == "list":
            _, out, _ = await _git(["branch", "--format=%(refname:short)%09%(HEAD)"], repo)
            branches = []
            current = None
            for line in out.splitlines():
                name, _, marker = line.partition("\t")
                branches.append(name)
                if marker.strip() == "*":
                    current = name
            return ToolResult.success(
                {"branches": branches, "current": current},
                summary=f"{len(branches)} branch(es), on {current}",
            )
        name = str(args.get("name") or "").strip()
        if not name:
            raise InvalidArguments("`name` is required for create/switch")
        argv = ["checkout", "-b", name] if action == "create" else ["checkout", name]
        code, out, err = await _git(argv, repo)
        if code != 0:
            raise ToolExecutionError(f"git {action} failed: {(err or out).strip()[:400]}")
        return ToolResult.success({"branch": name, "action": action}, summary=f"{action}ed {name}")


class GitCheckpoint(GitBase):
    """Snapshot the working tree so a risky step is undoable."""

    name = "git.checkpoint"
    summary = "Snapshot the current working tree as a recoverable git stash entry."
    tags = ("git", "vcs", "code", "write", "safety")
    capabilities = frozenset({caps.PROCESS_SPAWN, caps.FS_WRITE})
    risk = RiskLevel.LOW
    idempotent = False
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "default": "."},
            "label": {"type": "string", "default": "aios checkpoint"},
            "restore": {"type": "string",
                        "description": "Stash ref to restore, e.g. 'stash@{0}'."},
        },
        "additionalProperties": False,
    }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        repo = await self._repo(args, ctx)
        if args.get("restore"):
            code, out, err = await _git(["stash", "apply", str(args["restore"])], repo)
            if code != 0:
                raise ToolExecutionError(f"restore failed: {(err or out).strip()[:400]}")
            return ToolResult.success(
                {"restored": args["restore"]}, summary=f"restored {args['restore']}"
            )
        label = f"{args.get('label', 'aios checkpoint')} [{ctx.run_id or 'adhoc'}]"
        code, out, err = await _git(
            ["stash", "push", "--include-untracked", "-m", label], repo, timeout=180
        )
        if "No local changes" in out + err:
            return ToolResult.success(
                {"checkpointed": False, "reason": "no local changes"},
                summary="nothing to checkpoint (tree already clean)",
            )
        if code != 0:
            raise ToolExecutionError(f"checkpoint failed: {(err or out).strip()[:400]}")
        # A stash pops the changes off the tree; put them straight back so the
        # snapshot is a safety net rather than a disruption.
        await _git(["stash", "apply", "stash@{0}"], repo)
        return ToolResult.success(
            {"checkpointed": True, "ref": "stash@{0}", "label": label},
            summary=f"checkpointed working tree as stash@{{0}} ({label})",
        )


class GitPush(GitBase):
    """Publish commits to a remote - the point of no return, so it is gated."""

    name = "git.push"
    summary = "Push commits to a remote repository."
    tags = ("git", "vcs", "code", "publish", "deploy")
    capabilities = frozenset({caps.PROCESS_SPAWN, caps.NET_WRITE, caps.PUBLISH})
    risk = RiskLevel.HIGH
    reversible = False
    idempotent = False
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "default": "."},
            "remote": {"type": "string", "default": "origin"},
            "branch": {"type": "string"},
            "set_upstream": {"type": "boolean", "default": True},
        },
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.reversible = False
        action.risk = RiskLevel.HIGH
        action.summary = (
            f"push to {args.get('remote', 'origin')}/{args.get('branch', '<current>')}"
        )
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        repo = await self._repo(args, ctx)
        branch = args.get("branch")
        if not branch:
            _, out, _ = await _git(["rev-parse", "--abbrev-ref", "HEAD"], repo)
            branch = out.strip()
        argv = ["push"]
        if args.get("set_upstream", True):
            argv.append("-u")
        argv += [str(args.get("remote", "origin")), str(branch)]
        code, out, err = await _git(argv, repo, timeout=300)
        if code != 0:
            raise ToolExecutionError(
                f"git push failed: {(err or out).strip()[:600]}",
                context={"remote": args.get("remote", "origin"), "branch": branch},
            )
        return ToolResult.success(
            {"remote": args.get("remote", "origin"), "branch": branch,
             "output": (out + err).strip()[-1500:]},
            summary=f"pushed {branch} to {args.get('remote', 'origin')}",
        )


def tools() -> list[Tool]:
    return [
        GitStatus(), GitDiff(), GitLog(), GitCommit(),
        GitBranch(), GitCheckpoint(), GitPush(),
    ]


__all__ = ["tools"]
