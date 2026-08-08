"""
File management tools — Phase 6.

Will wrap list/read/create/rename/move/delete behind the permission
system (`core/permissions.py`) so destructive operations (delete, move)
require explicit user confirmation, per the project's safety principle.

Not implemented yet.
"""
from __future__ import annotations

from pathlib import Path


def list_files(directory: str) -> list[str]:
    raise NotImplementedError("File management is not implemented until Phase 6.")


def read_file(path: str) -> str:
    raise NotImplementedError("File management is not implemented until Phase 6.")


def delete_file(path: str) -> None:
    raise NotImplementedError(
        "File deletion is not implemented, and will require explicit user "
        "confirmation once it is (see core/permissions.py)."
    )
