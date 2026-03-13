"""Register a global forward hook on nn.Module to emit activation statistics.

After each module forward pass, captures the output tensor's statistics and
emits them as inlay hints on the call site in VSCode:

    x = self.relu(x)   # ◆ μ=0.34 σ=0.89 [dead:42%]
    logits = model(x)  # ◆ μ=0.12 σ=1.23 min=-3.2 max=3.8

Detects:
  - Dead ReLUs: >50% of output values are zero → "dead:NN%"
  - Saturation: >50% of |values| > 0.9 (tanh/sigmoid) → "sat:NN%"
  - Vanishing activations: std < 1e-5 → "↓vanish"
  - Exploding activations: max |value| > 1e3 → "⚡explode"

Rate-limited to every TRICKLE_ACT_EVERY (default 20) forward calls per
(file, line) call site, with a rolling window of recent stats.
"""
from __future__ import annotations

import inspect
import json
import os
import time
from typing import Any, Dict, List, Optional, Tuple

_installed = False
_hook_handle: Any = None

# Per call-site step counters: "file:line" -> int
_call_counter: Dict[str, int] = {}
# How often to emit per call site
_EVERY = int(os.environ.get("TRICKLE_ACT_EVERY", "20"))
# Minimum tensor size to bother with stats (avoids scalars/tiny outputs)
_MIN_ELEMENTS = int(os.environ.get("TRICKLE_ACT_MIN_ELEMENTS", "8"))


def _get_vars_file() -> str:
    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    os.makedirs(local_dir, exist_ok=True)
    return os.path.join(local_dir, "variables.jsonl")


def _find_user_frame() -> Optional[Any]:
    """Walk the call stack to find the first frame in user code."""
    frame = inspect.currentframe()
    while frame is not None:
        fname = frame.f_code.co_filename
        if (fname
                and not fname.startswith("<")
                and os.path.isfile(fname)
                and "site-packages" not in fname
                and "/trickle/" not in fname
                and "\\trickle\\" not in fname):
            return frame
        frame = frame.f_back
    return None


def _tensor_stats(tensor: Any) -> Optional[Dict[str, Any]]:
    """Compute statistics for an output tensor. Returns None if unsuitable."""
    try:
        if not hasattr(tensor, "shape") or not hasattr(tensor, "float"):
            return None
        numel = 1
        for d in tensor.shape:
            numel *= d
        if numel < _MIN_ELEMENTS:
            return None

        t = tensor.detach().float()
        mean = float(t.mean())
        std = float(t.std())
        tmin = float(t.min())
        tmax = float(t.max())
        abs_max = max(abs(tmin), abs(tmax))

        stats: Dict[str, Any] = {
            "mean": round(mean, 4),
            "std": round(std, 4),
            "min": round(tmin, 4),
            "max": round(tmax, 4),
            "numel": numel,
            "shape": list(tensor.shape),
        }

        # Dead ReLU detection: fraction of exact zeros
        try:
            zero_frac = float((t == 0).float().mean())
            if zero_frac > 0.0:
                stats["zero_frac"] = round(zero_frac, 3)
        except Exception:
            pass

        # Saturation detection: fraction of |values| > 0.9 (tanh/sigmoid range)
        try:
            sat_frac = float((t.abs() > 0.9).float().mean())
            if sat_frac > 0.1:
                stats["sat_frac"] = round(sat_frac, 3)
        except Exception:
            pass

        # Anomaly flags
        if std < 1e-5:
            stats["vanishing"] = True
        if abs_max > 1e3:
            stats["exploding"] = True

        return stats
    except Exception:
        return None


def _extract_output_stats(output: Any) -> Optional[Dict[str, Any]]:
    """Extract stats from a module's output (tensor, tuple, or dict)."""
    if output is None:
        return None
    try:
        # Direct tensor output
        if hasattr(output, "shape"):
            return _tensor_stats(output)
        # Tuple/list — take first tensor-like element
        if isinstance(output, (tuple, list)):
            for item in output:
                if hasattr(item, "shape"):
                    stats = _tensor_stats(item)
                    if stats is not None:
                        stats["output_index"] = 0
                        return stats
        # HuggingFace ModelOutput (has .last_hidden_state, .logits, etc.)
        if hasattr(output, "last_hidden_state"):
            return _tensor_stats(output.last_hidden_state)
        if hasattr(output, "logits"):
            return _tensor_stats(output.logits)
    except Exception:
        pass
    return None


def _forward_hook(module: Any, inputs: Any, output: Any) -> None:
    """Global forward hook called after every nn.Module forward pass."""
    try:
        frame = _find_user_frame()
        if frame is None:
            return

        filename = frame.f_code.co_filename
        line = frame.f_lineno
        key = f"{filename}:{line}"

        count = _call_counter.get(key, 0) + 1
        _call_counter[key] = count
        if count % _EVERY != 0:
            return

        stats = _extract_output_stats(output)
        if stats is None:
            return

        module_name = type(module).__name__

        record: Dict[str, Any] = {
            "kind": "activation_stats",
            "file": filename,
            "line": line,
            "module_name": module_name,
            "call_count": count,
            "timestamp": time.time(),
            **stats,
        }

        with open(_get_vars_file(), "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass


def install() -> None:
    """Register a global forward hook on all nn.Module instances."""
    global _installed, _hook_handle
    if _installed:
        return
    _installed = True

    try:
        import torch.nn as nn
        _hook_handle = nn.modules.module.register_module_forward_hook(_forward_hook)
    except Exception:
        pass
