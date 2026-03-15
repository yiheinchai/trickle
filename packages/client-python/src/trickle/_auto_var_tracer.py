"""Variable tracing for trickle.auto using sys.settrace.

When `import trickle.auto` is used, the entry file isn't AST-transformed
(unlike `trickle run`), so variables aren't traced. This module fills that
gap by using sys.settrace with AST-guided assignment detection.

Strategy:
1. Parse the entry file AST to find all assignment line numbers and variable names
2. Install sys.settrace that only enables line tracing for the entry file
3. On the NEXT line/return event after an assignment, read the assigned variables
   (because "line" events fire BEFORE execution, we must defer reads)
4. Deduplication prevents repeated writes for same-type assignments in loops
"""

from __future__ import annotations

import ast
import dataclasses
import json
import os
import time as _time_mod
import sys
from typing import Any, Dict, List, Optional, Set, Tuple


_installed = False
_entry_file_setup_done = False  # tracks whether install() has run entry-file setup
_assignment_map: Dict[str, Dict[int, List[str]]] = {}  # filename -> {line_no -> [var_names]}
_cache: Dict[str, tuple] = {}  # cache_key -> (value_fingerprint, timestamp)
_sample_count: Dict[str, int] = {}  # cache_key -> count of samples taken
_MAX_SAMPLES = 5  # Max samples per (file, line, var) to avoid loop spam
_vars_file: Optional[str] = None
_entry_file: Optional[str] = None
_old_trace: Any = None
_infer_type: Any = None
_func_context: Dict[str, Dict[int, str]] = {}  # filename -> {line_no -> func_name}
# Call-site info: filename -> {line_no -> (callee_var_name, [arg_var_names])}
_call_args_map: Dict[str, Dict[int, Tuple[str, List[str]]]] = {}
# Lines inside loop bodies: filename -> set of line numbers
_loop_body_lines: Dict[str, Set[int]] = {}
# Rate-limit counters for auto-progress: "file:line" -> call count
_auto_progress_counter: Dict[str, int] = {}

# Per-frame pending state: after seeing an assignment line, we defer reading
# until the next event. Key = id(frame), value = (line_no, [var_names], func_name)
_pending: Dict[int, Tuple[int, List[str], Optional[str]]] = {}

# Training metric variable name patterns
_TRAINING_METRIC_EXACT: Set[str] = {
    "loss", "train_loss", "val_loss", "valid_loss", "test_loss", "running_loss",
    "epoch", "epochs", "step", "global_step", "batch_idx", "batch_num", "num_steps",
    "acc", "accuracy", "train_acc", "val_acc", "valid_acc",
    "lr", "learning_rate",
    "f1", "f1_score", "precision", "recall",
    "mse", "mae", "rmse", "r2",
    "reward", "score",
    "perplexity", "ppl",
    "bleu", "rouge",
    "iteration", "iter",
}

# Substrings that strongly suggest a training metric when found in a var name
_TRAINING_METRIC_SUBSTRINGS: Tuple[str, ...] = (
    "loss", "acc", "accuracy", "epoch", "step",
    "reward", "score", "perplexity", "bleu", "rouge",
)


