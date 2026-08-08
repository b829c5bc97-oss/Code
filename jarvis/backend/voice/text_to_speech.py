"""
Server-side text-to-speech — not used.

Voice output is implemented entirely client-side instead, using the
browser's own `speechSynthesis` API (see `frontend/src/services/voice.ts`)
— the backend has no speaker of its own, and this needs no extra install
or API key. This module is left as the integration point for a
higher-quality server-side voice (e.g. a cloud TTS API) should one become
worth adding later.
"""
from __future__ import annotations


async def synthesize(text: str) -> bytes:
    raise NotImplementedError(
        "No server-side TTS backend is configured — voice output is handled client-side "
        "(see frontend/src/services/voice.ts). Implement this only if you need "
        "higher-quality voices than the browser provides."
    )
