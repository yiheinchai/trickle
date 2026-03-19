"""IPython/Jupyter notebook integration for trickle variable tracing.

Enables runtime type and tensor shape tracing in Jupyter notebook cells.
After loading, every cell execution is automatically instrumented — variable
types, tensor shapes, and sample values are written to .trickle/variables.jsonl,
which the VSCode extension picks up for inline hints and hover information.

Usage in a notebook::

    %load_ext trickle

    # All subsequent cells are traced automatically
    import torch
    x = torch.randn(4, 8, 32)
    # Hover over `x` in VSCode to see: Tensor[4, 8, 32] float32

Or activate programmatically::

    import trickle.notebook
    trickle.notebook.activate()
"""

from __future__ import annotations

import ast
import json
import os
import sys
from typing import Any, Dict, Optional, Set


# ---------------------------------------------------------------------------
# Shared tracer state (single instance per kernel)
# ---------------------------------------------------------------------------

# Max characters for sample string values. Override with TRICKLE_SAMPLE_LEN env var.
SAMPLE_LEN = int(os.environ.get("TRICKLE_SAMPLE_LEN", "200"))

_tv_cache: Dict[str, tuple] = {}  # cache_key -> (value_fingerprint, timestamp)
_tv_sample_count: Dict[str, int] = {}  # per-line sample count
_MAX_SAMPLES = 5
_tv_file: Optional[str] = None
_cell_counter: int = 0
_notebook_path: Optional[str] = None
_active = False

# Shape change tracking: maps (var_name, func_name_or_empty) -> shape_str
_prev_shapes: dict = {}
_curr_shapes: dict = {}
_current_cell_idx: int = 0

# Scalar tensor aggregation: tracks how scalar values evolve in loops
# Key: (cell_id, line_no, var_name) -> {first, last, min, max, count}
_scalar_agg: dict = {}


def _get_vars_file() -> str:
    """Get (and lazily create) the path to variables.jsonl."""
    global _tv_file
    if _tv_file is not None:
        return _tv_file

    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    os.makedirs(local_dir, exist_ok=True)
    _tv_file = os.path.join(local_dir, "variables.jsonl")
    return _tv_file


def _trickle_tv(value: Any, var_name: str, line_no: int, cell_id: str, cell_idx: int,
                func_name: Optional[str] = None) -> None:
    """Trace a variable assignment in a notebook cell.

    This is injected into each cell's namespace and called after every
    variable assignment. It infers the runtime type (including tensor
    shapes) and appends to .trickle/variables.jsonl.
    """
    try:
        from .type_inference import infer_type

        type_node = infer_type(value, max_depth=3)
        type_hash = json.dumps(type_node, sort_keys=True)[:32]

        # Per-line sample count limit and value-aware dedup
        cache_key = f"{cell_id}:{line_no}:{var_name}"
        cnt = _tv_sample_count.get(cache_key, 0)
        if cnt >= _MAX_SAMPLES:
            return

        t = type(value)
        if t in (int, float, bool, str) or value is None:
            val_fp = str(value)[:60]
        elif hasattr(value, "item") and hasattr(value, "numel") and value.numel() <= 1:
            val_fp = str(value.item())
        else:
            val_fp = type_hash

        import time as _time_mod
        now = _time_mod.time()
        prev = _tv_cache.get(cache_key)
        if prev is not None:
            prev_fp, prev_ts = prev
            if prev_fp == val_fp and (now - prev_ts) < 10.0:
                # Same value within 10s — still track scalar aggregation
                _try_scalar_agg(value, var_name, line_no, cell_id, func_name)
                return
        _tv_cache[cache_key] = (val_fp, now)
        _tv_sample_count[cache_key] = cnt + 1

        # Build sample
        sample: Any = None
        if hasattr(value, "shape") and hasattr(value, "dtype"):
            shape = value.shape
            if hasattr(shape, '__len__') and len(shape) == 0:
                # Scalar tensor/numpy scalar — show actual value
                sample = value.item() if hasattr(value, "item") else float(value)
            else:
                # Use lovely-tensors repr if available, otherwise our own compact format
                s = str(value)[:SAMPLE_LEN]
                if s.startswith("tensor["):
                    sample = s
                else:
                    parts = [f"shape={list(shape)}", f"dtype={value.dtype}"]
                    if hasattr(value, "device"):
                        parts.append(f"device={value.device}")
                    sample = f'{type(value).__name__}({", ".join(parts)})'
        elif isinstance(value, (int, float, bool)):
            sample = value
        elif isinstance(value, str):
            sample = value[:SAMPLE_LEN]
        elif isinstance(value, (list, tuple)):
            # Serialize list/tuple elements so the VSCode renderer can show them expandably
            try:
                items = []
                for item in value[:30]:
                    if item is None or isinstance(item, (bool, int, float)):
                        items.append(item)
                    elif isinstance(item, str):
                        items.append(item[:80])
                    elif hasattr(item, "shape") and hasattr(item, "dtype"):
                        # Tensor/ndarray — use attribute-based summary (avoids lovely-tensors repr)
                        p = [f"shape={list(item.shape)}", f"dtype={item.dtype}"]
                        if hasattr(item, "device"):
                            p.append(f"device={item.device}")
                        items.append(f"{type(item).__name__}({', '.join(p)})")
                    else:
                        items.append(str(item)[:80])
                sample = items
                if len(value) > 30:
                    sample.append(f"... ({len(value)} total)")
            except Exception:
                sample = str(value)[:SAMPLE_LEN]
        else:
            sample = str(value)[:SAMPLE_LEN]

        record: dict = {
            "kind": "variable",
            "varName": var_name,
            "line": line_no,
            "module": f"cell_{cell_idx}",
            "file": cell_id,
            "cellIndex": cell_idx,
            "type": type_node,
            "typeHash": type_hash,
            "sample": sample,
        }
        if func_name:
            record["funcName"] = func_name

        # Track tensor shapes for change detection on re-run
        shape_node = type_node.get("properties", {}).get("shape", {})
        if shape_node.get("kind") == "primitive" and shape_node.get("name", "").startswith("["):
            key = (var_name, func_name or "")
            _curr_shapes[key] = (shape_node["name"], str(type_node.get("properties", {}).get("dtype", {}).get("name", "")), line_no)

        vars_file = _get_vars_file()
        with open(vars_file, "a") as f:
            f.write(json.dumps(record) + "\n")

        # Initialize scalar aggregation for first occurrence
        _try_scalar_agg_init(value, var_name, line_no, cell_id, cell_idx, func_name, type_node)
    except Exception:
        pass  # Never break user code


