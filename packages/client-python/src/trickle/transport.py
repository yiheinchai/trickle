"""Batched HTTP transport with a background daemon thread.

All transport errors are silently swallowed so they never crash the
instrumented application.

Supports local file-based mode via TRICKLE_LOCAL=1 env var —
observations are appended to .trickle/observations.jsonl instead of
being sent to the HTTP backend.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
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

# Local file-based mode
_local_mode: bool = os.environ.get("TRICKLE_LOCAL") == "1"
_local_file_path: str = ""

# ---------------------------------------------------------------------------
# Queue & worker
# ---------------------------------------------------------------------------

_queue: queue.Queue[Dict[str, Any]] = queue.Queue(maxsize=10_000)
_worker_thread: Optional[threading.Thread] = None
_shutdown_event = threading.Event()

# Per-function observation dedup: track seen typeHashes per function
# to avoid writing 100+ near-identical observations for hot functions.
_MAX_OBSERVATIONS_PER_FN = 10
_obs_counts: Dict[str, int] = {}  # "module::functionName" -> count
_obs_hashes: Dict[str, set] = {}  # "module::functionName" -> set of typeHashes

# Cloud streaming: buffer observations for periodic upload
_cloud_url: str = ""
_cloud_token: str = ""
_cloud_project: str = ""
_cloud_buffer: List[str] = []
_cloud_lock = threading.Lock()
_cloud_timer: Optional[threading.Timer] = None


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
    global _local_mode, _local_file_path

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

        # Check for local file-based mode
        if os.environ.get("TRICKLE_LOCAL") == "1":
            _local_mode = True
            local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
            os.makedirs(local_dir, exist_ok=True)
            _local_file_path = os.path.join(local_dir, "observations.jsonl")
            logger.debug("Local mode: writing to %s", _local_file_path)

        # Initialize cloud streaming if configured
        _init_cloud_streaming()


def enqueue(payload: Dict[str, Any]) -> None:
    """Add a payload to the send queue.  Starts the worker on first call."""
    if not _enabled:
        return

    # Per-function dedup: skip if we've seen enough unique type patterns
    fn_name = payload.get("functionName", "")
    module = payload.get("module", "")
    if fn_name:
        fn_key = f"{module}::{fn_name}"
        type_hash = payload.get("typeHash", "")
        seen = _obs_hashes.get(fn_key)
        if seen is None:
            _obs_hashes[fn_key] = {type_hash}
            _obs_counts[fn_key] = 1
        elif type_hash in seen:
            # Already have this exact type pattern — skip
            return
        elif len(seen) >= _MAX_OBSERVATIONS_PER_FN:
            # Already have enough distinct patterns — skip
            return
        else:
            seen.add(type_hash)
            _obs_counts[fn_key] = _obs_counts.get(fn_key, 0) + 1

    # Local file mode: append directly to JSONL file
    if _local_mode and _local_file_path:
        try:
            line = json.dumps(payload) + "\n"
            with open(_local_file_path, "a") as f:
                f.write(line)
            # Also buffer for cloud streaming
            if _cloud_url and _cloud_token:
                with _cloud_lock:
                    _cloud_buffer.append(line)
        except Exception:
            pass  # Never crash user's app
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
# Cloud streaming
# ---------------------------------------------------------------------------

def _init_cloud_streaming() -> None:
    """Initialize cloud streaming from env vars or ~/.trickle/cloud.json."""
    global _cloud_url, _cloud_token, _cloud_project

    _cloud_url = os.environ.get("TRICKLE_CLOUD_URL", "")
    _cloud_token = os.environ.get("TRICKLE_CLOUD_TOKEN", "")

    # Load from config file if env vars not set
    if not _cloud_url or not _cloud_token:
        try:
            config_path = os.path.join(os.environ.get("HOME", "~"), ".trickle", "cloud.json")
            if os.path.exists(config_path):
                with open(config_path) as f:
                    config = json.load(f)
                if not _cloud_url and config.get("url"):
                    _cloud_url = config["url"]
                if not _cloud_token and config.get("token"):
                    _cloud_token = config["token"]
        except Exception:
            pass

    _cloud_project = os.environ.get("TRICKLE_CLOUD_PROJECT", os.path.basename(os.getcwd()))

    if _cloud_url and _cloud_token:
        _schedule_cloud_flush()
        logger.debug("Cloud streaming enabled → %s", _cloud_url)


def _schedule_cloud_flush() -> None:
    """Schedule periodic cloud buffer flush."""
    global _cloud_timer
    if _cloud_timer is not None:
        return

    def _flush_loop() -> None:
        global _cloud_timer
        _flush_cloud_buffer()
        _cloud_timer = threading.Timer(5.0, _flush_loop)
        _cloud_timer.daemon = True
        _cloud_timer.start()

    _cloud_timer = threading.Timer(5.0, _flush_loop)
    _cloud_timer.daemon = True
    _cloud_timer.start()


def _flush_cloud_buffer() -> None:
    """Send buffered observations to the cloud."""
    if not _cloud_buffer or not _cloud_url or not _cloud_token:
        return

    with _cloud_lock:
        lines = _cloud_buffer[:]
        _cloud_buffer.clear()

    if not lines:
        return

    try:
        import requests
        requests.post(
            f"{_cloud_url}/api/v1/ingest",
            json={
                "project": _cloud_project,
                "file": "observations.jsonl",
                "lines": "".join(lines),
            },
            headers={"Authorization": f"Bearer {_cloud_token}"},
            timeout=10,
        )
    except Exception:
        pass  # Silent — data is already saved locally


# ---------------------------------------------------------------------------
# Shutdown hook
# ---------------------------------------------------------------------------

def _atexit_flush() -> None:
    _shutdown_event.set()
    t = _worker_thread
    if t is not None and t.is_alive():
        t.join(timeout=5)
    # Final cloud flush
    _flush_cloud_buffer()


atexit.register(_atexit_flush)
