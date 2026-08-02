"""Filesystem jail and command guard.

Path containment is the single most common place agent sandboxes leak, usually
through one of:

- ``..`` traversal in a user-supplied relative path,
- a symlink inside the workspace pointing out of it,
- a path that does not exist yet, so ``resolve()`` cannot be trusted naively,
- prefix confusion (``/work`` vs ``/work-secrets``).

:class:`PathJail` handles all four. Every builtin tool routes its paths through
it; a tool that wants out must hold ``fs.outside_workspace``.
"""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass
from pathlib import Path

from ..foundation.errors import InvalidArguments, SandboxViolation

# Directories that are never writable even inside a workspace that contains them.
_ALWAYS_PROTECTED = ("/etc", "/bin", "/sbin", "/usr", "/boot", "/dev", "/proc", "/sys", "/var/lib")

# Shell fragments that are destructive enough to always require a decision.
_DESTRUCTIVE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("recursive_root_delete", re.compile(r"\brm\s+(-[a-zA-Z]*\s+)*-?[rR][a-zA-Z]*f?\s+/(\s|$)")),
    ("recursive_delete", re.compile(r"\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR]")),
    ("force_git_push", re.compile(r"\bgit\s+push\b[^\n|;]*(--force\b|(?<!-)-f\b)")),
    ("git_reset_hard", re.compile(r"\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*[fdx])")),
    ("disk_write", re.compile(r"\b(dd|mkfs(\.\w+)?|fdisk|parted|shred)\b")),
    ("perm_root", re.compile(r"\b(chmod|chown)\b[^\n|;]*\s/(\s|$)")),
    ("privilege", re.compile(r"\b(sudo|doas|su)\b")),
    ("power", re.compile(r"\b(shutdown|reboot|halt|poweroff)\b")),
    ("curl_pipe_shell", re.compile(r"\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|k|)sh\b")),
    ("history_rewrite", re.compile(r"\bgit\s+(filter-branch|filter-repo)\b")),
    ("fork_bomb", re.compile(r":\(\)\s*\{.*\|.*&.*\}\s*;?\s*:")),
)


@dataclass(frozen=True, slots=True)
class CommandRisk:
    destructive: bool
    reasons: tuple[str, ...]
    binaries: tuple[str, ...]


class PathJail:
    """Confines path access to ``root`` (plus explicitly allowed extra roots)."""

    def __init__(self, root: str | Path, *, extra_roots: list[str | Path] | None = None) -> None:
        self.root = Path(root).expanduser().resolve()
        self.extra_roots = [Path(p).expanduser().resolve() for p in (extra_roots or [])]

    @property
    def roots(self) -> list[Path]:
        return [self.root, *self.extra_roots]

    def contains(self, path: str | Path) -> bool:
        try:
            resolved = self._resolve(path)
        except SandboxViolation:
            return False
        return any(_is_within(resolved, root) for root in self.roots)

    def resolve(self, path: str | Path, *, must_exist: bool = False, write: bool = False) -> Path:
        """Resolve and assert containment.

        Raises :class:`SandboxViolation` rather than returning a sentinel, so a
        tool cannot forget to check the result.
        """
        resolved = self._resolve(path)
        if not any(_is_within(resolved, root) for root in self.roots):
            raise SandboxViolation(
                f"path escapes the workspace: {path}",
                context={"path": str(path), "resolved": str(resolved), "root": str(self.root)},
            )
        if write and _is_protected(resolved):
            raise SandboxViolation(
                f"refusing to write to a protected system path: {resolved}",
                context={"path": str(resolved)},
            )
        if must_exist and not resolved.exists():
            raise InvalidArguments(f"path does not exist: {path}", context={"path": str(path)})
        return resolved

    def relative(self, path: str | Path) -> str:
        resolved = self.resolve(path)
        for root in self.roots:
            if _is_within(resolved, root):
                try:
                    return str(resolved.relative_to(root))
                except ValueError:  # pragma: no cover - guarded by _is_within
                    continue
        return str(resolved)  # pragma: no cover

    def _resolve(self, path: str | Path) -> Path:
        raw = str(path)
        if "\x00" in raw:
            raise SandboxViolation("null byte in path")
        candidate = Path(os.path.expanduser(raw))
        if not candidate.is_absolute():
            candidate = self.root / candidate
        # strict=False resolves symlinks for the parts that exist and lexically
        # normalises the rest, which is exactly what we need for "will be created".
        return candidate.resolve()


def _is_within(path: Path, root: Path) -> bool:
    """Containment by path *parts*, so /work-secrets is not inside /work."""
    if path == root:
        return True
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _is_protected(path: Path) -> bool:
    text = str(path)
    return any(text == p or text.startswith(p + os.sep) for p in _ALWAYS_PROTECTED)


def analyse_command(command: str, denylist: list[str] | None = None) -> CommandRisk:
    """Static risk analysis of a shell command line.

    Deliberately conservative: this decides whether to *ask*, not whether the
    command is truly dangerous. False positives cost a confirmation prompt;
    false negatives cost a user's data.
    """
    reasons: list[str] = []
    for name, pattern in _DESTRUCTIVE_PATTERNS:
        if pattern.search(command):
            reasons.append(name)
    for entry in denylist or []:
        if entry and entry in command:
            reasons.append(f"denylist:{entry}")
    return CommandRisk(
        destructive=bool(reasons), reasons=tuple(reasons), binaries=tuple(extract_binaries(command))
    )


def extract_binaries(command: str) -> list[str]:
    """Best-effort list of executables a command line invokes."""
    binaries: list[str] = []
    for segment in re.split(r"\|\||&&|[|;&\n]", command):
        segment = segment.strip()
        if not segment:
            continue
        try:
            tokens = shlex.split(segment)
        except ValueError:
            tokens = segment.split()
        for token in tokens:
            # skip leading VAR=value assignments and the `env` wrapper
            if "=" in token and not token.startswith(("-", "/")) and token.split("=")[0].isidentifier():
                continue
            if token in {"env", "command", "exec", "nohup", "time"}:
                continue
            binaries.append(Path(token).name)
            break
    return binaries
