"""Performance profiling — captures memory usage and timing metrics.

Writes to .trickle/profile.jsonl as:
  { "kind": "profile", "event": "snapshot", "rssKb": 51200,
    "heapKb": 12800, "timestamp": 1710516000 }

Also captures per-function memory deltas when functions allocate
significant memory (> 1MB).
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, Optional

_profile_file: Optional[str] = None
_MAX_EVENTS = 200
_event_count = 0


def _get_profile_file() -> str:
    global _profile_file
    if _profile_file:
        return _profile_file
    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    os.makedirs(local_dir, exist_ok=True)
    _profile_file = os.path.join(local_dir, "profile.jsonl")
    try:
        with open(_profile_file, "w"):
            pass
    except OSError:
        pass
    return _profile_file


def _write_event(event: Dict[str, Any]) -> None:
    global _event_count
    if _event_count >= _MAX_EVENTS:
        return
    _event_count += 1
    try:
        with open(_get_profile_file(), "a") as f:
            f.write(json.dumps(event) + "\n")
    except Exception:
        pass


def get_memory_info() -> Dict[str, Any]:
    """Get current memory usage in KB."""
    info: Dict[str, Any] = {}
    try:
        import resource
        usage = resource.getrusage(resource.RUSAGE_SELF)
        # macOS returns bytes, Linux returns KB
        import platform
        if platform.system() == "Darwin":
            info["rssKb"] = usage.ru_maxrss // 1024
        else:
            info["rssKb"] = usage.ru_maxrss
    except Exception:
        pass

    try:
        import tracemalloc
        if tracemalloc.is_tracing():
            current, peak = tracemalloc.get_traced_memory()
            info["heapKb"] = current // 1024
            info["peakHeapKb"] = peak // 1024
    except Exception:
        pass

    return info


def snapshot(label: str = "snapshot") -> None:
    """Take a memory snapshot and write to profile.jsonl."""
    mem = get_memory_info()
    if not mem:
        return
    _write_event({
        "kind": "profile",
        "event": label,
        **mem,
        "timestamp": int(time.time() * 1000),
    })


def start_profiling() -> None:
    """Start memory tracking. Called at the beginning of trickle run."""
    try:
        import tracemalloc
        if not tracemalloc.is_tracing():
            tracemalloc.start()
    except Exception:
        pass

    _get_profile_file()  # Initialize file
    snapshot("start")

    import atexit
    atexit.register(lambda: snapshot("end"))