def _parse_assignments(source: str, filename: str) -> Tuple[Dict[int, List[str]], Dict[int, str], Dict[int, Tuple[str, List[str]]], Set[int]]:
    """Parse source AST to find assignment line numbers and variable names.

    Returns:
        (assignments, func_context, call_args, loop_body_lines) where:
        - assignments: {line_no: [var_names]}
        - func_context: {line_no: qualified_func_name}
        - call_args: {line_no: (callee_var_name, [arg_var_names])} for call-site lines
        - loop_body_lines: set of line numbers that are inside for/while loop bodies
    """
    try:
        tree = ast.parse(source, filename)
    except SyntaxError:
        return {}, {}, {}, set()

    assignments: Dict[int, List[str]] = {}
    func_ctx: Dict[int, str] = {}
    call_args: Dict[int, Tuple[str, List[str]]] = {}
    loop_lines: Set[int] = set()

    def _extract_names(target: ast.AST) -> List[str]:
        if isinstance(target, ast.Name):
            return [target.id]
        if isinstance(target, (ast.Tuple, ast.List)):
            names: List[str] = []
            for elt in target.elts:
                names.extend(_extract_names(elt))
            return names
        if isinstance(target, ast.Starred):
            return _extract_names(target.value)
        return []

    def _extract_attr_names(target: ast.AST) -> List[str]:
        """Extract self.x style attribute names."""
        if isinstance(target, ast.Attribute):
            if isinstance(target.value, ast.Name) and not target.attr.startswith("_"):
                return [f"{target.value.id}.{target.attr}"]
        return []

    # Method calls that mutate the object and should trigger re-tracing
    _MUTATING_METHODS = frozenset({
        "fit", "fit_transform", "partial_fit",  # sklearn
        "train", "eval",  # PyTorch nn.Module
        "step",  # optimizer, scheduler
        "backward",  # tensor (handled by backward hook but useful as fallback)
        "load_state_dict",  # nn.Module
        "compile",  # tf.keras / torch.compile
    })

    def _extract_method_call_obj(node: ast.AST) -> Optional[str]:
        """If node is `obj.method(...)` where method is mutating, return 'obj'."""
        if not isinstance(node, ast.Expr):
            return None
        call = node.value
        if not isinstance(call, ast.Call):
            return None
        func = call.func
        if not isinstance(func, ast.Attribute):
            return None
        if func.attr not in _MUTATING_METHODS:
            return None
        if isinstance(func.value, ast.Name):
            return func.value.id
        return None

    def _visit_body(body: list, func_name: Optional[str] = None, in_loop: bool = False) -> None:
        for node in body:
            if isinstance(node, ast.ClassDef):
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        qname = f"{node.name}.{item.name}"
                        _visit_body(item.body, func_name=qname, in_loop=in_loop)
                        # Trace function parameters
                        param_names: List[str] = []
                        for arg in item.args.args + item.args.posonlyargs + item.args.kwonlyargs:
                            if arg.arg not in ("self", "cls") and not arg.arg.startswith("_"):
                                param_names.append(arg.arg)
                        if param_names:
                            line = item.lineno
                            assignments.setdefault(line, []).extend(param_names)
                            func_ctx[line] = qname
                    else:
                        _visit_body([item], func_name=None, in_loop=in_loop)
                continue

            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qname = func_name or node.name
                _visit_body(node.body, func_name=qname, in_loop=in_loop)
                # Trace function parameters
                param_names = []
                for arg in node.args.args + node.args.posonlyargs + node.args.kwonlyargs:
                    if arg.arg not in ("self", "cls") and not arg.arg.startswith("_"):
                        param_names.append(arg.arg)
                if param_names:
                    line = node.lineno
                    assignments.setdefault(line, []).extend(param_names)
                    if qname:
                        func_ctx[line] = qname
                continue

            line = getattr(node, "lineno", 0)
            if not line:
                continue

            names: List[str] = []

            if isinstance(node, ast.Assign):
                for target in node.targets:
                    names.extend(_extract_names(target))
                    names.extend(_extract_attr_names(target))
                # Detect call sites: `out = layer(x)`, `out = self.fc1(x)`, `out = model(x, mask)`
                if isinstance(node.value, ast.Call):
                    func = node.value.func
                    callee: Optional[str] = None
                    if isinstance(func, ast.Name):
                        callee = func.id
                    elif isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                        # e.g. self.fc1(x) → callee = "self.fc1" for precise identification
                        callee = f"{func.value.id}.{func.attr}"
                    if callee:
                        arg_vars = [a.id for a in node.value.args if isinstance(a, ast.Name)]
                        if arg_vars:
                            call_args[line] = (callee, arg_vars)
            elif isinstance(node, ast.AnnAssign) and node.value is not None:
                names.extend(_extract_names(node.target))
            elif isinstance(node, ast.AugAssign):
                names.extend(_extract_names(node.target))
            elif isinstance(node, (ast.For, ast.AsyncFor)):
                for_names = _extract_names(node.target)
                for_names = [n for n in for_names if not n.startswith("_")]
                if for_names:
                    assignments.setdefault(line, []).extend(for_names)
                    if func_name:
                        func_ctx[line] = func_name
                    # The loop variable line itself is a loop trigger
                    loop_lines.add(line)
                _visit_body(node.body, func_name, in_loop=True)
                if node.orelse:
                    _visit_body(node.orelse, func_name, in_loop=in_loop)
                continue

            # Detect mutating method calls: rf.fit(...), model.train(), etc.
            if not names:
                obj_name = _extract_method_call_obj(node)
                if obj_name and not obj_name.startswith("_"):
                    names.append(obj_name)

            # Filter and store
            names = [n for n in names if not n.startswith("_")]
            if names:
                assignments.setdefault(line, []).extend(names)
                if func_name:
                    func_ctx[line] = func_name
                if in_loop:
                    loop_lines.add(line)

            # Recurse into compound statements
            if isinstance(node, (ast.If, ast.While)):
                _visit_body(node.body, func_name, in_loop=in_loop or isinstance(node, ast.While))
                if node.orelse:
                    _visit_body(node.orelse, func_name, in_loop=in_loop)
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                for item in node.items:
                    if item.optional_vars:
                        as_names = _extract_names(item.optional_vars)
                        as_names = [n for n in as_names if not n.startswith("_")]
                        if as_names:
                            assignments.setdefault(line, []).extend(as_names)
                            if func_name:
                                func_ctx[line] = func_name
                            if in_loop:
                                loop_lines.add(line)
                _visit_body(node.body, func_name, in_loop=in_loop)
            elif isinstance(node, ast.Try):
                _visit_body(node.body, func_name, in_loop=in_loop)
                for handler in node.handlers:
                    if handler.name and not handler.name.startswith("_"):
                        hline = getattr(handler, "lineno", 0)
                        if hline:
                            assignments.setdefault(hline, []).append(handler.name)
                            if func_name:
                                func_ctx[hline] = func_name
                    _visit_body(handler.body, func_name, in_loop=in_loop)
                if node.orelse:
                    _visit_body(node.orelse, func_name, in_loop=in_loop)
                if node.finalbody:
                    _visit_body(node.finalbody, func_name, in_loop=in_loop)

    _visit_body(tree.body)
    return assignments, func_ctx, call_args, loop_lines


