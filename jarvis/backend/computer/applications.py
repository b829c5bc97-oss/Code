"""Application launching — Phase 2."""
from __future__ import annotations

import platform
import subprocess

from backend.computer.errors import ComputerControlError

# Friendly aliases -> actual Linux executable names. Extend freely.
_LINUX_ALIASES = {
    "chrome": "google-chrome",
    "google chrome": "google-chrome",
    "vscode": "code",
    "vs code": "code",
    "visual studio code": "code",
    "calculator": "gnome-calculator",
    "terminal": "xterm",
    "files": "nautilus",
    "file manager": "nautilus",
    "text editor": "gedit",
}

_MAC_ALIASES = {
    "vscode": "Visual Studio Code",
    "vs code": "Visual Studio Code",
    "chrome": "Google Chrome",
    "google chrome": "Google Chrome",
    "terminal": "Terminal",
    "calculator": "Calculator",
}


def open_application(name: str) -> str:
    """Launch `name`. Returns a short human-readable confirmation."""
    system = platform.system()
    key = name.strip().lower()

    if system == "Linux":
        target = _LINUX_ALIASES.get(key, name)
        try:
            subprocess.Popen(
                [target],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            raise ComputerControlError(
                f"Couldn't find an application called {target!r}. Is it installed and on PATH?"
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise ComputerControlError(f"Couldn't open {target!r}: {exc}") from exc
        return f"Launched {target}."

    if system == "Darwin":
        target = _MAC_ALIASES.get(key, name)
        try:
            subprocess.run(["open", "-a", target], check=True, capture_output=True)
        except subprocess.CalledProcessError as exc:
            raise ComputerControlError(
                f"Couldn't open {target!r}: {exc.stderr.decode(errors='replace')}"
            ) from exc
        return f"Launched {target}."

    if system == "Windows":
        import os

        try:
            os.startfile(name)  # type: ignore[attr-defined]
        except OSError as exc:
            raise ComputerControlError(f"Couldn't open {name!r}: {exc}") from exc
        return f"Launched {name}."

    raise ComputerControlError(f"Unsupported platform: {system}")


def close_application(name: str) -> str:
    """Best-effort: terminate running processes whose name matches `name`."""
    try:
        import psutil
    except ImportError as exc:
        raise ComputerControlError(
            "The 'psutil' package is not installed. Run `pip install -r requirements.txt`."
        ) from exc

    needle = name.strip().lower()
    matched = []
    for proc in psutil.process_iter(["pid", "name"]):
        proc_name = (proc.info.get("name") or "").lower()
        if needle in proc_name:
            matched.append(proc)

    if not matched:
        raise ComputerControlError(f"No running application matching {name!r} was found.")

    closed = 0
    for proc in matched:
        try:
            proc.terminate()
            closed += 1
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied as exc:
            raise ComputerControlError(f"Not allowed to close {name!r}: {exc}") from exc

    return f"Closed {closed} process(es) matching {name!r}."
