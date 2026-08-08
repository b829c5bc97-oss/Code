"""
Lazy, defensive loader for `pyautogui`.

Two real-world wrinkles this works around:

1. `pyautogui` unconditionally imports `mouseinfo` (a separate interactive
   diagnostic tool we never use), and `mouseinfo` calls `sys.exit()` at
   *import time* on Linux if `tkinter` isn't installed. That's a packaging
   wart, not a reason JARVIS's actual mouse/keyboard control should fail —
   so we install a harmless stub in `sys.modules['mouseinfo']` first when
   the real one can't load.
2. There may be no display at all (a headless server, this backend running
   detached from any desktop session). That's a real, expected failure
   mode we want to surface clearly rather than crash on import.
"""
from __future__ import annotations

import sys
import types

from backend.computer.errors import ComputerControlError

_pyautogui = None


def get_pyautogui():
    """Return the `pyautogui` module, importing it (defensively) on first use."""
    global _pyautogui
    if _pyautogui is not None:
        return _pyautogui

    if "mouseinfo" not in sys.modules:
        try:
            import mouseinfo  # noqa: F401
        except SystemExit:
            sys.modules["mouseinfo"] = types.ModuleType("mouseinfo")
        except ImportError:
            pass  # let pyautogui's own import raise a clear error below

    try:
        import pyautogui
    except ImportError as exc:
        raise ComputerControlError(
            "The 'pyautogui' package is not installed. Run "
            "`pip install -r requirements.txt`."
        ) from exc
    except Exception as exc:  # noqa: BLE001 - e.g. no $DISPLAY on Linux
        raise ComputerControlError(
            "Couldn't start computer control (no display detected). This is expected "
            "when the backend isn't running in a desktop session. "
            f"Details: {exc}"
        ) from exc

    pyautogui.FAILSAFE = True  # moving the mouse to a screen corner aborts — safety net
    _pyautogui = pyautogui
    return pyautogui
