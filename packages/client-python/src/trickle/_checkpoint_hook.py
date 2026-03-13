"""Patch torch.save and save_pretrained to emit checkpoint records.

When `trickle.auto` is active, this module patches:
  - torch.save(obj, path)
  - transformers.PreTrainedModel.save_pretrained(path)

After each save, it scans the caller's frame locals for training metrics
(epoch, step, loss, etc.) and writes a `kind: "checkpoint"` record to
.trickle/variables.jsonl. The VSCode extension shows this as an inlay hint
on the save line, e.g.:

    torch.save(model, 'ckpt.pt')  💾 epoch=3 | step=1500 | loss=0.342

No changes to user code required beyond `import trickle.auto`.
"""
from __future__ import annotations

import inspect
import json
import os
import time
from typing import Any, Dict, List, Optional

_installed = False
_original_torch_save: Any = None
_original_save_pretrained: Any = None

# Training metric names to capture from the caller's frame
_METRIC_NAMES = frozenset({
    "epoch", "epochs", "step", "global_step", "iteration", "iter",
    "loss", "train_loss", "val_loss", "valid_loss", "best_loss",
    "acc", "accuracy", "val_acc",
    "lr", "learning_rate",
    "f1", "bleu", "rouge", "perplexity",
    "reward", "score",
})

# Track how many saves have been emitted per file:line (for the "N saves" label)
_save_counter: Dict[str, int] = {}


def _is_metric_name(name: str) -> bool:
    lower = name.lower()
    if lower in _METRIC_NAMES:
        return True
    return any(sub in lower for sub in ("loss", "acc", "epoch", "step", "lr"))


def _extract_scalar(v: Any) -> Optional[Any]:
    """Return a JSON-safe scalar or None."""
    try:
        if hasattr(v, "item"):
            v = v.item()
        if isinstance(v, bool):
            return None
        if isinstance(v, int):
            return v
        if isinstance(v, float):
            return round(v, 6)
    except Exception:
        pass
    return None


def _collect_metrics(frame: Any) -> Dict[str, Any]:
    """Scan caller's frame locals for training metric variables."""
    metrics: Dict[str, Any] = {}
    if frame is None:
        return metrics
    for name, val in frame.f_locals.items():
        if name.startswith("_"):
            continue
        if not _is_metric_name(name):
            continue
        sv = _extract_scalar(val)
        if sv is not None:
            metrics[name] = sv
    return metrics


def _get_vars_file() -> str:
    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    os.makedirs(local_dir, exist_ok=True)
    return os.path.join(local_dir, "variables.jsonl")


def _emit_checkpoint(frame: Any, path: str) -> None:
    """Write a checkpoint record to variables.jsonl."""
    try:
        src_file = frame.f_code.co_filename
        line_no = frame.f_lineno

        metrics = _collect_metrics(frame)
        # Also try one frame up (when save is in a helper function)
        if not metrics and frame.f_back is not None:
            metrics = _collect_metrics(frame.f_back)

        key = f"{src_file}:{line_no}"
        _save_counter[key] = _save_counter.get(key, 0) + 1
        save_count = _save_counter[key]

        record: Dict[str, Any] = {
            "kind": "checkpoint",
            "file": src_file,
            "line": line_no,
            "path": str(path),
            "metrics": metrics,
            "timestamp": time.time(),
            "save_count": save_count,
        }

        vars_file = _get_vars_file()
        with open(vars_file, "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass


def install() -> None:
    """Patch torch.save and transformers.save_pretrained to emit checkpoint records."""
    global _installed, _original_torch_save, _original_save_pretrained
    if _installed:
        return
    _installed = True

    # Patch torch.save
    try:
        import torch
        _original_torch_save = torch.save

        def _patched_torch_save(obj: Any, f: Any, *args: Any, **kwargs: Any) -> None:
            _original_torch_save(obj, f, *args, **kwargs)
            try:
                frame = inspect.currentframe()
                caller = frame.f_back if frame else None
                if caller is not None:
                    path = f if isinstance(f, str) else getattr(f, "name", str(f))
                    _emit_checkpoint(caller, path)
            except Exception:
                pass
            finally:
                del frame

        torch.save = _patched_torch_save
    except ImportError:
        pass

    # Patch transformers PreTrainedModel.save_pretrained
    try:
        from transformers import PreTrainedModel
        _original_save_pretrained = PreTrainedModel.save_pretrained

        def _patched_save_pretrained(self: Any, save_directory: Any, *args: Any, **kwargs: Any) -> Any:
            result = _original_save_pretrained(self, save_directory, *args, **kwargs)
            try:
                frame = inspect.currentframe()
                caller = frame.f_back if frame else None
                if caller is not None:
                    _emit_checkpoint(caller, str(save_directory))
            except Exception:
                pass
            finally:
                del frame
            return result

        PreTrainedModel.save_pretrained = _patched_save_pretrained
    except (ImportError, Exception):
        pass
