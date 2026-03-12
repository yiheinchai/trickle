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
from typing import Any, Optional, Set


# ---------------------------------------------------------------------------
# Shared tracer state (single instance per kernel)
# ---------------------------------------------------------------------------

_tv_cache: Set[str] = set()
_tv_file: Optional[str] = None
_cell_counter: int = 0
_notebook_path: Optional[str] = None
_active = False


def _get_vars_file() -> str:
    """Get (and lazily create) the path to variables.jsonl."""
    global _tv_file
    if _tv_file is not None:
        return _tv_file

    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    os.makedirs(local_dir, exist_ok=True)
    _tv_file = os.path.join(local_dir, "variables.jsonl")
    return _tv_file


def _trickle_tv(value: Any, var_name: str, line_no: int, cell_id: str, cell_idx: int) -> None:
    """Trace a variable assignment in a notebook cell.

    This is injected into each cell's namespace and called after every
    variable assignment. It infers the runtime type (including tensor
    shapes) and appends to .trickle/variables.jsonl.
    """
    try:
        from .type_inference import infer_type

        type_node = infer_type(value, max_depth=3)
        type_hash = json.dumps(type_node, sort_keys=True)[:32]
        cache_key = f"{cell_id}:{line_no}:{var_name}:{type_hash}"

        if cache_key in _tv_cache:
            return
        _tv_cache.add(cache_key)

        # Build sample
        sample: Any = None
        if hasattr(value, "shape") and hasattr(value, "dtype"):
            parts = [f"shape={list(value.shape)}", f"dtype={value.dtype}"]
            if hasattr(value, "device"):
                parts.append(f"device={value.device}")
            sample = f'{type(value).__name__}({", ".join(parts)})'
        elif isinstance(value, (int, float, bool)):
            sample = value
        elif isinstance(value, str):
            sample = value[:100]
        else:
            sample = str(value)[:100]

        record = {
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

        vars_file = _get_vars_file()
        with open(vars_file, "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass  # Never break user code


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
                param_traces = self._make_param_traces(node)
                node.body = param_traces + self._transform_func_body(node.body)
                continue

            if isinstance(node, ast.ClassDef):
                # Recurse into class bodies (methods)
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        param_traces = self._make_param_traces(item)
                        item.body = param_traces + self._transform_func_body(item.body)
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

    def _transform_func_body(self, body: list) -> list:
        """Insert trace calls inside function bodies."""
        new_body: list = []
        for node in body:
            new_body.append(node)

            if isinstance(node, (ast.For, ast.AsyncFor)):
                traces = self._make_for_traces(node)
                node.body = traces + self._transform_func_body(node.body)
                if node.orelse:
                    node.orelse = self._transform_func_body(node.orelse)
                continue

            if isinstance(node, (ast.If, ast.While)):
                node.body = self._transform_func_body(node.body)
                if node.orelse:
                    node.orelse = self._transform_func_body(node.orelse)
                continue

            if isinstance(node, (ast.With, ast.AsyncWith)):
                node.body = self._transform_func_body(node.body)
                continue

            if isinstance(node, ast.Try):
                node.body = self._transform_func_body(node.body)
                for handler in node.handlers:
                    handler.body = self._transform_func_body(handler.body)
                if node.orelse:
                    node.orelse = self._transform_func_body(node.orelse)
                if node.finalbody:
                    node.finalbody = self._transform_func_body(node.finalbody)
                continue

            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue

            traces = self._make_traces(node)
            new_body.extend(traces)

        return new_body

    def _make_traces(self, node: ast.AST) -> list:
        """Generate _trickle_tv() calls for assigned variable names."""
        names = _extract_names(node)
        return [self._make_call(name, getattr(node, "lineno", 0)) for name in names]

    def _make_for_traces(self, node: ast.AST) -> list:
        """Generate trace calls for for-loop iteration variables."""
        if not isinstance(node, (ast.For, ast.AsyncFor)):
            return []
        names = _names_from_target(node.target)
        names = [n for n in names if not n.startswith("_")]
        return [self._make_call(name, getattr(node, "lineno", 0)) for name in names]

    def _make_param_traces(self, node: ast.AST) -> list:
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
        return [self._make_call(name, getattr(node, "lineno", 0)) for name in names]

    def _make_call(self, name: str, lineno: int) -> ast.Expr:
        """Build an AST node for: _trickle_tv(var, 'name', line, cell_id, cell_idx)"""
        return ast.Expr(
            value=ast.Call(
                func=ast.Name(id="_trickle_tv", ctx=ast.Load()),
                args=[
                    ast.Name(id=name, ctx=ast.Load()),
                    ast.Constant(value=name),
                    ast.Constant(value=lineno),
                    ast.Constant(value=self._cell_id),
                    ast.Constant(value=self._cell_idx),
                ],
                keywords=[],
            )
        )


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
    """
    _tv_cache.clear()


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

    # Inject the tracer function into the user namespace
    ip.user_ns["_trickle_tv"] = _trickle_tv

    # Register AST transformer
    ip.ast_transformers.append(_TrickleASTTransformer())

    # Also install the import hook so imported modules get traced too
    trace_imports = os.environ.get("TRICKLE_TRACE_IMPORTS", "1") not in ("0", "false")
    if trace_imports:
        try:
            from ._trace_import_hook import install_trace_hook
            install_trace_hook()
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
    except NameError:
        pass

    _active = False


def clear() -> None:
    """Clear the cached variable observations and the variables.jsonl file."""
    global _tv_cache, _tv_file
    _tv_cache.clear()
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