# ---------------------------------------------------------------------------
# Scalar tensor aggregation — track loss/metric evolution in loops
# ---------------------------------------------------------------------------

def _get_scalar_value(value: Any) -> Optional[float]:
    """Extract a float from a scalar tensor or Python number."""
    try:
        if hasattr(value, "numel") and hasattr(value, "item"):
            if value.numel() == 1:
                return float(value.detach().item())
        elif isinstance(value, (int, float)):
            return float(value)
    except Exception:
        pass
    return None


def _try_scalar_agg_init(value: Any, var_name: str, line_no: int, cell_id: str,
                         cell_idx: int, func_name: Optional[str], type_node: dict) -> None:
    """Initialize scalar aggregation for a newly traced variable."""
    v = _get_scalar_value(value)
    if v is None:
        return
    key = (cell_id, line_no, var_name, func_name or "")
    _scalar_agg[key] = {
        "first": v, "last": v, "min": v, "max": v, "count": 1,
        "cell_idx": cell_idx, "func_name": func_name, "type_node": type_node,
    }


def _try_scalar_agg(value: Any, var_name: str, line_no: int, cell_id: str,
                    func_name: Optional[str]) -> None:
    """Update scalar aggregation when a dedup cache hit occurs."""
    v = _get_scalar_value(value)
    if v is None:
        return
    key = (cell_id, line_no, var_name, func_name or "")
    agg = _scalar_agg.get(key)
    if agg is None:
        return
    agg["last"] = v
    agg["count"] += 1
    if v < agg["min"]:
        agg["min"] = v
    if v > agg["max"]:
        agg["max"] = v


