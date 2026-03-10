"""Batched HTTP transport with a background daemon thread.

All transport errors are silently swallowed so they never crash the
instrumented application.
"""

from __future__ import annotations

import atexit
import logging
import queue
import threading
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger("trickle.transport")

# ---------------------------------------------------------------------------
# Module-level configuration
# ---------------------------------------------------------------------------

_config_lock = threading.Lock()
_backend_url: str = "http://localhost:4888"
_batch_interval: float = 2.0
_enabled: bool = True
_max_batch_size: int = 100
_max_retries: int = 3

# ---------------------------------------------------------------------------
# Queue & worker
# ---------------------------------------------------------------------------

_queue: queue.Queue[Dict[str, Any]] = queue.Queue(maxsize=10_000)
_worker_thread: Optional[threading.Thread] = None
_shutdown_event = threading.Event()


def configure(
    backend_url: Optional[str] = None,
    batch_interval: Optional[float] = None,
    enabled: Optional[bool] = None,
    max_batch_size: Optional[int] = None,
    max_retries: Optional[int] = None,
) -> None:
    """Configure the Trickle transport layer.

    Can be called at any point; settings take effect immediately.
    """
    global _backend_url, _batch_interval, _enabled, _max_batch_size, _max_retries

    with _config_lock:
        if backend_url is not None:
            _backend_url = backend_url.rstrip("/")
        if batch_interval is not None:
            _batch_interval = batch_interval
        if enabled is not None:
            _enabled = enabled
        if max_batch_size is not None:
            _max_batch_size = max_batch_size
        if max_retries is not None:
            _max_retries = max_retries


def enqueue(payload: Dict[str, Any]) -> None:
    """Add a payload to the send queue.  Starts the worker on first call."""
    if not _enabled:
        return
    try:
        _queue.put_nowait(payload)
    except queue.Full:
        logger.debug("Trickle queue full — dropping payload")
        return
    _ensure_worker()


# ---------------------------------------------------------------------------
# Background worker
# ---------------------------------------------------------------------------

def _ensure_worker() -> None:
    global _worker_thread
    if _worker_thread is not None and _worker_thread.is_alive():
        return
    with _config_lock:
        # Double-check under lock
        if _worker_thread is not None and _worker_thread.is_alive():
            return
        _shutdown_event.clear()
        t = threading.Thread(target=_worker_loop, daemon=True, name="trickle-transport")
        t.start()
        _worker_thread = t


def _worker_loop() -> None:
    """Drain the queue in batches and POST to the backend."""
    # Lazily import requests so the cost is paid in the background thread
    try:
        import requests  # noqa: F811
    except ImportError:
        logger.error("trickle: `requests` package is required but not installed")
        return

    session = requests.Session()

    while not _shutdown_event.is_set():
        try:
            batch = _drain_batch()
            if batch:
                _send_batch(session, batch)
            else:
                # Sleep in small increments so we can react to shutdown quickly
                _shutdown_event.wait(timeout=_batch_interval)
        except Exception:
            logger.debug("Trickle worker error", exc_info=True)

    # Final flush on shutdown
    try:
        batch = _drain_batch()
        if batch:
            _send_batch(session, batch)
    except Exception:
        pass
    finally:
        session.close()


def _drain_batch() -> List[Dict[str, Any]]:
    batch: List[Dict[str, Any]] = []
    while len(batch) < _max_batch_size:
        try:
            item = _queue.get_nowait()
            batch.append(item)
        except queue.Empty:
            break
    return batch


def _send_batch(session: Any, batch: List[Dict[str, Any]]) -> None:
    url = f"{_backend_url}/api/ingest/batch"
    backoff = 0.5
    for attempt in range(_max_retries):
        try:
            resp = session.post(url, json={"payloads": batch}, timeout=10)
            if resp.status_code < 500:
                return  # success or client error (don't retry 4xx)
        except Exception:
            pass
        if attempt < _max_retries - 1:
            time.sleep(backoff)
            backoff = min(backoff * 2, 10)


# ---------------------------------------------------------------------------
# Shutdown hook
# ---------------------------------------------------------------------------

def _atexit_flush() -> None:
    _shutdown_event.set()
    t = _worker_thread
    if t is not None and t.is_alive():
        t.join(timeout=5)


atexit.register(_atexit_flush)
