"""Screenshot capture — Phase 2. Backed by `mss` (no external tool dependency)."""
from __future__ import annotations

from backend.computer.errors import ComputerControlError


def take_screenshot() -> bytes:
    """Capture the primary screen and return PNG bytes."""
    try:
        import mss
        import mss.tools
    except ImportError as exc:
        raise ComputerControlError(
            "The 'mss' package is not installed. Run `pip install -r requirements.txt`."
        ) from exc

    try:
        with mss.mss() as sct:
            monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            shot = sct.grab(monitor)
            return mss.tools.to_png(shot.rgb, shot.size)
    except Exception as exc:  # noqa: BLE001
        raise ComputerControlError(
            f"Couldn't capture the screen (no display detected?): {exc}"
        ) from exc


def get_screen_size() -> tuple[int, int]:
    try:
        import mss
    except ImportError as exc:
        raise ComputerControlError(
            "The 'mss' package is not installed. Run `pip install -r requirements.txt`."
        ) from exc

    try:
        with mss.mss() as sct:
            monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            return monitor["width"], monitor["height"]
    except Exception as exc:  # noqa: BLE001
        raise ComputerControlError(f"Couldn't read screen size: {exc}") from exc