def _write_scalar_agg_records() -> None:
    """Write final aggregated scalar records to variables.jsonl."""
    if not _scalar_agg:
        return
    vars_file = _get_vars_file()
    records: list = []
    for (cell_id, line_no, var_name, func_key), agg in _scalar_agg.items():
        if agg["count"] <= 1:
            continue  # Only write aggregates for variables traced multiple times
        type_node = dict(agg["type_node"])
        props = dict(type_node.get("properties", {}))
        # Update the value to the last observed value
        props["value"] = {"kind": "primitive", "name": f"{agg['last']:.6g}"}
        # Add aggregation stats
        props["agg_first"] = {"kind": "primitive", "name": f"{agg['first']:.6g}"}
        props["agg_last"] = {"kind": "primitive", "name": f"{agg['last']:.6g}"}
        props["agg_min"] = {"kind": "primitive", "name": f"{agg['min']:.6g}"}
        props["agg_max"] = {"kind": "primitive", "name": f"{agg['max']:.6g}"}
        props["agg_steps"] = {"kind": "primitive", "name": str(agg["count"])}
        type_node["properties"] = props
        record = {
            "kind": "variable",
            "varName": var_name,
            "line": line_no,
            "module": f"cell_{agg['cell_idx']}",
            "file": cell_id,
            "cellIndex": agg["cell_idx"],
            "type": type_node,
            "typeHash": json.dumps(type_node, sort_keys=True)[:32],
        }
        if agg["func_name"]:
            record["funcName"] = agg["func_name"]
        records.append(record)
    if records:
        with open(vars_file, "a") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")


def _print_scalar_agg_summary() -> None:
    """Print a summary of scalar value evolution after cell execution."""
    if not _scalar_agg:
        return
    summaries: list = []
    for (cell_id, line_no, var_name, func_key), agg in _scalar_agg.items():
        if agg["count"] <= 1:
            continue
        display_name = f"{func_key}.{var_name}" if func_key else var_name
        first, last = agg["first"], agg["last"]
        mn, mx = agg["min"], agg["max"]
        steps = agg["count"]
        trend = "↓" if last < first else ("↑" if last > first else "→")
        summaries.append(
            f"  {display_name} (L{line_no}): {first:.4g} {trend} {last:.4g} "
            f"(min={mn:.4g}, max={mx:.4g}, {steps} steps)"
        )
    if summaries:
        print("[trickle] Scalar tracking:")
        print("\n".join(summaries))


# ---------------------------------------------------------------------------
# AST Transformer — rewrites each cell to insert _trickle_tv() calls
# ---------------------------------------------------------------------------

