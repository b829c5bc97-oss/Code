"""Mouse control — Phase 2. Backed by `pyautogui`."""
from __future__ import annotations

from backend.computer._pyautogui_shim import get_pyautogui
from backend.computer.errors import ComputerControlError


def get_position() -> tuple[int, int]:
    pag = get_pyautogui()
    pos = pag.position()
    return (pos.x, pos.y)


def move(x: int, y: int, duration: float = 0.15) -> None:
    pag = get_pyautogui()
    try:
        pag.moveTo(x, y, duration=duration)
    except Exception as exc:  # noqa: BLE001
        raise ComputerControlError(f"Couldn't move the mouse to ({x}, {y}): {exc}") from exc


def click(x: int | None = None, y: int | None = None, button: str = "left", clicks: int = 1) -> None:
    pag = get_pyautogui()
    if button not in ("left", "right", "middle"):
        raise ComputerControlError(f"Unknown mouse button: {button!r}")
    try:
        if x is not None and y is not None:
            pag.click(x, y, clicks=clicks, button=button)
        else:
            pag.click(clicks=clicks, button=button)
    except Exception as exc:  # noqa: BLE001
        raise ComputerControlError(f"Couldn't click: {exc}") from exc


def scroll(amount: int) -> None:
    """Positive scrolls up, negative scrolls down."""
    pag = get_pyautogui()
    try:
        pag.scroll(amount)
    except Exception as exc:  # noqa: BLE001
        raise ComputerControlError(f"Couldn't scroll: {exc}") from exc
