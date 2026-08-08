"""
File management — Phase 6.

Operates on real paths on the user's machine (this is a local desktop
assistant, not a sandboxed cloud agent) — "organize these files" or
"rename these files" only makes sense against the user's actual
filesystem. Safety comes from the permission system instead: `files.delete`
is HIGH-risk and always requires confirmation (see `core/permissions.py`
and `tools/file_tools.py`), matching the project's core safety principle.
"""
from __future__ import annotations

import shutil
from pathlib import Path


class FileManagerError(RuntimeError):
    """Raised when a file operation can't be performed."""


def _resolve(path: str) -> Path:
    return Path(path).expanduser().resolve()


def list_dir(path: str) -> list[dict]:
    p = _resolve(path)
    if not p.exists():
        raise FileManagerError(f"{p} does not exist.")
    if not p.is_dir():
        raise FileManagerError(f"{p} is not a directory.")
    entries = []
    for child in sorted(p.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower())):
        try:
            stat = child.stat()
            entries.append(
                {
                    "name": child.name,
                    "path": str(child),
                    "is_dir": child.is_dir(),
                    "size": stat.st_size if child.is_file() else None,
                }
            )
        except OSError:
            continue
    return entries


def read_file(path: str, max_chars: int = 20000) -> str:
    p = _resolve(path)
    if not p.exists():
        raise FileManagerError(f"{p} does not exist.")
    if not p.is_file():
        raise FileManagerError(f"{p} is not a file.")
    try:
        text = p.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise FileManagerError(f"{p} doesn't look like a text file.") from exc
    except OSError as exc:
        raise FileManagerError(f"Couldn't read {p}: {exc}") from exc
    if len(text) > max_chars:
        text = text[:max_chars] + "…"
    return text


def create_file(path: str, content: str = "") -> str:
    p = _resolve(path)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    except OSError as exc:
        raise FileManagerError(f"Couldn't create {p}: {exc}") from exc
    return f"Created {p}."


def rename(path: str, new_name: str) -> str:
    p = _resolve(path)
    if not p.exists():
        raise FileManagerError(f"{p} does not exist.")
    if "/" in new_name or "\\" in new_name:
        raise FileManagerError("new_name must be a plain filename, not a path.")
    target = p.parent / new_name
    try:
        p.rename(target)
    except OSError as exc:
        raise FileManagerError(f"Couldn't rename {p} to {new_name!r}: {exc}") from exc
    return f"Renamed {p} to {target}."


def move(path: str, destination: str) -> str:
    src = _resolve(path)
    dest = _resolve(destination)
    if not src.exists():
        raise FileManagerError(f"{src} does not exist.")
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        final = shutil.move(str(src), str(dest))
    except OSError as exc:
        raise FileManagerError(f"Couldn't move {src} to {dest}: {exc}") from exc
    return f"Moved {src} to {final}."


def delete(path: str) -> str:
    """Permanently delete a file or directory. Always HIGH-risk — see `tools/file_tools.py`."""
    p = _resolve(path)
    if not p.exists():
        raise FileManagerError(f"{p} does not exist.")
    try:
        if p.is_dir():
            shutil.rmtree(p)
        else:
            p.unlink()
    except OSError as exc:
        raise FileManagerError(f"Couldn't delete {p}: {exc}") from exc
    return f"Permanently deleted {p}."