class _TrickleCellTransformer(ast.NodeTransformer):
    """IPython AST transformer that inserts variable trace calls into cells."""

    def __init__(self) -> None:
        super().__init__()
        self._cell_idx = 0
        self._cell_id = ""

    def transform(self, node: ast.Module, cell_idx: int, cell_id: str) -> ast.Module:
        """Transform a cell's AST to insert trace calls."""
        self._cell_idx = cell_idx
        self._cell_id = cell_id
        node.body = self._transform_body(node.body)
        ast.fix_missing_locations(node)
        return node

    def _transform_body(self, body: list) -> list:
        """Insert trace calls after assignments and recurse into compound stmts."""
        new_body: list = []
        for node in body:
            new_body.append(node)

            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                # Recurse into function bodies with parameter traces
                func_name = node.name
                param_traces = self._make_param_traces(node, func_name=func_name)
                node.body = param_traces + self._transform_func_body(node.body, func_name=func_name)
                continue

            if isinstance(node, ast.ClassDef):
                # Recurse into class bodies (methods)
                class_name = node.name
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        func_name = f"{class_name}.{item.name}"
                        param_traces = self._make_param_traces(item, func_name=func_name)
                        item.body = param_traces + self._transform_func_body(item.body, func_name=func_name)
                continue

            if isinstance(node, (ast.For, ast.AsyncFor)):
                traces = self._make_for_traces(node)
                node.body = traces + self._transform_body(node.body)
                if node.orelse:
                    node.orelse = self._transform_body(node.orelse)
                continue

            if isinstance(node, (ast.If, ast.While)):
                node.body = self._transform_body(node.body)
                if node.orelse:
                    node.orelse = self._transform_body(node.orelse)
                continue

            if isinstance(node, (ast.With, ast.AsyncWith)):
                node.body = self._transform_body(node.body)
                continue

            if isinstance(node, ast.Try):
                node.body = self._transform_body(node.body)
                for handler in node.handlers:
                    handler.body = self._transform_body(handler.body)
                if node.orelse:
                    node.orelse = self._transform_body(node.orelse)
                if node.finalbody:
                    node.finalbody = self._transform_body(node.finalbody)
                continue

            traces = self._make_traces(node)
            new_body.extend(traces)

        return new_body

    def _transform_func_body(self, body: list, func_name: str | None = None) -> list:
        """Insert trace calls inside function bodies."""
        new_body: list = []
        for node in body:
            # Intercept return statements with a value — trace the return value
            if isinstance(node, ast.Return) and node.value is not None:
                new_body.extend(self._make_return_trace(node, func_name=func_name))
                continue

            new_body.append(node)

            if isinstance(node, (ast.For, ast.AsyncFor)):
                traces = self._make_for_traces(node, func_name=func_name)
                node.body = traces + self._transform_func_body(node.body, func_name=func_name)
                if node.orelse:
                    node.orelse = self._transform_func_body(node.orelse, func_name=func_name)
                continue

            if isinstance(node, (ast.If, ast.While)):
                node.body = self._transform_func_body(node.body, func_name=func_name)
                if node.orelse:
                    node.orelse = self._transform_func_body(node.orelse, func_name=func_name)
                continue

            if isinstance(node, (ast.With, ast.AsyncWith)):
                node.body = self._transform_func_body(node.body, func_name=func_name)
                continue

            if isinstance(node, ast.Try):
                node.body = self._transform_func_body(node.body, func_name=func_name)
                for handler in node.handlers:
                    handler.body = self._transform_func_body(handler.body, func_name=func_name)
                if node.orelse:
                    node.orelse = self._transform_func_body(node.orelse, func_name=func_name)
                if node.finalbody:
                    node.finalbody = self._transform_func_body(node.finalbody, func_name=func_name)
                continue

            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue

            traces = self._make_traces(node, func_name=func_name)
            new_body.extend(traces)

        return new_body

    def _make_traces(self, node: ast.AST, func_name: str | None = None) -> list:
        """Generate _trickle_tv() calls for assigned variable names."""
        names = _extract_names(node)
        return [self._make_call(name, getattr(node, "lineno", 0), func_name=func_name) for name in names]

    def _make_for_traces(self, node: ast.AST, func_name: str | None = None) -> list:
        """Generate trace calls for for-loop iteration variables."""
        if not isinstance(node, (ast.For, ast.AsyncFor)):
            return []
        names = _names_from_target(node.target)
        names = [n for n in names if not n.startswith("_")]
        return [self._make_call(name, getattr(node, "lineno", 0), func_name=func_name) for name in names]

    def _make_param_traces(self, node: ast.AST, func_name: str | None = None) -> list:
        """Generate trace calls for function parameters."""
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return []
        skip = {"self", "cls"}
        names = []
        for arg in node.args.args + node.args.posonlyargs + node.args.kwonlyargs:
            name = arg.arg
            if name in skip or name.startswith("_"):
                continue
            names.append(name)
        if node.args.vararg and not node.args.vararg.arg.startswith("_"):
            names.append(node.args.vararg.arg)
        if node.args.kwarg and not node.args.kwarg.arg.startswith("_"):
            names.append(node.args.kwarg.arg)
        return [self._make_call(name, getattr(node, "lineno", 0), func_name=func_name) for name in names]

    def _make_return_trace(self, node: ast.Return, func_name: str | None = None) -> list:
        """Rewrite `return expr` to trace the return value.

        Produces:
            _trickle_ret = expr
            _trickle_tv(_trickle_ret, '<return>', line, cell_id, cell_idx, func_name=...)
            return _trickle_ret
        """
        lineno = getattr(node, "lineno", 0)
        # _trickle_ret = expr
        assign = ast.Assign(
            targets=[ast.Name(id="_trickle_ret", ctx=ast.Store())],
            value=node.value,
            lineno=lineno,
        )
        # _trickle_tv(_trickle_ret, '<return>', ...)
        trace = self._make_call("<return>", lineno, func_name=func_name)
        # Override: the first arg should be _trickle_ret (not _name_to_ast('<return>'))
        trace.value.args[0] = ast.Name(id="_trickle_ret", ctx=ast.Load())
        # return _trickle_ret
        ret = ast.Return(value=ast.Name(id="_trickle_ret", ctx=ast.Load()))
        return [assign, trace, ret]

    def _make_call(self, name: str, lineno: int, func_name: str | None = None) -> ast.Expr:
        """Build an AST node for: _trickle_tv(var, 'name', line, cell_id, cell_idx, func_name)"""
        args = [
            # For attribute names like "self.fc", we need to evaluate the attribute access
            self._name_to_ast(name),
            ast.Constant(value=name),
            ast.Constant(value=lineno),
            ast.Constant(value=self._cell_id),
            ast.Constant(value=self._cell_idx),
        ]
        keywords = []
        if func_name:
            keywords.append(ast.keyword(arg="func_name", value=ast.Constant(value=func_name)))
        return ast.Expr(
            value=ast.Call(
                func=ast.Name(id="_trickle_tv", ctx=ast.Load()),
                args=args,
                keywords=keywords,
            )
        )

    @staticmethod
    def _name_to_ast(name: str) -> ast.expr:
        """Convert a dotted name like 'self.fc' to an AST expression."""
        parts = name.split(".")
        result: ast.expr = ast.Name(id=parts[0], ctx=ast.Load())
        for part in parts[1:]:
            result = ast.Attribute(value=result, attr=part, ctx=ast.Load())
        return result