def _simple_scalar(v: Any) -> Any:
    """Return a JSON-safe scalar for a field value.
    Scalars returned as-is; nested structured objects shown as 'ClassName(...)'."""
    if v is None or isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        return v[:40]
    cls_name = type(v).__name__
    if cls_name not in ('list', 'dict', 'tuple', 'set'):
        return f"{cls_name}(...)"
    return None


def _is_training_metric(name: str) -> bool:
    """Return True if the variable name looks like a training metric."""
    lower = name.lower()
    if lower in _TRAINING_METRIC_EXACT:
        return True
    for sub in _TRAINING_METRIC_SUBSTRINGS:
        if sub in lower:
            return True
    return False


def _scalar_metric_value(v: Any) -> Any:
    """Extract a JSON-safe numeric scalar for a metric value, or None if not scalar."""
    try:
        # Unwrap PyTorch/NumPy scalar tensors
        if hasattr(v, "item"):
            v = v.item()
        if isinstance(v, bool):
            return None  # bools are rarely useful metrics
        if isinstance(v, int):
            return v
        if isinstance(v, float):
            return round(v, 6)
    except Exception:
        pass
    return None


def _auto_emit_progress(frame: Any, trigger_line: int, filename: str) -> None:
    """Scan frame locals for training metrics and emit a progress record.

    Called when a training metric variable is assigned inside a loop.
    Rate-limited: emits at most once every TRICKLE_AUTO_PROGRESS_EVERY calls
    from the same line (default: every 10).
    """
    global _vars_file

    try:
        every = int(os.environ.get("TRICKLE_AUTO_PROGRESS_EVERY", "10"))
    except ValueError:
        every = 10

    key = f"{filename}:{trigger_line}"
    count = _auto_progress_counter.get(key, 0) + 1
    _auto_progress_counter[key] = count
    if count % every != 0:
        return

    try:
        locals_dict = frame.f_locals
        metrics: dict = {}
        for name, val in locals_dict.items():
            if name.startswith("_"):
                continue
            if not _is_training_metric(name):
                continue
            sv = _scalar_metric_value(val)
            if sv is not None:
                metrics[name] = sv

        if not metrics:
            return

        if _vars_file is None:
            local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
            os.makedirs(local_dir, exist_ok=True)
            _vars_file = os.path.join(local_dir, "variables.jsonl")

        import time
        record = {
            "kind": "progress",
            "file": filename,
            "line": trigger_line,
            "metrics": metrics,
            "timestamp": time.time(),
            "call_count": count,
            "auto": True,
        }
        with open(_vars_file, "a") as f:
            f.write(json.dumps(record) + "\n")

    except Exception:
        pass


