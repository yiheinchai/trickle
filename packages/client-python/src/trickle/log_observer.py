"""Structured logging observer — patches Python's logging module to capture
log events with context (level, logger name, message, extra fields).

Writes to .trickle/logs.jsonl as:
  { "kind": "log", "level": "ERROR", "logger": "myapp.api",
    "message": "User not found", "timestamp": 1710516000,
    "extra": { "user_id": 123 }, "file": "api.py", "line": 42 }

This replaces Datadog's log aggregation — agents can query logs alongside
variables, queries, and traces for complete debugging context.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, Optional

_log_file: Optional[str] = None
_MAX_LOGS = 1000
_log_count = 0
_buffer: list = []
_installed = False


def _get_log_file() -> str:
    global _log_file
    if _log_file:
        return _log_file
    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    os.makedirs(local_dir, exist_ok=True)
    _log_file = os.path.join(local_dir, "logs.jsonl")
    try:
        with open(_log_file, "w"):
            pass
    except OSError:
        pass
    return _log_file


def _flush() -> None:
    global _buffer
    if _buffer and _log_file:
        try:
            with open(_log_file, "a") as f:
                f.write("\n".join(_buffer) + "\n")
        except Exception:
            pass
        _buffer = []


def _write_log(record: Dict[str, Any]) -> None:
    global _log_count
    if _log_count >= _MAX_LOGS:
        return
    _log_count += 1
    _buffer.append(json.dumps(record))
    if len(_buffer) >= 20:
        _flush()


class TrickleLogHandler(logging.Handler):
    """Logging handler that captures log records to .trickle/logs.jsonl."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            # Skip trickle's own logs to avoid recursion
            if record.name.startswith("trickle"):
                return

            extra: Dict[str, Any] = {}
            # Capture any extra fields the user added
            for key in record.__dict__:
                if key not in logging.LogRecord(
                    "", 0, "", 0, "", (), None
                ).__dict__ and key not in ("message", "msg", "args"):
                    val = record.__dict__[key]
                    if isinstance(val, (str, int, float, bool, type(None))):
                        extra[key] = val

            log_entry: Dict[str, Any] = {
                "kind": "log",
                "level": record.levelname,
                "logger": record.name,
                "message": record.getMessage()[:500],
                "timestamp": int(record.created * 1000),
                "file": record.pathname,
                "line": record.lineno,
                "function": record.funcName,
            }

            if extra:
                log_entry["extra"] = extra

            if record.exc_info and record.exc_info[1]:
                log_entry["exception"] = {
                    "type": type(record.exc_info[1]).__name__,
                    "message": str(record.exc_info[1])[:200],
                }

            _write_log(log_entry)
        except Exception:
            pass


def install_log_observer() -> None:
    """Install the trickle log handler on the root logger."""
    global _installed
    if _installed:
        return
    _installed = True

    _get_log_file()

    handler = TrickleLogHandler()
    handler.setLevel(logging.DEBUG)
    logging.getLogger().addHandler(handler)

    import atexit
    atexit.register(_flush)