def _extract_names(node: ast.AST) -> list:
    """Extract variable names from an assignment node."""
    names: list = []
    if isinstance(node, ast.Assign):
        for target in node.targets:
            names.extend(_names_from_target(target))
    elif isinstance(node, ast.AnnAssign):
        if node.value is not None and node.target:
            names.extend(_names_from_target(node.target))
    elif isinstance(node, ast.AugAssign):
        names.extend(_names_from_target(node.target))
    return [n for n in names if not n.startswith("_")]


def _names_from_target(target: ast.AST) -> list:
    """Recursively extract variable names from an assignment target."""
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, ast.Attribute):
        # Handle self.x, self.fc, etc. — build dotted name like "self.fc"
        parts = []
        node = target
        while isinstance(node, ast.Attribute):
            parts.append(node.attr)
            node = node.value
        if isinstance(node, ast.Name):
            parts.append(node.id)
        parts.reverse()
        return [".".join(parts)]
    if isinstance(target, (ast.Tuple, ast.List)):
        names = []
        for elt in target.elts:
            names.extend(_names_from_target(elt))
        return names
    if isinstance(target, ast.Starred):
        return _names_from_target(target.value)
    return []


# ---------------------------------------------------------------------------
# IPython integration
# ---------------------------------------------------------------------------

_transformer = _TrickleCellTransformer()


def _get_notebook_path() -> Optional[str]:
    """Try to detect the current notebook file path."""
    global _notebook_path
    if _notebook_path is not None:
        return _notebook_path

    try:
        # Jupyter stores the notebook path in the kernel connection info
        ip = get_ipython()  # type: ignore[name-defined]

        # Method 1: __session__ attribute (Jupyter Lab / Notebook 7+)
        if hasattr(ip, "__session__"):
            _notebook_path = ip.__session__
            return _notebook_path

        # Method 2: check JUPYTER_NOTEBOOK_PATH env var
        nb_path = os.environ.get("JUPYTER_NOTEBOOK_PATH")
        if nb_path:
            _notebook_path = os.path.abspath(nb_path)
            return _notebook_path

        # Method 3: use ipynbname if available
        try:
            import ipynbname
            _notebook_path = str(ipynbname.path())
            return _notebook_path
        except (ImportError, Exception):
            pass

    except Exception:
        pass

    return None


def _make_cell_id(cell_idx: int) -> str:
    """Create a cell identifier for the variables.jsonl file field.

    For VSCode notebook support, we use a format that the extension can parse
    to match cells: notebook_path#cell_idx or fallback to a synthetic path.
    """
    nb_path = _get_notebook_path()
    if nb_path:
        return f"{nb_path}#cell_{cell_idx}"
    # Fallback: use CWD-based synthetic path
    return os.path.join(os.getcwd(), f"__notebook__cell_{cell_idx}.py")


def _clear_cell_data(cell_id: str) -> None:
    """Flush the dedup cache before a cell execution.

    Clears the entire dedup cache so all variables are re-traced with fresh
    line numbers when a cell is re-run after editing. The JSONL file is NOT
    modified — the VSCode extension handles deduplication by preferring the
    most recent records.

    Also snapshots current tensor shapes so we can detect changes after re-run.
    """
    global _prev_shapes, _curr_shapes
    if _curr_shapes:
        _prev_shapes = dict(_curr_shapes)
    _curr_shapes = {}
    _tv_cache.clear()
    _tv_sample_count.clear()


def _format_shape(shape_str: str, dtype_str: str) -> str:
    """Format shape and dtype for display: [32, 784] float32."""
    return f"Tensor{shape_str} {dtype_str}" if dtype_str else f"Tensor{shape_str}"


