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
import sys
from typing import Any, Dict, List, Optional, Set, Tuple


_installed = False
_assignment_map: Dict[str, Dict[int, List[str]]] = {}  # filename -> {line_no -> [var_names]}
_cache: Set[str] = set()
_vars_file: Optional[str] = None
_entry_file: Optional[str] = None
_old_trace: Any = None
_infer_type: Any = None
_func_context: Dict[str, Dict[int, str]] = {}  # filename -> {line_no -> func_name}

# Per-frame pending state: after seeing an assignment line, we defer reading
# until the next event. Key = id(frame), value = (line_no, [var_names], func_name)
_pending: Dict[int, Tuple[int, List[str], Optional[str]]] = {}


def _parse_assignments(source: str, filename: str) -> Tuple[Dict[int, List[str]], Dict[int, str]]:
    """Parse source AST to find assignment line numbers and variable names.

    Returns:
        (assignments, func_context) where:
        - assignments: {line_no: [var_names]}
        - func_context: {line_no: qualified_func_name}
    """
    try:
        tree = ast.parse(source, filename)
    except SyntaxError:
        return {}, {}

    assignments: Dict[int, List[str]] = {}
    func_ctx: Dict[int, str] = {}

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

    def _visit_body(body: list, func_name: Optional[str] = None) -> None:
        for node in body:
            if isinstance(node, ast.ClassDef):
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        qname = f"{node.name}.{item.name}"
                        _visit_body(item.body, func_name=qname)
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
                        _visit_body([item], func_name=None)
                continue

            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qname = func_name or node.name
                _visit_body(node.body, func_name=qname)
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
                _visit_body(node.body, func_name)
                if node.orelse:
                    _visit_body(node.orelse, func_name)
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

            # Recurse into compound statements
            if isinstance(node, (ast.If, ast.While)):
                _visit_body(node.body, func_name)
                if node.orelse:
                    _visit_body(node.orelse, func_name)
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                for item in node.items:
                    if item.optional_vars:
                        as_names = _extract_names(item.optional_vars)
                        as_names = [n for n in as_names if not n.startswith("_")]
                        if as_names:
                            assignments.setdefault(line, []).extend(as_names)
                            if func_name:
                                func_ctx[line] = func_name
                _visit_body(node.body, func_name)
            elif isinstance(node, ast.Try):
                _visit_body(node.body, func_name)
                for handler in node.handlers:
                    if handler.name and not handler.name.startswith("_"):
                        hline = getattr(handler, "lineno", 0)
                        if hline:
                            assignments.setdefault(hline, []).append(handler.name)
                            if func_name:
                                func_ctx[hline] = func_name
                    _visit_body(handler.body, func_name)
                if node.orelse:
                    _visit_body(node.orelse, func_name)
                if node.finalbody:
                    _visit_body(node.finalbody, func_name)

    _visit_body(tree.body)
    return assignments, func_ctx


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


def _trace_var(value: Any, var_name: str, line_no: int, file_path: str,
               module_name: str, func_name: Optional[str] = None) -> None:
    """Trace a single variable assignment."""
    global _vars_file

    try:
        if _vars_file is None:
            local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
            os.makedirs(local_dir, exist_ok=True)
            _vars_file = os.path.join(local_dir, "variables.jsonl")

        type_node = _infer_type(value, max_depth=3)
        type_hash = json.dumps(type_node, sort_keys=True)[:32]
        cache_key = f"{file_path}:{line_no}:{var_name}:{type_hash}"

        if cache_key in _cache:
            return
        _cache.add(cache_key)

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

        with open(_vars_file, "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception:
        pass


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

    for name in var_names:
        try:
            if "." in name:
                # Attribute access like self.fc1
                parts = name.split(".", 1)
                obj = locals_dict.get(parts[0])
                if obj is not None:
                    val = getattr(obj, parts[1], None)
                    if val is not None:
                        _trace_var(val, name, line_no, filename, module_name, func_name)
            else:
                val = locals_dict.get(name)
                if val is not None:
                    _trace_var(val, name, line_no, filename, module_name, func_name)
        except Exception:
            pass


def _local_trace(frame: Any, event: str, arg: Any) -> Any:
    """Per-frame trace function — fires on line/return events for entry file frames."""
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
        # Flush pending before the frame goes away
        _flush_pending(frame)
        return None

    if event == "exception":
        # Clean up pending on exception
        _pending.pop(id(frame), None)
        return _local_trace

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
    global _installed, _entry_file, _old_trace, _infer_type

    if _installed:
        return
    _installed = True

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

    assignments, func_ctx = _parse_assignments(source, _entry_file)
    if not assignments:
        return

    _assignment_map[_entry_file] = assignments
    _func_context[_entry_file] = func_ctx

    # Import type inference lazily
    from trickle.type_inference import infer_type
    _infer_type = infer_type

    # Install the trace function
    # Note: sys.settrace and sys.setprofile are independent — both can coexist
    _old_trace = sys.gettrace()
    sys.settrace(_global_trace)

    # Also set f_trace on the caller's frame chain so that module-level code
    # (which is already executing when we're imported) gets line tracing too.
    frame = sys._getframe(0)
    while frame is not None:
        if frame.f_code.co_filename == _entry_file:
            frame.f_trace = _local_trace
            break
        frame = frame.f_back

    debug = os.environ.get("TRICKLE_DEBUG", "").lower() in ("1", "true", "yes")
    if debug:
        print(f"[trickle.auto] Variable tracer installed: {len(assignments)} assignment lines in {os.path.basename(_entry_file)}")
