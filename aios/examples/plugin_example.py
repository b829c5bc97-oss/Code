"""A complete AIOS plugin: a tool plus a policy rule.

Drop this file into a directory listed in ``plugin_paths``:

    # aios.toml
    plugin_paths = ["examples"]

Then confirm it loaded with the authority you expect::

    aios tools --tag example --json
"""

from __future__ import annotations

import hashlib
from typing import Any

from aios.security import capabilities as caps
from aios.security.capabilities import RiskLevel
from aios.security.policy import ActionRequest, Decision, Verdict
from aios.tools.base import Tool, ToolContext, ToolResult


class Checksum(Tool):
    """Hash a file. About the smallest useful tool there is."""

    name = "example.checksum"
    summary = "Compute the SHA-256 checksum of a file in the workspace."
    tags = ("example", "filesystem", "read", "inspect")

    capabilities = frozenset({caps.FS_READ})
    risk = RiskLevel.SAFE

    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "algorithm": {"type": "string", "enum": ["sha256", "sha1", "md5"],
                          "default": "sha256"},
        },
        "required": ["path"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        # Surfacing the path is what lets the jail rule do its job.
        action = super().plan_action(args)
        action.paths = [str(args.get("path", ""))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        path = ctx.jail.resolve(args["path"], must_exist=True)
        algorithm = args.get("algorithm", "sha256")
        hasher = hashlib.new(algorithm)
        with path.open("rb") as fh:
            while chunk := fh.read(1024 * 1024):
                hasher.update(chunk)
        digest = hasher.hexdigest()
        return ToolResult.success(
            {"path": ctx.jail.relative(path), "algorithm": algorithm,
             "digest": digest, "bytes": path.stat().st_size},
            summary=f"{algorithm}({path.name}) = {digest[:16]}…",
        )


def no_touching_the_lockfile(engine, request: ActionRequest) -> Decision | None:
    """House rule: dependency lockfiles are changed by humans, not by agents."""
    locked = ("package-lock.json", "poetry.lock", "Cargo.lock", "uv.lock")
    if any(p.endswith(locked) for p in request.paths) and caps.FS_WRITE in request.capabilities:
        return Decision(
            Verdict.CONFIRM,
            "lockfile_guard",
            "editing a dependency lockfile needs a human decision",
            RiskLevel.HIGH,
        )
    return None


def tools() -> list[Tool]:
    return [Checksum()]


def policy_rules() -> list:
    return [no_touching_the_lockfile]
