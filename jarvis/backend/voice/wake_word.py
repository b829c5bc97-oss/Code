"""
Server-side wake-word detection — not used.

The wake word (clap + spoken phrase) is implemented entirely client-side
instead — see `frontend/src/services/wakeWord.ts` — since it needs direct,
continuous access to the user's microphone, which only the browser tab has
in this architecture. This module is left as the integration point for a
server-side/OS-level always-on listener (e.g. `openWakeWord`) should a
non-browser deployment (e.g. Electron with a native tray listener) want one.
"""
from __future__ import annotations


def listen_for_wake_word() -> bool:
    raise NotImplementedError(
        "No server-side wake-word backend is configured — this is handled client-side "
        "(see frontend/src/services/wakeWord.ts)."
    )
