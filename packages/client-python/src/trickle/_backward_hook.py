"""Patch torch.Tensor.backward() to re-emit nn.Module gradient info.

After loss.backward(), model parameters have .grad populated. This hook
walks the caller's frame to find nn.Module variables and re-emits their
type info (now including gradient norms) to the JSONL trace file.
"""

from __future__ import annotations

import inspect
import json
import os
from typing import Any, Callable, Optional

_installed = False
_original_backward: Any = None


def install(trace_fn: Optional[Callable] = None, file_path: Optional[str] = None) -> None:
    """Patch torch.Tensor.backward() to re-emit model gradient info.

    Parameters
    ----------
    trace_fn:
        A function with signature (value, var_name, line_no) that emits
        a variable record. If None, emits directly to variables.jsonl.
    file_path:
        The source file path for the trace record. Used when trace_fn is None.
    """
    global _installed, _original_backward
    if _installed:
        return
    _installed = True

    try:
        import torch
        import torch.nn as nn
    except ImportError:
        return

    _original_backward = torch.Tensor.backward

    def _patched_backward(self: Any, *args: Any, **kwargs: Any) -> None:
        _original_backward(self, *args, **kwargs)

        # After backward, find nn.Module variables in the caller's frame
        try:
            frame = inspect.currentframe()
            if frame is None:
                return
            caller = frame.f_back
            if caller is None:
                return

            # Search locals and globals for nn.Module instances
            candidates = {}
            for name, val in caller.f_locals.items():
                if name.startswith("_"):
                    continue
                if isinstance(val, nn.Module):
                    candidates[name] = val

            if not candidates:
                # Try one more frame up (common when backward is in a helper)
                caller2 = caller.f_back
                if caller2 is not None:
                    for name, val in caller2.f_locals.items():
                        if name.startswith("_"):
                            continue
                        if isinstance(val, nn.Module):
                            candidates[name] = val

            if not candidates:
                return

            for var_name, model in candidates.items():
                # Only re-emit if the model actually has gradients
                has_grads = any(p.grad is not None for p in model.parameters())
                if not has_grads:
                    continue

                if trace_fn is not None:
                    # Use the provided trace function
                    line_no = caller.f_lineno
                    trace_fn(model, var_name, line_no)
                else:
                    # Emit directly to JSONL
                    _emit_direct(model, var_name, caller, file_path)
        except Exception:
            pass  # Never break user code
        finally:
            del frame

    torch.Tensor.backward = _patched_backward


def _emit_direct(model: Any, var_name: str, frame: Any, file_path: Optional[str] = None) -> None:
    """Emit a model variable record directly to variables.jsonl."""
    try:
        from trickle.type_inference import infer_type

        local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
        os.makedirs(local_dir, exist_ok=True)
        vars_file = os.path.join(local_dir, "variables.jsonl")

        type_node = infer_type(model, max_depth=3)
        type_hash = json.dumps(type_node, sort_keys=True)[:32]

        # Determine file path from frame
        src_file = file_path or frame.f_code.co_filename
        line_no = frame.f_lineno

        record = {
            "kind": "variable",
            "varName": var_name,
            "line": line_no,
            "module": os.path.basename(src_file).rsplit(".", 1)[0],
            "file": src_file,
            "type": type_node,
            "typeHash": type_hash,
            "sample": f"nn.Module({var_name})",
        }

        with open(vars_file, "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass
