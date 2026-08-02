"""Filesystem tools.

Every path argument goes through the workspace jail, so traversal and symlink
escapes are structurally impossible rather than defended against ad hoc.

Two design choices worth calling out:

- **Writes are atomic.** Content goes to a sibling temp file and is renamed, so
  a crash or a cancelled step can never leave a half-written source file that a
  later step would happily compile.
- **Deletes are recoverable.** ``fs.delete`` moves into a per-run trash
  directory instead of unlinking, which is what lets the recovery engine undo a
  wrong decision instead of apologising for it.
"""

from __future__ import annotations

import fnmatch
import os
import re
import shutil
from pathlib import Path
from typing import Any

from ...foundation.errors import InvalidArguments
from ...security import capabilities as caps
from ...security.capabilities import RiskLevel
from ...security.policy import ActionRequest
from ..base import Tool, ToolContext, ToolResult

_SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache",
    ".pytest_cache", "dist", "build", ".next", ".aios", ".tox", "target",
}
_TEXT_SUFFIXES = {
    ".txt", ".md", ".rst", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml",
    ".yml", ".toml", ".ini", ".cfg", ".html", ".css", ".scss", ".sql", ".sh",
    ".go", ".rs", ".java", ".kt", ".rb", ".php", ".c", ".h", ".cpp", ".hpp",
    ".xml", ".csv", ".tsv", ".env", ".gitignore", ".dockerfile", ".lock",
}


def _is_probably_text(path: Path) -> bool:
    if path.suffix.lower() in _TEXT_SUFFIXES or path.name.lower() in {"dockerfile", "makefile"}:
        return True
    try:
        with path.open("rb") as fh:
            chunk = fh.read(4096)
    except OSError:
        return False
    return b"\x00" not in chunk