def _print_shape_changes() -> None:
    """Compare previous and current tensor shapes, print a summary if anything changed."""
    if not _prev_shapes:
        return

    changes: list = []
    new_vars: list = []
    removed_vars: list = []

    for key, (shape, dtype, line) in _curr_shapes.items():
        var_name, func_name = key
        display_name = f"{func_name}.{var_name}" if func_name else var_name
        if key in _prev_shapes:
            prev_shape, prev_dtype, prev_line = _prev_shapes[key]
            if prev_shape != shape or prev_dtype != dtype:
                changes.append((display_name, line,
                                _format_shape(prev_shape, prev_dtype),
                                _format_shape(shape, dtype)))
        else:
            new_vars.append((display_name, line, _format_shape(shape, dtype)))

    for key in _prev_shapes:
        if key not in _curr_shapes:
            var_name, func_name = key
            display_name = f"{func_name}.{var_name}" if func_name else var_name
            prev_shape, prev_dtype, prev_line = _prev_shapes[key]
            removed_vars.append((display_name, prev_line, _format_shape(prev_shape, prev_dtype)))

    if not changes and not new_vars and not removed_vars:
        return

    lines: list = ["[trickle] Shape changes:"]
    for name, line, old, new in changes:
        lines.append(f"  {name} (L{line}): {old} → {new}")
    for name, line, shape in new_vars:
        lines.append(f"  + {name} (L{line}): {shape}")
    for name, line, shape in removed_vars:
        lines.append(f"  - {name} (L{line}): {shape}")

    print("\n".join(lines))


def _post_run_cell_hook(result: Any = None) -> None:
    """IPython post_run_cell callback — print shape changes and scalar tracking."""
    if result is not None and hasattr(result, 'error_in_exec') and result.error_in_exec is not None:
        _capture_error_snapshot(result.error_in_exec)
    _print_shape_changes()
    _write_scalar_agg_records()
    _print_scalar_agg_summary()
    _scalar_agg.clear()


def _build_sample(value: Any) -> Any:
    """Build a JSON-serializable sample from a value (shared by trace and error snapshot)."""
    if hasattr(value, "shape") and hasattr(value, "dtype"):
        shape = value.shape
        if hasattr(shape, '__len__') and len(shape) == 0:
            return value.item() if hasattr(value, "item") else float(value)
        parts = [f"shape={list(shape)}", f"dtype={value.dtype}"]
        if hasattr(value, "device"):
            parts.append(f"device={value.device}")
        return f'{type(value).__name__}({", ".join(parts)})'
    if isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        return value[:SAMPLE_LEN]
    if isinstance(value, (list, tuple)):
        try:
            items = []
            for item in value[:30]:
                if item is None or isinstance(item, (bool, int, float)):
                    items.append(item)
                elif isinstance(item, str):
                    items.append(item[:80])
                else:
                    items.append(str(item)[:80])
            if len(value) > 30:
                items.append(f"... ({len(value)} total)")
            return items
        except Exception:
            return str(value)[:SAMPLE_LEN]
    if isinstance(value, dict):
        try:
            d = {}
            for k, v in list(value.items())[:20]:
                if isinstance(k, str):
                    if v is None or isinstance(v, (bool, int, float)):
                        d[k] = v
                    elif isinstance(v, str):
                        d[k] = v[:80]
                    else:
                        d[k] = str(v)[:80]
            return d if d else str(value)[:SAMPLE_LEN]
        except Exception:
            return str(value)[:SAMPLE_LEN]
    return str(value)[:SAMPLE_LEN]


