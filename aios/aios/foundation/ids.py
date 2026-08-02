"""Sortable, collision-resistant identifiers.

Run/step/artifact ids are used as filesystem names, ledger keys and log
correlation ids, so they must be lexicographically sortable by creation time
(makes `ls` and log greps chronological) and URL/path safe.

This is a ULID: 48 bits of millisecond timestamp + 80 bits of randomness,
Crockford base32 encoded to 26 characters.
"""

from __future__ import annotations

import os
import threading
import time

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32 (no I, L, O, U)
_lock = threading.Lock()
_last_ms = 0
_last_rand = 0


def _encode(value: int, length: int) -> str:
    out = []
    for _ in range(length):
        out.append(_ALPHABET[value & 0x1F])
        value >>= 5
    return "".join(reversed(out))


def new_id(prefix: str = "") -> str:
    """Return a new monotonic ULID, optionally prefixed like ``run_01J...``."""
    global _last_ms, _last_rand
    with _lock:
        ms = int(time.time() * 1000)
        if ms == _last_ms:
            # Same millisecond: increment the random component so ordering
            # inside a millisecond is still strictly increasing.
            _last_rand += 1
            if _last_rand >= 1 << 80:  # pragma: no cover - practically impossible
                ms += 1
                _last_ms = ms
                _last_rand = int.from_bytes(os.urandom(10), "big")
        else:
            _last_ms = ms
            _last_rand = int.from_bytes(os.urandom(10), "big")
        rand = _last_rand
    return f"{prefix}{_encode(ms, 10)}{_encode(rand, 16)}"


def run_id() -> str:
    return new_id("run_")


def step_id() -> str:
    return new_id("stp_")


def short(identifier: str, size: int = 8) -> str:
    """Short display form: keeps the prefix, truncates the entropy."""
    if "_" in identifier:
        prefix, _, body = identifier.partition("_")
        return f"{prefix}_{body[-size:]}"
    return identifier[-size:]
