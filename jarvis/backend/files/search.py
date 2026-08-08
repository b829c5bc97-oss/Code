"""File search — Phase 6."""
from __future__ import annotations

from pathlib import Path

from backend.files.file_manager import FileManagerError


def search_files(query: str, directory: str = ".", max_results: int = 50) -> list[str]:
    root = Path(directory).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise FileManagerError(f"{root} is not a searchable directory.")

    needle = query.lower()
    matches: list[str] = []
    try:
        for path in root.rglob("*"):
            if needle in path.name.lower():
                matches.append(str(path))
                if len(matches) >= max_results:
                    break
    except OSError as exc:
        raise FileManagerError(f"Search failed: {exc}") from exc
    return matches