def _quick_type_and_sample(val: Any) -> tuple:
    """Fast type + sample for error snapshots. Avoids deep inference on large objects."""
    import types as _types
    # Skip modules, functions, classes — not useful for debugging
    if isinstance(val, (type, _types.ModuleType, _types.FunctionType, _types.BuiltinFunctionType)):
        return None, None

    t = type(val)
    # Primitives: instant
    if isinstance(val, bool):
        return {"kind": "primitive", "name": "boolean"}, val
    if isinstance(val, int):
        return {"kind": "primitive", "name": "integer"}, val
    if isinstance(val, float):
        return {"kind": "primitive", "name": "number"}, val
    if isinstance(val, str):
        return {"kind": "primitive", "name": "string"}, val[:SAMPLE_LEN]

    # Tensors/ndarrays: show shape without deep inference
    if hasattr(val, "shape") and hasattr(val, "dtype"):
        shape = val.shape
        parts = [f"shape={list(shape)}", f"dtype={val.dtype}"]
        if hasattr(val, "device"):
            parts.append(f"device={val.device}")
        cn = t.__name__
        props: dict = {
            "shape": {"kind": "primitive", "name": str(list(shape))},
            "dtype": {"kind": "primitive", "name": str(val.dtype)},
        }
        type_node = {"kind": "object", "properties": props, "class_name": cn}
        sample = f'{cn}({", ".join(parts)})'
        return type_node, sample

    # Lists/tuples: shallow — just show first few string representations
    if isinstance(val, (list, tuple)):
        items = []
        for item in val[:20]:
            if item is None or isinstance(item, (bool, int, float)):
                items.append(item)
            elif isinstance(item, str):
                items.append(item[:80])
            elif hasattr(item, "shape") and hasattr(item, "dtype"):
                p = [f"shape={list(item.shape)}", f"dtype={item.dtype}"]
                if hasattr(item, "device"):
                    p.append(f"device={item.device}")
                items.append(f"{type(item).__name__}({', '.join(p)})")
            else:
                items.append(str(item)[:80])
        if len(val) > 20:
            items.append(f"... ({len(val)} total)")
        elem_name = "unknown"
        if val and isinstance(val[0], str):
            elem_name = "string"
        elif val and isinstance(val[0], (int, float)):
            elem_name = "number"
        type_node = {"kind": "array", "element": {"kind": "primitive", "name": elem_name}}
        return type_node, items

    # Dicts: shallow
    if isinstance(val, dict):
        d = {}
        for k, v in list(val.items())[:10]:
            if isinstance(k, str):
                if v is None or isinstance(v, (bool, int, float)):
                    d[k] = v
                elif isinstance(v, str):
                    d[k] = v[:80]
                else:
                    d[k] = str(v)[:80]
        return {"kind": "primitive", "name": t.__name__}, d if d else str(val)[:SAMPLE_LEN]

    # Fallback: just stringify
    return {"kind": "primitive", "name": t.__name__}, str(val)[:SAMPLE_LEN]


def _capture_error_snapshot(exc: BaseException) -> None:
    """Capture frame locals at the error site — lightweight, no deep inference."""
    try:
        tb = exc.__traceback__
        if tb is None:
            return

        # Walk the traceback and collect ALL user-code frames.
        # In Python 3, list comprehensions / generator expressions have their
        # own scope, so the innermost frame may only contain loop vars like
        # `d` or `.0`.  We need variables from the enclosing cell frame too
        # (e.g. `file_path`, `data_dir`, …).
        user_frames: list = []
        user_lineno = 0
        while tb is not None:
            fn = tb.tb_frame.f_code.co_filename
            skip = (
                fn.startswith("<") or "site-packages" in fn
                or "/lib/python" in fn or "\\lib\\python" in fn
            )
            if not skip:
                user_frames.append(tb.tb_frame)
                user_lineno = tb.tb_lineno
            tb = tb.tb_next

        if not user_frames:
            return

        # Merge locals from all user frames — outer frames first so inner
        # frames override on name collision (inner values are more relevant).
        merged_locals: dict = {}
        for frame in user_frames:
            merged_locals.update(frame.f_locals)
        # Also pull in f_globals from the cell frame (first user frame) —
        # in notebooks, cell-level variables live in the global namespace.
        if user_frames:
            for k, v in user_frames[0].f_globals.items():
                if k not in merged_locals:
                    merged_locals[k] = v

        cell_id = _make_cell_id(_cell_counter)
        error_msg = f"{type(exc).__name__}: {exc}"

        # In notebooks, f_locals contains the ENTIRE IPython namespace.
        # Filter to only variables that were traced in the current cell.
        traced_names: set = set()
        for key in _tv_cache:
            # cache keys are "cell_id:line_no:var_name"
            parts = key.rsplit(":", 2)
            if len(parts) == 3:
                traced_names.add(parts[2])
        # Also include the for-loop / with-as iteration variables that
        # appear in the traceback line's code context
        try:
            ip = get_ipython()  # type: ignore[name-defined]
            cell_source = ip.user_ns.get("In", [])
            if cell_source and len(cell_source) > 0:
                last_cell = cell_source[-1] if isinstance(cell_source[-1], str) else ""
                # Extract simple variable names assigned in the cell
                import re
                for m in re.finditer(r'\b(\w+)\s*=', last_cell):
                    traced_names.add(m.group(1))
                # for-loop variables
                for m in re.finditer(r'\bfor\s+(\w+)\s+in\b', last_cell):
                    traced_names.add(m.group(1))
                # with-as variables
                for m in re.finditer(r'\bas\s+(\w+)\s*:', last_cell):
                    traced_names.add(m.group(1))
        except Exception:
            pass

        # IPython builtins to always skip
        _IPYTHON_BUILTINS = {
            'In', 'Out', 'get_ipython', 'exit', 'quit', 'open',
            'display', 'print', 'input', 'help', 'type', 'len',
        }

        records: list = []
        for name, val in list(merged_locals.items()):
            if name.startswith("_") or name.startswith(".") or name in _IPYTHON_BUILTINS:
                continue
            # Only include variables that were used in the cell
            if traced_names and name not in traced_names:
                continue
            try:
                type_node, sample = _quick_type_and_sample(val)
                if type_node is None:
                    continue
                records.append({
                    "kind": "error_snapshot",
                    "varName": name,
                    "line": user_lineno,
                    "module": f"cell_{_cell_counter}",
                    "file": cell_id,
                    "cellIndex": _cell_counter,
                    "type": type_node,
                    "typeHash": json.dumps(type_node, sort_keys=True)[:32],
                    "sample": sample,
                    "error": error_msg,
                    "errorLine": user_lineno,
                })
            except Exception:
                pass

        if records:
            vars_file = _get_vars_file()
            with open(vars_file, "a") as f:
                for r in records:
                    f.write(json.dumps(r) + "\n")
    except Exception:
        pass  # Never break user code


