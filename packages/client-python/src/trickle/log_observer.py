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
    # Write immediately to avoid buffer loss on exit
    try:
        with open(_get_log_file(), "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass


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


def _patch_structlog() -> None:
    """Patch structlog to capture structured log entries.

    structlog uses processors in a chain. We add a trickle processor at the
    end of the chain to capture the final structured output.
    """
    try:
        import sys
        if "structlog" not in sys.modules:
            return
        import structlog

        if getattr(structlog, "_trickle_patched", False):
            return
        structlog._trickle_patched = True  # type: ignore[attr-defined]

        # Add a processor that captures log entries
        _orig_configure = structlog.configure

        def _patched_configure(**kwargs: Any) -> Any:
            processors = list(kwargs.get("processors", []))
            # Add trickle processor before the final renderer
            if processors:
                processors.insert(-1, _structlog_processor)
            else:
                processors.append(_structlog_processor)
            kwargs["processors"] = processors
            return _orig_configure(**kwargs)

        structlog.configure = _patched_configure  # type: ignore[assignment]

        # Also patch get_logger to capture from unconfigured structlog
        _orig_get_logger = structlog.get_logger

        def _patched_get_logger(*args: Any, **kwargs: Any) -> Any:
            logger = _orig_get_logger(*args, **kwargs)
            if not getattr(logger, "_trickle_wrapped", False):
                _wrap_structlog_logger(logger)
            return logger

        structlog.get_logger = _patched_get_logger  # type: ignore[assignment]

    except Exception:
        pass


def _structlog_processor(logger: Any, method_name: str, event_dict: Any) -> Any:
    """structlog processor that writes to logs.jsonl."""
    try:
        message = event_dict.get("event", "") or ""
        level = method_name or event_dict.get("level", "info")
        meta: Dict[str, Any] = {}
        for key, val in event_dict.items():
            if key not in ("event", "level", "timestamp", "_logger", "_name"):
                if isinstance(val, (str, int, float, bool, type(None))):
                    meta[key] = val

        log_entry: Dict[str, Any] = {
            "kind": "log",
            "level": str(level).upper(),
            "logger": "structlog",
            "message": str(message)[:500],
            "timestamp": int(time.time() * 1000),
        }
        if meta:
            log_entry["meta"] = meta
        _write_log(log_entry)
    except Exception:
        pass
    return event_dict


def _wrap_structlog_logger(logger: Any) -> None:
    """Wrap a structlog bound logger's level methods to capture output."""
    try:
        logger._trickle_wrapped = True
        for level_name in ["debug", "info", "warning", "error", "critical", "exception"]:
            orig = getattr(logger, level_name, None)
            if orig and callable(orig) and not getattr(orig, "_trickle_patched", False):
                def _make_wrapper(orig_method: Any, lname: str) -> Any:
                    def _wrapper(*args: Any, **kwargs: Any) -> Any:
                        try:
                            message = args[0] if args else kwargs.get("event", "")
                            meta: Dict[str, Any] = {}
                            for k, v in kwargs.items():
                                if k != "event" and isinstance(v, (str, int, float, bool, type(None))):
                                    meta[k] = v
                            _write_log({
                                "kind": "log",
                                "level": lname.upper(),
                                "logger": "structlog",
                                "message": str(message)[:500],
                                "timestamp": int(time.time() * 1000),
                                "meta": meta if meta else None,
                            })
                        except Exception:
                            pass
                        return orig_method(*args, **kwargs)
                    _wrapper._trickle_patched = True
                    return _wrapper
                setattr(logger, level_name, _make_wrapper(orig, level_name))
    except Exception:
        pass


_loguru_patched = False

def _patch_loguru() -> None:
    """Patch loguru to capture structured log entries.

    loguru uses sinks. We add a custom sink that writes to logs.jsonl.
    """
    global _loguru_patched
    if _loguru_patched:
        return
    try:
        import sys
        if "loguru" not in sys.modules:
            return
        # Defer patching if loguru isn't fully loaded yet
        loguru_mod = sys.modules["loguru"]
        if not hasattr(loguru_mod, "logger"):
            return
        from loguru import logger as loguru_logger
        _loguru_patched = True

        class _TrickleSink:
            def write(self, message: Any) -> None:
                try:
                    record = message.record
                    level = record.get("level", None)
                    level_name = level.name if level and hasattr(level, "name") else str(level or "INFO")
                    msg = record.get("message", "")
                    extra = record.get("extra", {})
                    meta: Dict[str, Any] = {}
                    if extra:
                        for k, v in extra.items():
                            if isinstance(v, (str, int, float, bool, type(None))):
                                meta[k] = v

                    file_info = record.get("file", None)
                    file_path = ""
                    if file_info:
                        file_path = str(getattr(file_info, "path", file_info)) if file_info else ""

                    log_entry: Dict[str, Any] = {
                        "kind": "log",
                        "level": level_name.upper(),
                        "logger": "loguru",
                        "message": str(msg)[:500],
                        "timestamp": int(time.time() * 1000),
                    }
                    if file_path:
                        log_entry["file"] = file_path
                    line = record.get("line")
                    if line:
                        log_entry["line"] = line
                    func = record.get("function")
                    if func:
                        log_entry["function"] = func
                    if meta:
                        log_entry["meta"] = meta

                    exc = record.get("exception")
                    if exc and exc.value:
                        log_entry["exception"] = {
                            "type": type(exc.value).__name__,
                            "message": str(exc.value)[:200],
                        }
                    _write_log(log_entry)
                except Exception:
                    pass

        sink_id = loguru_logger.add(_TrickleSink(), level="TRACE")
        if _debug:
            print(f"[trickle/log] Loguru sink added (id={sink_id})")

    except Exception:
        pass


def install_log_observer() -> None:
    """Install the trickle log handler on the root logger and patch structlog/loguru."""
    global _installed
    if _installed:
        return
    _installed = True

    _get_log_file()

    # Stdlib logging
    handler = TrickleLogHandler()
    handler.setLevel(logging.DEBUG)
    logging.getLogger().addHandler(handler)

    # Structlog (if imported)
    _patch_structlog()

    # Loguru (if imported)
    _patch_loguru()

    import atexit

    def _final_flush() -> None:
        # Last chance to patch loguru/structlog and flush
        _patch_loguru()
        _patch_structlog()
        _flush()

    atexit.register(_final_flush)
