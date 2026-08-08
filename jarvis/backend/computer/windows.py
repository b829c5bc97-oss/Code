"""
Window management — Phase 2.

Window enumeration/focus is notoriously platform-specific:

- Linux (X11): uses `ewmh`/`python-xlib`. Under Wayland, most compositors
  deliberately don't expose this to arbitrary clients for security reasons
  — that's a platform limitation, not a bug here, and we say so.
- Windows / macOS: uses `pygetwindow` (it doesn't support Linux at all).
"""
from __future__ import annotations

import platform

from backend.computer.errors import ComputerControlError


def _window_title(win) -> str:
    """Best-effort title for a python-xlib Window (ICCCM, falling back to EWMH)."""
    try:
        name = win.get_wm_name()
        if name:
            return name if isinstance(name, str) else name.decode("utf-8", "replace")
    except Exception:  # noqa: BLE001
        pass
    return ""


def _window_search_text(win) -> str:
    """Title plus WM_CLASS, so "focus chrome" matches the app even if the
    window's title bar shows a page name instead."""
    parts = [_window_title(win)]
    try:
        wm_class = win.get_wm_class()
        if wm_class:
            parts.extend(wm_class)
    except Exception:  # noqa: BLE001
        pass
    return " ".join(parts)


def list_windows() -> list[str]:
    system = platform.system()

    if system == "Linux":
        try:
            from ewmh import EWMH
        except ImportError as exc:
            raise ComputerControlError(
                "The 'ewmh' package is not installed. Run `pip install -r requirements.txt`."
            ) from exc
        try:
            ewmh = EWMH()
            client_list = ewmh.getClientList() or []
            titles = [_window_title(w) for w in client_list]
            return [t for t in titles if t]
        except Exception as exc:  # noqa: BLE001
            raise ComputerControlError(
                "Couldn't list windows. If you're on Wayland, most desktops block this "
                f"for security reasons. Details: {exc}"
            ) from exc

    try:
        import pygetwindow as gw
    except (ImportError, NotImplementedError) as exc:
        raise ComputerControlError(
            "Window listing isn't available on this platform: " f"{exc}"
        ) from exc
    return list(gw.getAllTitles())


def focus_window(title: str) -> bool:
    """Best-effort: focus the first window whose title contains `title` (case-insensitive)."""
    system = platform.system()
    needle = title.lower()

    if system == "Linux":
        try:
            from ewmh import EWMH
        except ImportError as exc:
            raise ComputerControlError(
                "The 'ewmh' package is not installed. Run `pip install -r requirements.txt`."
            ) from exc
        try:
            ewmh = EWMH()
            for win in ewmh.getClientList() or []:
                if needle in _window_search_text(win).lower():
                    ewmh.setActiveWindow(win)
                    ewmh.display.flush()
                    return True
            return False
        except Exception as exc:  # noqa: BLE001
            raise ComputerControlError(f"Couldn't focus window {title!r}: {exc}") from exc

    try:
        import pygetwindow as gw
    except (ImportError, NotImplementedError) as exc:
        raise ComputerControlError(
            f"Window focusing isn't available on this platform: {exc}"
        ) from exc
    matches = [w for w in gw.getAllWindows() if needle in w.title.lower()]
    if not matches:
        return False
    try:
        matches[0].activate()
    except Exception as exc:  # noqa: BLE001
        raise ComputerControlError(f"Couldn't focus window {title!r}: {exc}") from exc
    return True