class _TrickleASTTransformer:
    """IPython-compatible AST transformer.

    IPython calls `visit(node)` on each registered AST transformer
    before compiling and executing a cell.
    """

    def visit(self, node: ast.Module) -> ast.Module:
        global _cell_counter
        _cell_counter += 1
        cell_id = _make_cell_id(_cell_counter)
        # Clear stale data for this cell before re-tracing
        _clear_cell_data(cell_id)
        return _transformer.transform(node, _cell_counter, cell_id)


def activate() -> None:
    """Activate trickle variable tracing in the current IPython/Jupyter session.

    Can be called directly or via ``%load_ext trickle``.
    """
    global _active

    if _active:
        return

    try:
        ip = get_ipython()  # type: ignore[name-defined]
    except NameError:
        print("[trickle] Not running in IPython/Jupyter — use `trickle run` for scripts.")
        return

    _active = True

    # Enable lovely-tensors for better tensor display (optional dependency)
    try:
        import lovely_tensors as _lt
        _lt.monkey_patch()
    except ImportError:
        pass

    # Inject the tracer function into the user namespace
    ip.user_ns["_trickle_tv"] = _trickle_tv

    # Register AST transformer
    ip.ast_transformers.append(_TrickleASTTransformer())

    # Register post-cell hook for shape change detection
    ip.events.register("post_run_cell", _post_run_cell_hook)

    # Also install the import hook so imported modules get traced too
    trace_imports = os.environ.get("TRICKLE_TRACE_IMPORTS", "1") not in ("0", "false")
    if trace_imports:
        try:
            from ._trace_import_hook import install_trace_hook
            install_trace_hook()
        except Exception:
            pass

    # Install backward hook for gradient norm tracking on nn.Module
    try:
        from ._backward_hook import install as _install_backward_hook
        _install_backward_hook()
    except Exception:
        pass

    vars_file = _get_vars_file()
    print(f"[trickle] Variable tracing active. Data → {os.path.relpath(vars_file)}")


def deactivate() -> None:
    """Remove trickle tracing from the current session."""
    global _active
    if not _active:
        return

    try:
        ip = get_ipython()  # type: ignore[name-defined]
        ip.ast_transformers = [t for t in ip.ast_transformers if not isinstance(t, _TrickleASTTransformer)]
        ip.user_ns.pop("_trickle_tv", None)
        ip.events.unregister("post_run_cell", _post_run_cell_hook)
    except (NameError, ValueError):
        pass

    _active = False


def clear() -> None:
    """Clear the cached variable observations and the variables.jsonl file."""
    global _tv_cache, _tv_file, _prev_shapes, _curr_shapes
    _tv_cache.clear()
    _tv_sample_count.clear()
    _prev_shapes.clear()
    _curr_shapes.clear()
    _scalar_agg.clear()
    if _tv_file and os.path.exists(_tv_file):
        with open(_tv_file, "w") as f:
            f.write("")
    print("[trickle] Variable data cleared.")


# ---------------------------------------------------------------------------
# IPython extension entry point: %load_ext trickle
# ---------------------------------------------------------------------------

def load_ipython_extension(ipython: Any) -> None:
    """Called by IPython when ``%load_ext trickle`` is executed."""
    activate()


def unload_ipython_extension(ipython: Any) -> None:
    """Called by IPython when ``%unload_ext trickle`` is executed."""
    deactivate()