class ReadFile(Tool):
    """Read a text file, optionally a line range."""

    name = "fs.read"
    summary = "Read a UTF-8 text file, optionally a slice of lines."
    tags = ("filesystem", "read", "inspect")
    capabilities = frozenset({caps.FS_READ})
    risk = RiskLevel.SAFE
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path, relative to the workspace."},
            "start_line": {"type": "integer", "minimum": 1, "default": 1},
            "max_lines": {"type": "integer", "minimum": 1, "default": 2000},
        },
        "required": ["path"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", ""))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        path = ctx.jail.resolve(args["path"], must_exist=True)
        if path.is_dir():
            raise InvalidArguments(f"{args['path']} is a directory; use fs.list")
        if not _is_probably_text(path):
            return ToolResult.success(
                {"path": str(path), "binary": True, "size": path.stat().st_size},
                summary=f"{path.name} is binary ({path.stat().st_size} bytes); not decoded",
            )
        start = max(1, int(args.get("start_line", 1)))
        limit = int(args.get("max_lines", 2000))
        lines = path.read_text("utf-8", errors="replace").splitlines()
        window = lines[start - 1 : start - 1 + limit]
        truncated = len(lines) > start - 1 + limit
        return ToolResult.success(
            {
                "path": ctx.jail.relative(path),
                "content": "\n".join(window),
                "start_line": start,
                "returned_lines": len(window),
                "total_lines": len(lines),
                "truncated": truncated,
            },
            summary=f"read {len(window)} of {len(lines)} lines from {path.name}",
        )


class WriteFile(Tool):
    """Create or overwrite a file atomically."""

    name = "fs.write"
    summary = "Write text to a file (atomic; creates parent directories)."
    tags = ("filesystem", "write", "create")
    capabilities = frozenset({caps.FS_WRITE})
    risk = RiskLevel.LOW
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "content": {"type": "string"},
            "mode": {"type": "string", "enum": ["overwrite", "append", "create"],
                     "default": "overwrite"},
            "keep_as_artifact": {"type": "boolean", "default": True},
        },
        "required": ["path", "content"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", ""))]
        action.summary = f"write {len(str(args.get('content', '')))} chars to {args.get('path')}"
        # Overwriting an existing file destroys its previous contents.
        action.reversible = args.get("mode") != "overwrite"
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        path = ctx.jail.resolve(args["path"], write=True)
        mode = args.get("mode", "overwrite")
        content: str = args["content"]
        existed = path.exists()
        if mode == "create" and existed:
            raise InvalidArguments(f"{args['path']} already exists (mode=create)")
        path.parent.mkdir(parents=True, exist_ok=True)

        if mode == "append" and existed:
            with path.open("a", encoding="utf-8") as fh:
                fh.write(content)
        else:
            tmp = path.with_name(f".{path.name}.aios-tmp")
            tmp.write_text(content, encoding="utf-8")
            os.replace(tmp, path)

        artifacts = []
        if args.get("keep_as_artifact", True) and path.stat().st_size <= 8 * 1024 * 1024:
            artifacts.append(ctx.keep_file(path))
        return ToolResult.success(
            {
                "path": ctx.jail.relative(path),
                "bytes": path.stat().st_size,
                "created": not existed,
                "lines": content.count("\n") + 1,
            },
            summary=f"{'created' if not existed else mode + 'd'} {ctx.jail.relative(path)}",
            artifacts=artifacts,
        )


class EditFile(Tool):
    """Replace an exact substring in a file - the safe alternative to rewriting."""

    name = "fs.edit"
    summary = "Replace an exact string in a file; fails if not found or ambiguous."
    tags = ("filesystem", "write", "edit")
    capabilities = frozenset({caps.FS_WRITE})
    risk = RiskLevel.LOW
    idempotent = False
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "find": {"type": "string", "minLength": 1},
            "replace": {"type": "string"},
            "count": {"type": "integer", "minimum": 0, "default": 1,
                      "description": "0 replaces every occurrence."},
        },
        "required": ["path", "find", "replace"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", ""))]
        action.reversible = False
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        path = ctx.jail.resolve(args["path"], must_exist=True, write=True)
        original = path.read_text("utf-8")
        find: str = args["find"]
        occurrences = original.count(find)
        if occurrences == 0:
            raise InvalidArguments(
                f"string not found in {args['path']}",
                context={"find_preview": find[:120]},
            )
        wanted = int(args.get("count", 1))
        if wanted == 1 and occurrences > 1:
            raise InvalidArguments(
                f"string occurs {occurrences} times in {args['path']}; "
                "pass count=0 to replace all or extend `find` to make it unique"
            )
        updated = original.replace(find, args["replace"], -1 if wanted == 0 else wanted)
        tmp = path.with_name(f".{path.name}.aios-tmp")
        tmp.write_text(updated, encoding="utf-8")
        os.replace(tmp, path)
        replaced = occurrences if wanted == 0 else min(wanted, occurrences)
        return ToolResult.success(
            {"path": ctx.jail.relative(path), "replacements": replaced,
             "size_delta": len(updated) - len(original)},
            summary=f"replaced {replaced} occurrence(s) in {path.name}",
        )


class ListDir(Tool):
    """List a directory, optionally recursively."""

    name = "fs.list"
    summary = "List directory contents with sizes and types."
    tags = ("filesystem", "read", "inspect")
    capabilities = frozenset({caps.FS_READ})
    risk = RiskLevel.SAFE
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "default": "."},
            "recursive": {"type": "boolean", "default": False},
            "pattern": {"type": "string", "default": "*"},
            "max_entries": {"type": "integer", "minimum": 1, "default": 500},
            "include_hidden": {"type": "boolean", "default": False},
        },
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", "."))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        root = ctx.jail.resolve(args.get("path", "."), must_exist=True)
        if not root.is_dir():
            raise InvalidArguments(f"{args.get('path')} is not a directory")
        pattern = args.get("pattern", "*")
        limit = int(args.get("max_entries", 500))
        hidden = bool(args.get("include_hidden", False))

        entries: list[dict[str, Any]] = []
        walker = root.rglob("*") if args.get("recursive") else root.iterdir()
        for entry in sorted(walker):
            if len(entries) >= limit:
                break
            rel = entry.relative_to(root)
            if not hidden and any(part.startswith(".") for part in rel.parts):
                continue
            if any(part in _SKIP_DIRS for part in rel.parts):
                continue
            if not fnmatch.fnmatch(entry.name, pattern):
                continue
            try:
                stat = entry.stat()
            except OSError:
                continue
            entries.append(
                {
                    "path": str(rel),
                    "type": "dir" if entry.is_dir() else "file",
                    "size": stat.st_size if entry.is_file() else 0,
                    "modified": int(stat.st_mtime),
                }
            )
        return ToolResult.success(
            {"root": ctx.jail.relative(root), "entries": entries, "count": len(entries)},
            summary=f"{len(entries)} entries under {ctx.jail.relative(root)}",
        )


