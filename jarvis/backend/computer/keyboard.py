"""Keyboard control — Phase 2. Backed by `pyautogui`."""
from __future__ import annotations

from backend.computer._pyautogui_shim import get_pyautogui
from backend.computer.errors import ComputerControlError


def type_text(text: str, interval: float = 0.02) -> None:
    pag = get_pyautogui()
    try:
        pag.write(text, interval=interval)
    except Exception as exc:  # noqa: BLE001
        raise ComputerControlError(f"Couldn't type text: {exc}") from exc


def press_key(key: str) -> None:
    """Press a single key (`"enter"`) or a combo (`"ctrl+c"`, `"cmd+shift+4"`)."""
    pag = get_pyautogui()
    keys = [part.strip().lower() for part in key.split("+") if part.strip()]
    if not keys:
        raise ComputerControlError("No key specified.")
    try:
        if len(keys) == 1:
            pag.press(keys[0])
        else:
            pag.hotkey(*keys)
    except Exception as exc:  # noqa: BLE001
        raise ComputerControlError(f"Couldn't press {key!r}: {exc}") from exc
