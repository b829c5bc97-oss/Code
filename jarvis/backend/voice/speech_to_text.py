"""
Server-side speech-to-text — not used.

Voice input is implemented entirely client-side instead, using the
browser's own Web Speech API (see `frontend/src/services/voice.ts`) — the
backend has no microphone of its own, and the browser already has direct,
zero-install access to the user's mic. This module is left as the
integration point for a server-side fallback (e.g. `faster-whisper` for
local transcription, for browsers without `SpeechRecognition` support)
should one become worth adding later.
"""
from __future__ import annotations


async def transcribe(audio_bytes: bytes) -> str:
    raise NotImplementedError(
        "No server-side STT backend is configured — voice input is handled client-side "
        "(see frontend/src/services/voice.ts). Implement this only if you need a "
        "fallback for browsers without SpeechRecognition support."
    )