class SearchFiles(Tool):
    """Find files by name and/or content - the workhorse for understanding a codebase."""

    name = "fs.search"
    summary = "Search files by glob and/or regex content match."
    tags = ("filesystem", "read", "search", "inspect")
    capabilities = frozenset({caps.FS_READ})
    risk = RiskLevel.SAFE
    default_timeout = 120.0
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "default": "."},
            "name_glob": {"type": "string", "default": "*"},
            "contains": {"type": "string", "description": "Regular expression matched per line."},
            "ignore_case": {"type": "boolean", "default": True},
            "max_results": {"type": "integer", "minimum": 1, "default": 200},
            "max_file_bytes": {"type": "integer", "minimum": 1, "default": 2000000},
        },
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", "."))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        root = ctx.jail.resolve(args.get("path", "."), must_exist=True)
        glob = args.get("name_glob", "*")
        limit = int(args.get("max_results", 200))
        max_bytes = int(args.get("max_file_bytes", 2_000_000))
        pattern = None
        if args.get("contains"):
            flags = re.IGNORECASE if args.get("ignore_case", True) else 0
            try:
                pattern = re.compile(args["contains"], flags)
            except re.error as exc:
                raise InvalidArguments(f"invalid regex: {exc}") from exc

        matches: list[dict[str, Any]] = []
        scanned = 0
        for entry in sorted(root.rglob(glob) if root.is_dir() else [root]):
            if len(matches) >= limit:
                break
            if not entry.is_file():
                continue
            rel = entry.relative_to(root)
            if any(part in _SKIP_DIRS for part in rel.parts):
                continue
            if pattern is None:
                matches.append({"path": str(rel), "size": entry.stat().st_size})
                continue
            if entry.stat().st_size > max_bytes or not _is_probably_text(entry):
                continue
            scanned += 1
            try:
                text = entry.read_text("utf-8", errors="replace")
            except OSError:
                continue
            for lineno, line in enumerate(text.splitlines(), 1):
                if pattern.search(line):
                    matches.append(
                        {"path": str(rel), "line": lineno, "text": line.strip()[:300]}
                    )
                    if len(matches) >= limit:
                        break
        return ToolResult.success(
            {"root": ctx.jail.relative(root), "matches": matches, "count": len(matches),
             "files_scanned": scanned, "truncated": len(matches) >= limit},
            summary=f"{len(matches)} match(es) across {scanned or len(matches)} file(s)",
        )


