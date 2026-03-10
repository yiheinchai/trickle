"""In-process cache that suppresses duplicate type reports."""

from __future__ import annotations

import time


class TypeCache:
    """Remembers which ``(function_key, type_hash)`` pairs have already been
    sent and avoids re-sending until ``max_staleness_seconds`` have elapsed.
    """

    def __init__(self, max_staleness_seconds: float = 300.0):
        self._max_staleness = max_staleness_seconds
        # function_key -> (type_hash, last_sent_timestamp)
        self._cache: dict[str, tuple[str, float]] = {}

    def should_send(self, function_key: str, type_hash: str) -> bool:
        """Return True if the payload should be sent to the backend."""
        entry = self._cache.get(function_key)
        if entry is None:
            return True
        cached_hash, last_sent = entry
        if cached_hash != type_hash:
            return True
        if (time.monotonic() - last_sent) >= self._max_staleness:
            return True
        return False

    def mark_sent(self, function_key: str, type_hash: str) -> None:
        """Record that a payload was sent for *function_key*."""
        self._cache[function_key] = (type_hash, time.monotonic())
