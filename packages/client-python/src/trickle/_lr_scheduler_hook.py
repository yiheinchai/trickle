"""Patch PyTorch LR schedulers to emit learning rate records.

After each scheduler.step() call, emits a `kind: "lr_schedule"` record
to .trickle/variables.jsonl so the VSCode extension can show the current
learning rate as an inlay hint at the scheduler.step() line:

    scheduler.step()  📈 lr=2.34e-04 | epoch=3 | step=150

Covers all PyTorch schedulers (CosineAnnealingLR, OneCycleLR, warmup, etc.)
since they all inherit from LRScheduler (formerly _LRScheduler).
"""
from __future__ import annotations

import inspect
import json
import os
import time
from typing import Any, Dict, List, Optional

_installed = False

# Per-call-site step counter for rate limiting: "file:line" -> count
_step_counter: Dict[str, int] = {}
_vars_file: Optional[str] = None

# Metric names to capture from caller's frame for context
_CONTEXT_METRIC_NAMES = frozenset({
    "epoch", "epochs", "step", "global_step", "iteration", "iter",
    "loss", "train_loss", "val_loss",
    "batch_idx", "batch_num",
})


def _collect_context(frame: Any) -> Dict[str, Any]:
    """Collect training context variables from the caller's frame."""
    ctx: Dict[str, Any] = {}
    if frame is None:
        return ctx
    for name, val in frame.f_locals.items():
        if name not in _CONTEXT_METRIC_NAMES:
            continue
        try:
            if hasattr(val, "item"):
                val = val.item()
            if isinstance(val, bool):
                continue
            if isinstance(val, (int, float)):
                ctx[name] = round(val, 6) if isinstance(val, float) else val
        except Exception:
            pass
    return ctx


def _get_vars_file() -> str:
    global _vars_file
    if _vars_file is None:
        local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
        os.makedirs(local_dir, exist_ok=True)
        _vars_file = os.path.join(local_dir, "variables.jsonl")
    return _vars_file


def install() -> None:
    """Patch torch LRScheduler.step() to emit LR records."""
    global _installed
    if _installed:
        return
    _installed = True

    try:
        import torch.optim.lr_scheduler as _lr_mod
    except ImportError:
        return

    # Support both old (_LRScheduler) and new (LRScheduler) names
    base_cls = getattr(_lr_mod, "LRScheduler", None) or getattr(_lr_mod, "_LRScheduler", None)
    if base_cls is None:
        return

    _original_step = base_cls.step

    def _patched_step(self: Any, *args: Any, **kwargs: Any) -> Any:
        result = _original_step(self, *args, **kwargs)

        try:
            frame = inspect.currentframe()
            caller = frame.f_back if frame else None
            if caller is None:
                return result

            src_file = caller.f_code.co_filename
            line_no = caller.f_lineno

            # Rate limit: emit every 10 steps from this call site by default
            every = int(os.environ.get("TRICKLE_LR_EVERY", "10"))
            key = f"{src_file}:{line_no}"
            count = _step_counter.get(key, 0) + 1
            _step_counter[key] = count
            if count % every != 0:
                return result

            # Get current LRs for each param group
            try:
                lrs: List[float] = [round(float(pg["lr"]), 8) for pg in self.optimizer.param_groups]
            except Exception:
                return result

            # Collect training context (epoch, step, loss, etc.)
            ctx = _collect_context(caller)
            if not ctx:
                ctx = _collect_context(caller.f_back) if caller.f_back else {}

            record: Dict[str, Any] = {
                "kind": "lr_schedule",
                "file": src_file,
                "line": line_no,
                "lrs": lrs,
                "step_num": count,
                "context": ctx,
                "timestamp": time.time(),
                "scheduler_class": type(self).__name__,
            }

            try:
                vars_file = _get_vars_file()
                with open(vars_file, "a") as f:
                    f.write(json.dumps(record) + "\n")
            except Exception:
                pass

        except Exception:
            pass
        finally:
            del frame

        return result

    base_cls.step = _patched_step