class MakeDir(Tool):
    name = "fs.mkdir"
    summary = "Create a directory (and parents)."
    tags = ("filesystem", "write", "create")
    capabilities = frozenset({caps.FS_WRITE})
    risk = RiskLevel.LOW
    parameters = {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", ""))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        path = ctx.jail.resolve(args["path"], write=True)
        existed = path.exists()
        path.mkdir(parents=True, exist_ok=True)
        return ToolResult.success(
            {"path": ctx.jail.relative(path), "created": not existed},
            summary=("already present: " if existed else "created ") + ctx.jail.relative(path),
        )


class MoveFile(Tool):
    name = "fs.move"
    summary = "Move or rename a file or directory."
    tags = ("filesystem", "write", "organize")
    capabilities = frozenset({caps.FS_WRITE})
    risk = RiskLevel.MODERATE
    idempotent = False
    parameters = {
        "type": "object",
        "properties": {
            "source": {"type": "string"},
            "destination": {"type": "string"},
            "overwrite": {"type": "boolean", "default": False},
        },
        "required": ["source", "destination"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("source", "")), str(args.get("destination", ""))]
        action.reversible = True  # a move is undoable by moving back
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        source = ctx.jail.resolve(args["source"], must_exist=True)
        destination = ctx.jail.resolve(args["destination"], write=True)
        if destination.is_dir():
            destination = destination / source.name
        if destination.exists() and not args.get("overwrite", False):
            raise InvalidArguments(f"destination already exists: {args['destination']}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(destination))
        return ToolResult.success(
            {"source": args["source"], "destination": ctx.jail.relative(destination)},
            summary=f"moved {source.name} -> {ctx.jail.relative(destination)}",
        )


class DeleteFile(Tool):
    """Delete by moving to a run-scoped trash directory, so it stays undoable."""

    name = "fs.delete"
    summary = "Delete a file or directory (moved to workspace trash, recoverable)."
    tags = ("filesystem", "write", "delete", "organize")
    capabilities = frozenset({caps.FS_DELETE})
    risk = RiskLevel.HIGH
    reversible = True  # into trash; `purge` is what makes it permanent
    idempotent = False
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "purge": {"type": "boolean", "default": False,
                      "description": "Permanently remove instead of moving to trash."},
        },
        "required": ["path"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", ""))]
        action.reversible = not args.get("purge", False)
        action.risk = RiskLevel.CRITICAL if args.get("purge") else RiskLevel.HIGH
        action.summary = ("permanently delete " if args.get("purge") else "delete ") + str(
            args.get("path", "")
        )
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        path = ctx.jail.resolve(args["path"], must_exist=True, write=True)
        if path == ctx.jail.root:
            raise InvalidArguments("refusing to delete the workspace root")
        if args.get("purge"):
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
            return ToolResult.success(
                {"path": args["path"], "purged": True},
                summary=f"permanently deleted {path.name}",
            )
        trash = ctx.jail.root / ".aios" / "trash" / (ctx.run_id or "adhoc")
        trash.mkdir(parents=True, exist_ok=True)
        target = trash / path.name
        counter = 1
        while target.exists():
            target = trash / f"{path.stem}.{counter}{path.suffix}"
            counter += 1
        shutil.move(str(path), str(target))
        return ToolResult.success(
            {"path": args["path"], "trashed_to": str(target), "recoverable": True},
            summary=f"moved {path.name} to trash (recoverable)",
        )


class OrganizeFiles(Tool):
    """Classify and file a messy directory by type/date - a real chore, automated."""

    name = "fs.organize"
    summary = "Sort files in a directory into subfolders by kind, extension or date."
    tags = ("filesystem", "write", "organize")
    capabilities = frozenset({caps.FS_WRITE})
    risk = RiskLevel.MODERATE
    idempotent = False
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "strategy": {"type": "string", "enum": ["kind", "extension", "date"], "default": "kind"},
            "recursive": {"type": "boolean", "default": False},
            "apply": {"type": "boolean", "default": False,
                      "description": "False previews the plan without moving anything."},
        },
        "required": ["path"],
        "additionalProperties": False,
    }

    KINDS: dict[str, tuple[str, ...]] = {
        "images": (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".heic", ".bmp", ".tiff"),
        "video": (".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"),
        "audio": (".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg"),
        "documents": (".pdf", ".docx", ".doc", ".odt", ".rtf", ".txt", ".md", ".epub"),
        "spreadsheets": (".xlsx", ".xls", ".csv", ".tsv", ".ods"),
        "presentations": (".pptx", ".ppt", ".key", ".odp"),
        "archives": (".zip", ".tar", ".gz", ".bz2", ".7z", ".rar", ".xz"),
        "code": (".py", ".js", ".ts", ".tsx", ".go", ".rs", ".java", ".rb", ".c", ".cpp", ".sh"),
        "data": (".json", ".yaml", ".yml", ".xml", ".parquet", ".db", ".sqlite"),
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", ""))]
        # Previewing is free; only the applying variant is a real side effect.
        if not args.get("apply", False):
            action.risk = RiskLevel.SAFE
            action.capabilities = frozenset({caps.FS_READ})
        return action

    def _bucket(self, path: Path, strategy: str) -> str:
        if strategy == "extension":
            return (path.suffix.lstrip(".") or "no-extension").lower()
        if strategy == "date":
            import datetime as dt

            stamp = dt.datetime.fromtimestamp(path.stat().st_mtime, dt.UTC)
            return stamp.strftime("%Y-%m")
        suffix = path.suffix.lower()
        for kind, suffixes in self.KINDS.items():
            if suffix in suffixes:
                return kind
        return "other"

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        root = ctx.jail.resolve(args["path"], must_exist=True, write=True)
        if not root.is_dir():
            raise InvalidArguments(f"{args['path']} is not a directory")
        strategy = args.get("strategy", "kind")
        apply_changes = bool(args.get("apply", False))
        known_buckets = set(self.KINDS) | {"other"}

        plan: list[dict[str, str]] = []
        walker = root.rglob("*") if args.get("recursive") else root.iterdir()
        for entry in sorted(walker):
            if not entry.is_file() or entry.name.startswith("."):
                continue
            if strategy == "kind" and entry.parent.name in known_buckets:
                continue  # already filed
            bucket = self._bucket(entry, strategy)
            destination = root / bucket / entry.name
            if destination == entry:
                continue
            plan.append({"from": str(entry.relative_to(root)), "to": f"{bucket}/{entry.name}"})

        moved = 0
        if apply_changes:
            for item in plan:
                source = root / item["from"]
                destination = root / item["to"]
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.exists():
                    destination = destination.with_name(
                        f"{destination.stem}-{moved}{destination.suffix}"
                    )
                    item["to"] = str(destination.relative_to(root))
                shutil.move(str(source), str(destination))
                moved += 1

        buckets: dict[str, int] = {}
        for item in plan:
            buckets[item["to"].split("/")[0]] = buckets.get(item["to"].split("/")[0], 0) + 1
        return ToolResult.success(
            {"applied": apply_changes, "moves": plan[:500], "planned": len(plan),
             "moved": moved, "buckets": buckets},
            summary=(
                f"organized {moved} file(s) into {len(buckets)} folder(s)"
                if apply_changes
                else f"would move {len(plan)} file(s) into {len(buckets)} folder(s) "
                f"(set apply=true to execute)"
            ),
        )


class DiskUsage(Tool):
    name = "fs.usage"
    summary = "Report directory sizes and the largest files - for storage cleanup."
    tags = ("filesystem", "read", "inspect", "maintenance")
    capabilities = frozenset({caps.FS_READ})
    risk = RiskLevel.SAFE
    parameters = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "default": "."},
            "top": {"type": "integer", "minimum": 1, "default": 20},
        },
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("path", "."))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        root = ctx.jail.resolve(args.get("path", "."), must_exist=True)
        sizes: dict[str, int] = {}
        files: list[tuple[int, str]] = []
        total = 0
        for entry in root.rglob("*"):
            if not entry.is_file():
                continue
            try:
                size = entry.stat().st_size
            except OSError:
                continue
            total += size
            rel = entry.relative_to(root)
            top_level = rel.parts[0] if len(rel.parts) > 1 else "."
            sizes[top_level] = sizes.get(top_level, 0) + size
            files.append((size, str(rel)))
        files.sort(reverse=True)
        limit = int(args.get("top", 20))
        try:
            usage = shutil.disk_usage(root)
            disk = {"total": usage.total, "used": usage.used, "free": usage.free}
        except OSError:  # pragma: no cover
            disk = {}
        return ToolResult.success(
            {
                "root": ctx.jail.relative(root),
                "total_bytes": total,
                "by_directory": dict(sorted(sizes.items(), key=lambda kv: -kv[1])[:limit]),
                "largest_files": [{"size": s, "path": p} for s, p in files[:limit]],
                "disk": disk,
            },
            summary=f"{total / 1e6:.1f} MB across {len(files)} files",
        )


