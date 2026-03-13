"""Patch torch.nn.functional.softmax to capture attention weight statistics.

When `trickle.auto` is active, this module intercepts softmax calls on
4-dimensional tensors shaped (B, H, T, T) — the signature shape of
self-attention weights.  After capturing the attention matrix, it computes:

  - Mean entropy per head:  H = -Σ p·log(p)   (nats; max = log(T))
  - Dead heads:  entropy ≈ log(T) → uniform distribution, head not learning
  - Sharp heads: entropy < 0.1·log(T) → very peaked attention
  - Mean position attended to:  argmax per head averaged across batch

These appear as inlay hints on the F.softmax() or attention call line:

    att = F.softmax(att, dim=-1)
    # 🎯 H=2.13 | heads: 6 sharp, 1 dead | pos=3.2

Works with any implementation that calls F.softmax on attention logits:
  - Karpathy's nanoGPT
  - Custom multi-head attention
  - torch.nn.MultiheadAttention (via its internal F.softmax call)
  - Flash-attention fallback paths

Rate-limited to every TRICKLE_ATT_EVERY (default 20) calls per (file, line).
"""
from __future__ import annotations

import inspect
import json
import math
import os
import time
from typing import Any, Dict, List, Optional

_installed = False
_EVERY = int(os.environ.get("TRICKLE_ATT_EVERY", "20"))
# Per call-site step counters
_call_counter: Dict[str, int] = {}

# We only analyse tensors that look like attention weights:
# 4-D, square last two dims, seq_len > 1
_MIN_SEQ = 2
_MAX_SEQ = 8192  # avoid huge memory allocs on very long sequences


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


def _compute_attention_stats(attn_weights: Any) -> Optional[Dict[str, Any]]:
    """Compute statistics over a (B, H, T, T) attention weight tensor."""
    try:
        # attn_weights shape: (B, H, T, T), values in [0,1] summing to 1 over last dim
        B, H, T, T2 = attn_weights.shape
        if T != T2 or T < _MIN_SEQ or T > _MAX_SEQ:
            return None

        w = attn_weights.detach().float()  # (B, H, T, T)

        # Entropy per (batch, head, query_pos): H = -sum(p * log(p+eps), dim=-1)
        eps = 1e-9
        entropy = -(w * (w + eps).log()).sum(dim=-1)  # (B, H, T)
        max_entropy = math.log(T)  # uniform distribution entropy

        # Per-head mean entropy (average over batch and query positions)
        head_entropy = entropy.mean(dim=(0, 2))  # (H,)
        mean_entropy = float(head_entropy.mean())

        # Dead heads: mean entropy > 95% of maximum (nearly uniform)
        dead_mask = head_entropy > 0.95 * max_entropy
        dead_heads = int(dead_mask.sum())

        # Sharp heads: mean entropy < 10% of maximum (very peaked)
        sharp_mask = head_entropy < 0.10 * max_entropy
        sharp_heads = int(sharp_mask.sum())

        # Mean attended position: argmax per (batch, head, query)
        max_pos = w.argmax(dim=-1).float()  # (B, H, T)
        mean_max_pos = float(max_pos.mean())

        # Diagonal attention fraction (attending to own position)
        # Only meaningful for causal/self-attention
        diag_idx = w.diagonal(dim1=-2, dim2=-1)  # (B, H, T)  — self-attention weight
        diag_attn = float(diag_idx.mean())

        return {
            "n_heads": H,
            "seq_len": T,
            "mean_entropy": round(mean_entropy, 4),
            "max_entropy": round(max_entropy, 4),
            "head_entropies": [round(float(h), 3) for h in head_entropy],
            "dead_heads": dead_heads,
            "sharp_heads": sharp_heads,
            "mean_max_pos": round(mean_max_pos, 2),
            "diag_attn": round(diag_attn, 4),
        }
    except Exception:
        return None


_orig_softmax: Any = None


def _patched_softmax(input: Any, dim: Any = None, *args: Any, **kwargs: Any) -> Any:
    """Wrapper around F.softmax that intercepts attention weight computations."""
    result = _orig_softmax(input, dim=dim, *args, **kwargs)

    try:
        # Only intercept 4-D tensors with square last two dims (attention shape)
        if (hasattr(result, "shape")
                and len(result.shape) == 4
                and result.shape[-1] == result.shape[-2]
                and result.shape[-1] >= _MIN_SEQ
                and result.shape[-1] <= _MAX_SEQ):

            frame = _find_user_frame()
            if frame is not None:
                filename = frame.f_code.co_filename
                line = frame.f_lineno
                key = f"{filename}:{line}"

                count = _call_counter.get(key, 0) + 1
                _call_counter[key] = count
                if count % _EVERY == 0:
                    stats = _compute_attention_stats(result)
                    if stats is not None:
                        record: Dict[str, Any] = {
                            "kind": "attention_stats",
                            "file": filename,
                            "line": line,
                            "call_count": count,
                            "timestamp": time.time(),
                            **stats,
                        }
                        with open(_get_vars_file(), "a") as f:
                            f.write(json.dumps(record) + "\n")
    except Exception:
        pass

    return result


def install() -> None:
    """Patch F.softmax to intercept attention weight computations."""
    global _installed, _orig_softmax
    if _installed:
        return
    _installed = True

    try:
        import torch.nn.functional as F
        _orig_softmax = F.softmax
        F.softmax = _patched_softmax  # type: ignore[assignment]

        # Also patch torch.functional.softmax (same function, different import path)
        import torch
        if hasattr(torch, "softmax"):
            torch.softmax = _patched_softmax  # type: ignore[assignment]
    except Exception:
        pass
