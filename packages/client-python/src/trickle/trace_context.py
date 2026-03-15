"""Distributed trace context — propagates trace IDs across service boundaries.

When service A calls service B via HTTP:
1. Service A injects X-Trickle-Trace-Id header into outgoing requests
2. Service B reads the header and uses the same trace ID
3. Both services write observations with the shared trace ID

This allows agents to trace requests across microservice boundaries.

The trace context is stored in .trickle/traces.jsonl as:
  { "kind": "trace", "traceId": "abc123", "spanId": "def456",
    "parentSpanId": "000", "service": "user-api",
    "operation": "GET /users/1", "durationMs": 45.2,
    "timestamp": 1710516000 }
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any, Dict, Optional

_trace_file: Optional[str] = None
_current_trace_id: Optional[str] = None
_current_span_id: Optional[str] = None
_service_name: Optional[str] = None
_lock = threading.Lock()
_MAX_SPANS = 500
_span_count = 0
_buffer: list = []

# Thread-local storage for trace context
_context = threading.local()

TRACE_HEADER = "X-Trickle-Trace-Id"
SPAN_HEADER = "X-Trickle-Span-Id"
SERVICE_HEADER = "X-Trickle-Service"


def _get_trace_file() -> str:
    global _trace_file
    if _trace_file:
        return _trace_file
    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    os.makedirs(local_dir, exist_ok=True)
    _trace_file = os.path.join(local_dir, "traces.jsonl")
    try:
        with open(_trace_file, "w"):
            pass
    except OSError:
        pass
    return _trace_file


def _flush() -> None:
    global _buffer
    if _buffer and _trace_file:
        try:
            with open(_trace_file, "a") as f:
                f.write("\n".join(_buffer) + "\n")
        except Exception:
            pass
        _buffer = []


def _write_span(span: Dict[str, Any]) -> None:
    global _span_count
    if _span_count >= _MAX_SPANS:
        return
    _span_count += 1
    _buffer.append(json.dumps(span))
    if len(_buffer) >= 20:
        _flush()


def get_service_name() -> str:
    global _service_name
    if _service_name is None:
        _service_name = os.environ.get("TRICKLE_SERVICE_NAME", os.path.basename(os.getcwd()))
    return _service_name


def get_trace_id() -> str:
    """Get or create the current trace ID."""
    trace_id = getattr(_context, "trace_id", None)
    if trace_id is None:
        trace_id = uuid.uuid4().hex[:16]
        _context.trace_id = trace_id
    return trace_id


def get_span_id() -> str:
    """Get or create the current span ID."""
    span_id = getattr(_context, "span_id", None)
    if span_id is None:
        span_id = uuid.uuid4().hex[:16]
        _context.span_id = span_id
    return span_id


def set_trace_context(trace_id: str, parent_span_id: Optional[str] = None) -> None:
    """Set the trace context from an incoming request header."""
    _context.trace_id = trace_id
    _context.parent_span_id = parent_span_id
    _context.span_id = uuid.uuid4().hex[:16]


def get_propagation_headers() -> Dict[str, str]:
    """Get headers to inject into outgoing HTTP requests."""
    return {
        TRACE_HEADER: get_trace_id(),
        SPAN_HEADER: get_span_id(),
        SERVICE_HEADER: get_service_name(),
    }


def record_span(
    operation: str,
    duration_ms: float,
    status: Optional[str] = None,
    error: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Record a span (a unit of work within a trace)."""
    span: Dict[str, Any] = {
        "kind": "trace",
        "traceId": get_trace_id(),
        "spanId": get_span_id(),
        "parentSpanId": getattr(_context, "parent_span_id", None) or "0",
        "service": get_service_name(),
        "operation": operation,
        "durationMs": round(duration_ms, 2),
        "timestamp": int(time.time() * 1000),
    }
    if status:
        span["status"] = status
    if error:
        span["error"] = error[:200]
    if metadata:
        span["metadata"] = metadata
    _write_span(span)


def init_trace_context() -> None:
    """Initialize trace context. Called at startup."""
    _get_trace_file()
    import atexit
    atexit.register(_flush)


def patch_requests_propagation() -> None:
    """Patch requests library to propagate trace headers on outgoing calls."""
    try:
        import requests
    except ImportError:
        return

    original_send = requests.Session.send
    if getattr(original_send, "_trickle_trace_patched", False):
        return

    def patched_send(self: Any, request: Any, **kwargs: Any) -> Any:
        # Inject trace headers
        headers = get_propagation_headers()
        for k, v in headers.items():
            if k not in (request.headers or {}):
                request.headers[k] = v

        start = time.perf_counter()
        response = original_send(self, request, **kwargs)
        duration_ms = (time.perf_counter() - start) * 1000

        # Record outgoing HTTP span
        record_span(
            operation=f"{request.method} {request.url}",
            duration_ms=duration_ms,
            status=str(response.status_code),
            metadata={"direction": "outgoing"},
        )

        return response

    patched_send._trickle_trace_patched = True
    requests.Session.send = patched_send