# Priority fields to show first for HuggingFace-style configs.
# These capture the most architecturally significant parameters.
_HF_PRIORITY_FIELDS = (
    "vocab_size", "hidden_size", "n_embd", "d_model",
    "num_hidden_layers", "n_layer", "num_layers",
    "num_attention_heads", "n_head", "num_heads",
    "intermediate_size", "n_positions", "max_position_embeddings",
    "model_type",
)


def _extract_config_fields(config: Any) -> dict:
    """Extract primitive (int/float/bool/str) fields from a config object.

    Handles dataclasses, Pydantic v1/v2, HuggingFace PretrainedConfig
    (via to_dict()), and plain objects with __dict__.

    Returns an ordered dict with priority fields first.
    """
    raw: dict = {}

    if dataclasses.is_dataclass(config) and not isinstance(config, type):
        for f in list(dataclasses.fields(config))[:15]:
            val = getattr(config, f.name, None)
            if isinstance(val, (int, float, bool, str)) and not callable(val):
                raw[f.name] = val
    elif hasattr(type(config), "model_fields"):
        # Pydantic v2
        for fname in list(type(config).model_fields.keys())[:15]:
            val = getattr(config, fname, None)
            if isinstance(val, (int, float, bool, str)) and not callable(val):
                raw[fname] = val
    elif hasattr(type(config), "__fields__"):
        # Pydantic v1
        for fname in list(type(config).__fields__.keys())[:15]:
            val = getattr(config, fname, None)
            if isinstance(val, (int, float, bool, str)) and not callable(val):
                raw[fname] = val
    elif hasattr(config, "to_dict") and hasattr(config, "model_type"):
        # HuggingFace PretrainedConfig — use to_dict() for canonical fields
        try:
            d = config.to_dict()
            for k, v in d.items():
                if not k.startswith("_") and isinstance(v, (int, float, bool, str)) and not callable(v):
                    raw[k] = v
        except Exception:
            pass
    elif hasattr(config, "__dict__"):
        for fname, val in list(vars(config).items())[:15]:
            if not fname.startswith("_") and isinstance(val, (int, float, bool, str)) and not callable(val):
                raw[fname] = val

    if not raw:
        return {}

    # Re-order: priority fields first, then the rest
    ordered: dict = {}
    for pf in _HF_PRIORITY_FIELDS:
        if pf in raw:
            ordered[pf] = raw[pf]
    for k, v in raw.items():
        if k not in ordered:
            ordered[k] = v
    return ordered


def _config_call_sample(value: Any) -> Optional[str]:
    """If value is a class instance with a `config` attribute that has primitive fields,
    return a constructor-call style string like 'GPT2(vocab_size=50257, n_embd=768, n_layer=12)'.
    Returns None if not applicable."""
    try:
        config = getattr(value, "config", None)
        if config is None or isinstance(config, (int, float, bool, str, type)):
            return None
        cls_name = type(value).__name__
        fields = _extract_config_fields(config)
        if not fields:
            return None
        # Show up to 5 fields in constructor-call notation
        items = list(fields.items())[:5]
        args = ", ".join(f"{k}={v}" for k, v in items)
        if len(fields) > 5:
            args += f", +{len(fields) - 5}"
        return f"{cls_name}({args})"
    except Exception:
        return None