class CopyFile(Tool):
    name = "fs.copy"
    summary = "Copy a file or directory tree."
    tags = ("filesystem", "write", "create")
    capabilities = frozenset({caps.FS_READ, caps.FS_WRITE})
    risk = RiskLevel.LOW
    parameters = {
        "type": "object",
        "properties": {
            "source": {"type": "string"},
            "destination": {"type": "string"},
            "overwrite": {"type": "boolean", "default": False},
        },
        "required": ["source", "destination"],
        "additionalProperties": False,
    }

    def plan_action(self, args: dict[str, Any]) -> ActionRequest:
        action = super().plan_action(args)
        action.paths = [str(args.get("source", "")), str(args.get("destination", ""))]
        return action

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        source = ctx.jail.resolve(args["source"], must_exist=True)
        destination = ctx.jail.resolve(args["destination"], write=True)
        if destination.exists() and not args.get("overwrite", False):
            raise InvalidArguments(f"destination exists: {args['destination']}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            if destination.exists():
                shutil.rmtree(destination)
            shutil.copytree(source, destination)
            count = sum(1 for p in destination.rglob("*") if p.is_file())
        else:
            shutil.copyfile(source, destination)
            count = 1
        return ToolResult.success(
            {"source": args["source"], "destination": ctx.jail.relative(destination), "files": count},
            summary=f"copied {count} file(s) to {ctx.jail.relative(destination)}",
        )


def tools() -> list[Tool]:
    return [
        ReadFile(), WriteFile(), EditFile(), ListDir(), SearchFiles(),
        MakeDir(), MoveFile(), CopyFile(), DeleteFile(), OrganizeFiles(), DiskUsage(),
    ]


__all__ = ["tools"]