def _trace_var(value: Any, var_name: str, line_no: int, file_path: str,
               module_name: str, func_name: Optional[str] = None,
               call_flow: Optional[dict] = None) -> None:
    """Trace a single variable assignment."""
    global _vars_file

    try:
        if _vars_file is None:
            local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
            os.makedirs(local_dir, exist_ok=True)
            _vars_file = os.path.join(local_dir, "variables.jsonl")

        type_node = _infer_type(value, max_depth=3)
        type_hash = json.dumps(type_node, sort_keys=True)[:32]

        # Per-line sample count limit: stop after N samples to avoid loop spam
        cache_key = f"{file_path}:{line_no}:{var_name}"
        cnt = _sample_count.get(cache_key, 0)
        if cnt >= _MAX_SAMPLES:
            return

        # Value-aware dedup: re-send if value changed or 10s elapsed (for training loops)
        try:
            t = type(value)
            if t in (int, float, bool, str) or value is None:
                val_fp = str(value)[:60]
            elif hasattr(value, "item") and hasattr(value, "numel") and value.numel() <= 1:
                val_fp = str(value.item())  # scalar tensor
            else:
                val_fp = type_hash
        except Exception:
            val_fp = type_hash

        now = _time_mod.time()
        prev = _cache.get(cache_key)
        if prev is not None:
            prev_fp, prev_ts = prev
            if prev_fp == val_fp and (now - prev_ts) < 10.0:
                return
        _cache[cache_key] = (val_fp, now)
        _sample_count[cache_key] = cnt + 1

        # Debug: uncomment to trace dedup decisions
        # import sys as _dbg_sys
        # _dbg_sys.stderr.write(f"[trickle-dbg] EMIT {var_name}={val_fp} at L{line_no} (prev={prev})\n")

        # Build sample
        sample: Any = None
        if hasattr(value, "shape") and hasattr(value, "dtype"):
            parts = [f"shape={list(value.shape)}", f"dtype={value.dtype}"]
            if hasattr(value, "device"):
                parts.append(f"device={value.device}")
            sample = f"{type(value).__name__}({', '.join(parts)})"
        elif isinstance(value, bool):
            sample = value
        elif isinstance(value, (int, float)):
            sample = value
        elif isinstance(value, str):
            sample = value[:100]
        elif hasattr(value, '_fields') and isinstance(value, tuple):
            # NamedTuple — emit field dict for structured display
            sample = {f: _simple_scalar(getattr(value, f, None)) for f in list(value._fields)[:8]}
        elif dataclasses.is_dataclass(value) and not isinstance(value, type):
            # Dataclass — emit field dict for structured display
            sample = {f.name: _simple_scalar(getattr(value, f.name, None))
                      for f in list(dataclasses.fields(value))[:8]}
        elif hasattr(type(value), 'model_fields') and hasattr(value, 'model_dump'):
            # Pydantic v2
            try:
                fields = list(type(value).model_fields.keys())[:8]
                sample = {f: _simple_scalar(getattr(value, f, None)) for f in fields}
            except Exception:
                sample = str(value)[:100]
        elif hasattr(type(value), '__fields__') and hasattr(value, 'dict'):
            # Pydantic v1
            try:
                fields = list(type(value).__fields__.keys())[:8]
                sample = {f: _simple_scalar(getattr(value, f, None)) for f in fields}
            except Exception:
                sample = str(value)[:100]
        elif hasattr(value, "to_dict") and hasattr(value, "model_type"):
            # HuggingFace PretrainedConfig — show priority fields as a dict sample
            try:
                fields = _extract_config_fields(value)
                sample = {k: v for k, v in list(fields.items())[:8]}
            except Exception:
                sample = str(value)[:100]
        elif isinstance(value, dict) and len(value) <= 20:
            # Plain dict with string keys + primitive values — build a JSON-serializable
            # sample so the VSCode renderer can show {key: value} inline
            try:
                sample_dict = {}
                for k, v in list(value.items())[:20]:
                    if isinstance(k, str):
                        sv = _simple_scalar(v)
                        if sv is not None:
                            sample_dict[k] = sv
                sample = sample_dict if sample_dict else str(value)[:100]
            except Exception:
                sample = str(value)[:100]
        else:
            # For class instances with a `config` attribute, generate a constructor-call
            # style sample: "GPT(vocab_size=50257, n_embd=768, n_layer=12)" — this is the ML
            # convention and gives much more useful context than str(value)[:100].
            config_sample = _config_call_sample(value)
            if config_sample is not None:
                sample = config_sample
            else:
                sample = str(value)[:100]

        record: dict = {
            "kind": "variable",
            "varName": var_name,
            "line": line_no,
            "module": module_name,
            "file": file_path,
            "type": type_node,
            "typeHash": type_hash,
            "sample": sample,
        }
        if func_name:
            record["funcName"] = func_name
        if call_flow:
            record["callFlow"] = call_flow

        # Memory profiling: capture GPU memory for CUDA tensors, CPU RSS for others
        if hasattr(value, "shape") and hasattr(value, "dtype"):
            try:
                import torch
                if hasattr(value, "is_cuda") and value.is_cuda:
                    device = getattr(value, "device", None)
                    alloc = torch.cuda.memory_allocated(device)
                    reserved = torch.cuda.memory_reserved(device)
                    record["gpu_memory_mb"] = round(alloc / (1024 * 1024), 1)
                    record["gpu_reserved_mb"] = round(reserved / (1024 * 1024), 1)
                else:
                    # CPU tensor: show total process memory via resource module (no psutil needed)
                    try:
                        import resource
                        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
                        # On macOS ru_maxrss is bytes, on Linux it's KB
                        import platform
                        if platform.system() == "Darwin":
                            record["cpu_memory_mb"] = round(rss / (1024 * 1024), 1)
                        else:
                            record["cpu_memory_mb"] = round(rss / 1024, 1)
                    except Exception:
                        pass
            except Exception:
                pass

        with open(_vars_file, "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass


def _resolve_dotted(name: str, locals_dict: dict) -> Any:
    """Resolve a simple name or dotted name (e.g. 'self.fc1') from locals."""
    parts = name.split(".", 1)
    obj = locals_dict.get(parts[0])
    if obj is None:
        return None
    if len(parts) == 1:
        return obj
    return getattr(obj, parts[1], None)


def _build_call_flow(filename: str, line_no: int, locals_dict: dict) -> Optional[dict]:
    """Build a callFlow dict for a call-site line, or None if not a call site."""
    call_info = _call_args_map.get(filename, {}).get(line_no)
    if not call_info:
        return None
    callee_name, arg_names = call_info
    try:
        callee_val = _resolve_dotted(callee_name, locals_dict)
        callee_class = type(callee_val).__name__ if callee_val is not None else None
        inputs = []
        for arg_name in arg_names:
            arg_val = locals_dict.get(arg_name)
            if arg_val is not None:
                inputs.append({"name": arg_name, "type": _infer_type(arg_val, max_depth=2)})
        if callee_class or inputs:
            return {"callee": callee_name, "calleeClass": callee_class, "inputs": inputs}
    except Exception:
        pass
    return None


def _flush_pending(frame: Any) -> None:
    """Read variables from a pending assignment (the previous line has now executed)."""
    fid = id(frame)
    pending = _pending.pop(fid, None)
    if pending is None:
        return

    line_no, var_names, func_name = pending
    filename = frame.f_code.co_filename
    locals_dict = frame.f_locals
    module_name = os.path.basename(filename).rsplit(".", 1)[0]
    call_flow = _build_call_flow(filename, line_no, locals_dict)

    for name in var_names:
        try:
            if "." in name:
                # Attribute access like self.fc1
                parts = name.split(".", 1)
                obj = locals_dict.get(parts[0])
                if obj is not None:
                    val = getattr(obj, parts[1], None)
                    if val is not None:
                        _trace_var(val, name, line_no, filename, module_name, func_name, call_flow)
            else:
                val = locals_dict.get(name)
                if val is not None:
                    _trace_var(val, name, line_no, filename, module_name, func_name, call_flow)
        except Exception:
            pass

    # Auto-progress: if this line is inside a loop and any assigned var looks like
    # a training metric, collect all metric locals and emit a progress record.
    try:
        loop_set = _loop_body_lines.get(filename)
        if loop_set and line_no in loop_set:
            if any(_is_training_metric(n.split(".")[-1]) for n in var_names):
                _auto_emit_progress(frame, line_no, filename)
    except Exception:
        pass


# CO_COROUTINE flag: set on async def functions. Use inspect to get the correct
# value for this Python version (0x80 in Python 3.5-3.11, may differ elsewhere).
try:
    import inspect as _inspect
    _CO_COROUTINE = _inspect.CO_COROUTINE
except AttributeError:
    _CO_COROUTINE = 0x100  # fallback


def _flush_pending_available(frame: Any) -> None:
    """Flush pending variables that are already in locals; keep the rest pending.

    Used on coroutine suspension (return event from an async frame): the
    assigned variable may not be in locals yet because the await hasn't
    completed. We flush only what's available and leave the rest for the
    exception event that fires when the coroutine resumes.
    """
    fid = id(frame)
    pending = _pending.get(fid)
    if pending is None:
        return

    line_no, var_names, func_name = pending
    filename = frame.f_code.co_filename
    locals_dict = frame.f_locals
    module_name = os.path.basename(filename).rsplit(".", 1)[0]

    unflushed: List[str] = []
    for name in var_names:
        try:
            if "." in name:
                parts = name.split(".", 1)
                obj = locals_dict.get(parts[0])
                if obj is not None:
                    val = getattr(obj, parts[1], None)
                    if val is not None:
                        _trace_var(val, name, line_no, filename, module_name, func_name)
                    else:
                        unflushed.append(name)
                else:
                    unflushed.append(name)
            else:
                val = locals_dict.get(name)
                if val is not None:
                    _trace_var(val, name, line_no, filename, module_name, func_name)
                else:
                    unflushed.append(name)
        except Exception:
            pass

    if unflushed:
        _pending[fid] = (line_no, unflushed, func_name)
    else:
        del _pending[fid]


def _local_trace(frame: Any, event: str, arg: Any) -> Any:
    """Per-frame trace function — fires on line/return/exception events for traced frames."""
    try:
        if event == "line":
            # First, flush any pending assignment from the previous line
            _flush_pending(frame)

            # Check if current line is an assignment line
            filename = frame.f_code.co_filename
            line_map = _assignment_map.get(filename)
            if line_map is not None:
                lineno = frame.f_lineno
                var_names = line_map.get(lineno)
                if var_names is not None:
                    func_map = _func_context.get(filename, {})
                    func_name = func_map.get(lineno)
                    _pending[id(frame)] = (lineno, var_names, func_name)

            return _local_trace

        if event == "return":
            # For coroutine frames (async def), a "return" event fires on suspension
            # at each `await` point — NOT just on actual function return. At suspension
            # the awaited variable is not yet assigned, so we only flush vars already
            # in locals and keep the rest pending for the exception event that follows.
            is_coro = bool(frame.f_code.co_flags & _CO_COROUTINE)
            if is_coro:
                _flush_pending_available(frame)
            else:
                _flush_pending(frame)
            return None

        if event == "exception":
            # For coroutines, an "exception" event fires when the frame resumes after
            # an `await` completes (Python uses StopIteration internally). However,
            # the awaited variable is assigned AFTER this event and BEFORE the next
            # `line` event. So we use _flush_pending_available here to only flush vars
            # already in locals, keeping the rest pending for the upcoming `line` event.
            _flush_pending_available(frame)
            return _local_trace

    except Exception:
        pass  # Never let trace function raise — Python would disable tracing and print error

    return _local_trace


def _global_trace(frame: Any, event: str, arg: Any) -> Any:
    """Global trace function — enables line tracing only for traced files."""
    try:
        if event == "call":
            filename = frame.f_code.co_filename
            if filename in _assignment_map:
                return _local_trace
    except Exception:
        pass
    return None


def install() -> None:
    """Install sys.settrace-based variable tracer for the entry file.

    Parses the entry file's AST to find assignment lines, then installs
    a trace function that captures variable values on those lines.
    """
    global _installed, _entry_file_setup_done, _entry_file, _old_trace, _infer_type

    if _entry_file_setup_done:
        return
    _entry_file_setup_done = True

    # Check if variable tracing is enabled
    if os.environ.get("TRICKLE_TRACE_VARS", "1") in ("0", "false"):
        return

    # Skip in IPython — notebooks use %load_ext trickle instead
    try:
        get_ipython()  # type: ignore[name-defined]  # noqa: F821
        return
    except NameError:
        pass

    if not hasattr(sys, "argv") or not sys.argv:
        return

    candidate = os.path.abspath(sys.argv[0])
    if not os.path.isfile(candidate):
        return

    _entry_file = candidate

    # Read and parse the entry file
    try:
        with open(_entry_file, "r", encoding="utf-8") as f:
            source = f.read()
    except Exception:
        return

    assignments, func_ctx, call_args, loop_lines = _parse_assignments(source, _entry_file)
    if not assignments:
        return

    # Register under both the logical path (abspath) and the real path (realpath).
    # On macOS /tmp is a symlink to /private/tmp, so frame.f_code.co_filename may
    # differ from os.path.abspath(sys.argv[0]).
    _entry_file_real = os.path.realpath(_entry_file)
    _assignment_map[_entry_file] = assignments
    _func_context[_entry_file] = func_ctx
    if _entry_file_real != _entry_file:
        _assignment_map[_entry_file_real] = assignments
        _func_context[_entry_file_real] = func_ctx
    if call_args:
        _call_args_map[_entry_file] = call_args
        if _entry_file_real != _entry_file:
            _call_args_map[_entry_file_real] = call_args
    if loop_lines:
        _loop_body_lines[_entry_file] = loop_lines
        if _entry_file_real != _entry_file:
            _loop_body_lines[_entry_file_real] = loop_lines

    # Import type inference lazily
    if _infer_type is None:
        from trickle.type_inference import infer_type
        _infer_type = infer_type

    # Install the trace function (only if not already installed by install_files/activate)
    # Note: sys.settrace and sys.setprofile are independent — both can coexist
    if not _installed:
        _installed = True
        _old_trace = sys.gettrace()
        sys.settrace(_global_trace)

    # Always set f_trace on the caller's frame chain so that module-level code
    # (which is already executing when we're imported) gets line tracing too.
    # This must be done even if settrace was already active (e.g. via install_files).
    frame = sys._getframe(0)
    while frame is not None:
        fname = frame.f_code.co_filename
        if fname == _entry_file or fname == _entry_file_real:
            frame.f_trace = _local_trace
            break
        frame = frame.f_back

    debug = os.environ.get("TRICKLE_DEBUG", "").lower() in ("1", "true", "yes")
    if debug:
        print(f"[trickle.auto] Variable tracer installed: {len(assignments)} assignment lines in {os.path.basename(_entry_file)}")


def _activate() -> None:
    """Activate sys.settrace without entry-file discovery (used by pytest plugin)."""
    global _installed, _old_trace, _infer_type

    if _installed:
        return
    _installed = True

    if _infer_type is None:
        from trickle.type_inference import infer_type
        _infer_type = infer_type

    _old_trace = sys.gettrace()
    sys.settrace(_global_trace)


def install_files(file_paths: List[str]) -> None:
    """Register additional source files for variable tracing.

    Parses each file's AST to find assignment lines, then activates
    sys.settrace if not already running. Designed for use by the pytest plugin.
    """
    for fpath in file_paths:
        if fpath in _assignment_map:
            continue
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                source = f.read()
        except Exception:
            continue

        assignments, func_ctx, call_args, loop_lines = _parse_assignments(source, fpath)
        if assignments:
            _assignment_map[fpath] = assignments
            _func_context[fpath] = func_ctx
            if call_args:
                _call_args_map[fpath] = call_args
            if loop_lines:
                _loop_body_lines[fpath] = loop_lines

    if file_paths:
        _activate()

    debug = os.environ.get("TRICKLE_DEBUG", "").lower() in ("1", "true", "yes")
    if debug:
        registered = [p for p in file_paths if p in _assignment_map]
        print(f"[trickle] install_files: registered {len(registered)}/{len(file_paths)} files")
