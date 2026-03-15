"""Import hook that applies AST variable tracing to imported user modules.

When installed, this hook intercepts imports of user modules (skipping
stdlib, site-packages, and well-known third-party libraries) and rewrites
their source to insert ``__trickle_tv()`` calls after every variable
assignment — capturing runtime types and tensor shapes.

This complements ``_entry_transform.py`` which handles the entry script;
this hook handles all modules the entry script imports.

Usage::

    from trickle._trace_import_hook import install_trace_hook
    install_trace_hook()
    # Now any user module imported after this point will be traced.
"""

from __future__ import annotations

import ast
import importlib
import importlib.abc
import importlib.machinery
import importlib.util
import json
import logging
import os
import sys
import types
from typing import Any, Optional, Set

logger = logging.getLogger("trickle.trace")

_installed = False
_traced_modules: set[str] = set()


# ---------------------------------------------------------------------------
# Skip-list: modules we should never transform
# ---------------------------------------------------------------------------

_SKIP_TOP_LEVEL = frozenset({
    "trickle", "_trickle",
    # Web frameworks
    "flask", "fastapi", "django", "starlette", "uvicorn", "gunicorn",
    "werkzeug", "jinja2", "markupsafe", "click", "itsdangerous",
    # HTTP / networking
    "requests", "urllib3", "httpx", "aiohttp", "certifi", "charset_normalizer",
    "idna", "urllib", "http", "socket", "ssl", "email",
    # Testing
    "pytest", "unittest", "_pytest", "pluggy",
    # Build / packaging
    "setuptools", "pip", "pkg_resources", "wheel", "distutils",
    # Data science / ML (instrument user code, not library internals)
    "numpy", "pandas", "scipy", "sklearn", "matplotlib",
    "torch", "torchvision", "torchaudio", "transformers",
    "tensorflow", "tf", "keras", "jax", "flax",
    # Serialization / utils
    "dill", "cloudpickle", "multiprocess", "six", "tqdm", "packaging",
    "PIL", "cv2", "skimage",
    # Typing
    "typing", "typing_extensions",
    # Common stdlib (catch-all for Python < 3.10 without stdlib_module_names)
    "importlib", "collections", "functools", "itertools", "operator",
    "os", "sys", "io", "re", "json", "logging", "pathlib",
    "asyncio", "concurrent", "threading", "multiprocessing",
    "dataclasses", "enum", "abc", "copy", "pprint", "textwrap",
    "builtins", "copyreg", "encodings", "codecs", "locale",
    "runpy", "pkgutil", "zipimport", "zipfile", "zoneinfo",
    "datetime", "time", "calendar", "math", "random", "hashlib",
    "hmac", "secrets", "struct", "ctypes", "inspect", "traceback",
    "warnings", "contextlib", "string", "fnmatch", "glob", "shutil",
    "tempfile", "csv", "configparser", "argparse", "gettext",
    "subprocess", "signal", "select", "selectors", "mmap",
    "base64", "binascii", "quopri", "uu",
    "xml", "html", "plistlib",
    "_",
})

_include_patterns: list[str] = []
_exclude_patterns: list[str] = []


def _should_trace(fullname: str, filepath: Optional[str] = None) -> bool:
    """Decide if a module should have variable tracing applied."""
    if fullname in _traced_modules:
        return False

    top_level = fullname.split(".")[0]

    # Skip stdlib (Python 3.10+)
    if hasattr(sys, "stdlib_module_names") and top_level in sys.stdlib_module_names:
        return False

    if top_level in _SKIP_TOP_LEVEL:
        return False

    # Skip site-packages / dist-packages
    if filepath:
        if "site-packages" in filepath or "dist-packages" in filepath:
            return False

    # Apply include filter
    if _include_patterns:
        if not any(p in fullname for p in _include_patterns):
            return False

    # Apply exclude filter
    if _exclude_patterns:
        if any(p in fullname for p in _exclude_patterns):
            return False

    return True


# ---------------------------------------------------------------------------
# AST transformation (reuses logic from _entry_transform)
# ---------------------------------------------------------------------------

def _transform_module_source(source: str, filename: str, module_name: str) -> str:
    """Apply variable tracing AST transformation to a module's source.

    Returns the transformed source string with __trickle_tv() calls
    inserted after variable assignments.
    """
    tree = ast.parse(source, filename)

    # Transform top-level body (recurses into class bodies)
    tree.body = _transform_body(tree.body)

    # Transform function bodies with qualified names (Class.method)
    _transform_functions_with_context(tree, class_name=None)

    ast.fix_missing_locations(tree)

    transformed = ast.unparse(tree)

    # Prepend the tracer setup
    setup = _generate_module_tracer(filename, module_name)
    return setup + "\n" + transformed


def _generate_module_tracer(filename: str, module_name: str) -> str:
    """Generate the _trickle_tv function for an imported module.

    Uses single-underscore prefix (_trickle_tv, not __trickle_tv) to
    avoid Python's name mangling inside class bodies.
    """
    return f"""
# --- trickle variable tracer + function wrapper ---
import os as _trickle_os
import json as _trickle_json
import functools as _trickle_functools
import inspect as _trickle_inspect
def _trickle_wrap(__fn, __name):
    try:
        from trickle.decorator import _wrap
        return _wrap(__fn, name=__name, module={module_name!r})
    except Exception:
        return __fn
_trickle_tv_cache = {{}}
_trickle_tv_count = {{}}
_trickle_tv_file = None
_TRICKLE_MAX_SAMPLES = 5
import time as _trickle_time
def _trickle_tv(_val, _name, _line, _func=None):
    global _trickle_tv_file
    try:
        # Skip dataclass Field descriptors (not useful runtime values)
        if type(_val).__name__ == 'Field' and hasattr(_val, 'default_factory'):
            return
        _ck = {filename!r} + ':' + str(_line) + ':' + _name
        # Per-line sample count limit: stop after N samples to avoid loop spam
        _cnt = _trickle_tv_count.get(_ck, 0)
        if _cnt >= _TRICKLE_MAX_SAMPLES:
            return
        # Value-aware dedup: re-send if value changed or 10s elapsed
        _t_type = type(_val)
        if _t_type in (int, float, bool, str) or _val is None:
            _vfp = str(_val)[:60]
        elif hasattr(_val, 'item') and hasattr(_val, 'numel') and _val.numel() <= 1:
            _vfp = str(_val.item())
        else:
            _vfp = type(_val).__name__
        _now = _trickle_time.time()
        _prev = _trickle_tv_cache.get(_ck)
        if _prev is not None:
            _pfp, _pts = _prev
            if _pfp == _vfp and (_now - _pts) < 10.0:
                return
        _trickle_tv_cache[_ck] = (_vfp, _now)
        _trickle_tv_count[_ck] = _cnt + 1
        if _trickle_tv_file is None:
            _d = _trickle_os.environ.get('TRICKLE_LOCAL_DIR') or _trickle_os.path.join(_trickle_os.getcwd(), '.trickle')
            _trickle_os.makedirs(_d, exist_ok=True)
            _trickle_tv_file = _trickle_os.path.join(_d, 'variables.jsonl')
        from trickle.type_inference import infer_type
        _t = infer_type(_val, max_depth=3)
        _th = _trickle_json.dumps(_t, sort_keys=True)[:32]
        _s = None
        if _val is None:
            pass
        elif hasattr(_val, 'shape') and hasattr(_val, 'dtype'):
            _sh = _val.shape
            if hasattr(_sh, '__len__') and len(_sh) == 0:
                _s = _val.item() if hasattr(_val, 'item') else float(_val)
            else:
                _parts = [f'shape={{list(_sh)}}', f'dtype={{_val.dtype}}']
                if hasattr(_val, 'device'): _parts.append(f'device={{_val.device}}')
                _s = f'{{type(_val).__name__}}({{", ".join(_parts)}})'
        elif isinstance(_val, bool):
            _s = _val
        elif isinstance(_val, (int, float)):
            _s = _val
        elif isinstance(_val, str):
            _s = _val[:100]
        elif hasattr(_val, '_fields') and isinstance(_val, tuple):
            def _sv(v):
                if v is None or isinstance(v, bool) or isinstance(v, (int, float)): return v
                if isinstance(v, str): return v[:40]
                _cn = type(v).__name__
                if _cn not in ('list','dict','tuple','set'): return _cn + '(...)'
                if isinstance(v, (list, tuple)): return '[' + _cn + ': ' + str(len(v)) + ' items]'
                if isinstance(v, dict): return '{{' + _cn + ': ' + str(len(v)) + ' keys}}'
                if isinstance(v, set): return '{{' + _cn + ': ' + str(len(v)) + ' items}}'
                return str(v)[:40]
            _s = {{f: _sv(getattr(_val, f, None)) for f in list(_val._fields)[:8]}}
        else:
            import dataclasses as _dc
            def _sv2(v):
                if v is None or isinstance(v, bool) or isinstance(v, (int, float)): return v
                if isinstance(v, str): return v[:40]
                _cn = type(v).__name__
                if _cn not in ('list','dict','tuple','set'): return _cn + '(...)'
                if isinstance(v, (list, tuple)): return '[' + _cn + ': ' + str(len(v)) + ' items]'
                if isinstance(v, dict): return '{{' + _cn + ': ' + str(len(v)) + ' keys}}'
                if isinstance(v, set): return '{{' + _cn + ': ' + str(len(v)) + ' items}}'
                return str(v)[:40]
            if _dc.is_dataclass(_val) and not isinstance(_val, type):
                _s = {{f.name: _sv2(getattr(_val, f.name, None)) for f in list(_dc.fields(_val))[:8]}}
            elif hasattr(type(_val), 'model_fields') and hasattr(_val, 'model_dump'):
                try:
                    _fields = list(type(_val).model_fields.keys())[:8]
                    _s = {{f: _sv2(getattr(_val, f, None)) for f in _fields}}
                except Exception:
                    _s = str(_val)[:100]
            elif hasattr(type(_val), '__fields__') and hasattr(_val, 'dict'):
                try:
                    _fields = list(type(_val).__fields__.keys())[:8]
                    _s = {{f: _sv2(getattr(_val, f, None)) for f in _fields}}
                except Exception:
                    _s = str(_val)[:100]
            else:
                _s = str(_val)[:100]
        _r = {{'kind': 'variable', 'varName': _name, 'line': _line, 'module': {module_name!r}, 'file': {filename!r}, 'type': _t, 'typeHash': _th, 'sample': _s}}
        if _func: _r['funcName'] = _func
        with open(_trickle_tv_file, 'a') as _f:
            _f.write(_trickle_json.dumps(_r) + '\\n')
    except Exception:
        pass
def _trickle_dl(_val, _names, _var, _line, _func=None):
    try:
        if not hasattr(_val, 'shape'): return
        _d = _trickle_os.environ.get('TRICKLE_LOCAL_DIR') or _trickle_os.path.join(_trickle_os.getcwd(), '.trickle')
        _trickle_os.makedirs(_d, exist_ok=True)
        _p = _trickle_os.path.join(_d, 'variables.jsonl')
        _r = {{'kind': 'dim_labels', 'varName': _var, 'labels': _names, 'line': _line, 'file': {filename!r}}}
        if _func: _r['funcName'] = _func
        with open(_p, 'a') as _f:
            _f.write(_trickle_json.dumps(_r) + '\\n')
    except Exception:
        pass
# --- end trickle variable tracer ---
"""


def _transform_body(body: list, class_name: str = "") -> list:
    """Insert trace calls after assignments and wrap functions in a module/class body.

    Also recurses into compound statements (for, if, while, with, try) so that
    variable assignments and for-loop iteration variables are traced.
    """
    new_body: list = []
    for node in body:
        new_body.append(node)

        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # Skip private/dunder methods
            if node.name.startswith("_"):
                continue
            # Skip @classmethod, @staticmethod, @property
            _skip_decorators = {"classmethod", "staticmethod", "property"}
            if any(
                (isinstance(d, ast.Name) and d.id in _skip_decorators)
                or (isinstance(d, ast.Attribute) and d.attr in _skip_decorators)
                for d in node.decorator_list
            ):
                continue
            # Wrap function: func = _trickle_wrap(func, 'ClassName.func' or 'func')
            obs_name = f"{class_name}.{node.name}" if class_name else node.name
            wrap_stmt = ast.Assign(
                targets=[ast.Name(id=node.name, ctx=ast.Store())],
                value=ast.Call(
                    func=ast.Name(id="_trickle_wrap", ctx=ast.Load()),
                    args=[
                        ast.Name(id=node.name, ctx=ast.Load()),
                        ast.Constant(value=obs_name),
                    ],
                    keywords=[],
                ),
            )
            new_body.append(wrap_stmt)
            continue

        if isinstance(node, ast.ClassDef):
            # Recurse into class body to wrap its methods
            node.body = _transform_body(node.body, class_name=node.name)
            continue
        if isinstance(node, (ast.For, ast.AsyncFor)):
            loop_var_traces = _make_for_target_traces(node)
            node.body = loop_var_traces + _transform_toplevel_block(node.body)
            if node.orelse:
                node.orelse = _transform_toplevel_block(node.orelse)
            continue
        if isinstance(node, (ast.If, ast.While)):
            node.body = _transform_toplevel_block(node.body)
            if node.orelse:
                node.orelse = _transform_toplevel_block(node.orelse)
            continue
        if isinstance(node, (ast.With, ast.AsyncWith)):
            with_traces = _make_with_target_traces(node)
            node.body = with_traces + _transform_toplevel_block(node.body)
            continue
        if isinstance(node, ast.Try):
            node.body = _transform_toplevel_block(node.body)
            for handler in node.handlers:
                except_traces = _make_except_target_trace(handler)
                handler.body = except_traces + _transform_toplevel_block(handler.body)
            if node.orelse:
                node.orelse = _transform_toplevel_block(node.orelse)
            if node.finalbody:
                node.finalbody = _transform_toplevel_block(node.finalbody)
            continue
        trace_stmts = _make_trace_stmts(node)
        new_body.extend(trace_stmts)
    return new_body


def _transform_toplevel_block(body: list) -> list:
    """Transform a block inside a module-level compound statement."""
    new_body: list = []
    for node in body:
        new_body.append(node)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if isinstance(node, (ast.For, ast.AsyncFor)):
            loop_var_traces = _make_for_target_traces(node)
            node.body = loop_var_traces + _transform_toplevel_block(node.body)
            if node.orelse:
                node.orelse = _transform_toplevel_block(node.orelse)
            continue
        if isinstance(node, (ast.If, ast.While)):
            node.body = _transform_toplevel_block(node.body)
            if node.orelse:
                node.orelse = _transform_toplevel_block(node.orelse)
            continue
        if isinstance(node, (ast.With, ast.AsyncWith)):
            with_traces = _make_with_target_traces(node)
            node.body = with_traces + _transform_toplevel_block(node.body)
            continue
        if isinstance(node, ast.Try):
            node.body = _transform_toplevel_block(node.body)
            for handler in node.handlers:
                except_traces = _make_except_target_trace(handler)
                handler.body = except_traces + _transform_toplevel_block(handler.body)
            if node.orelse:
                node.orelse = _transform_toplevel_block(node.orelse)
            if node.finalbody:
                node.finalbody = _transform_toplevel_block(node.finalbody)
            continue
        trace_stmts = _make_trace_stmts(node)
        new_body.extend(trace_stmts)
    return new_body


def _transform_functions_with_context(node: ast.AST, class_name: str | None) -> None:
    """Walk the AST and transform function bodies with qualified function names.

    For methods inside classes, produces names like 'GPT.forward'.
    For top-level functions, just 'train'.
    """
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.ClassDef):
            _transform_functions_with_context(child, class_name=child.name)
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            func_name = f"{class_name}.{child.name}" if class_name else child.name
            param_traces = _make_param_traces(child, func_name=func_name)
            child.body = param_traces + _transform_func_body(child.body, func_name=func_name)
        else:
            _transform_functions_with_context(child, class_name=class_name)


def _make_tv_call(value_expr: ast.expr, var_name: str, lineno: int, func_name: str | None = None) -> ast.Expr:
    """Build a single _trickle_tv(...) call AST node."""
    args = [value_expr, ast.Constant(value=var_name), ast.Constant(value=lineno)]
    if func_name:
        args.append(ast.Constant(value=func_name))
    return ast.Expr(value=ast.Call(
        func=ast.Name(id="_trickle_tv", ctx=ast.Load()),
        args=args,
        keywords=[],
    ))


def _transform_func_body(body: list, func_name: str | None = None) -> list:
    """Insert trace calls after variable assignments inside function bodies.

    Also transforms ``return`` statements to trace return values before returning.
    ``func_name`` is the qualified function name (e.g. 'GPT.forward') added to records.
    """
    new_body: list = []
    for node in body:
        # Recurse into compound statements
        if isinstance(node, (ast.If, ast.While)):
            node.body = _transform_func_body(node.body, func_name)
            if hasattr(node, "orelse") and node.orelse:
                node.orelse = _transform_func_body(node.orelse, func_name)
            new_body.append(node)
            continue
        if isinstance(node, (ast.For, ast.AsyncFor)):
            loop_var_traces = _make_for_target_traces(node, func_name)
            node.body = loop_var_traces + _transform_func_body(node.body, func_name)
            if hasattr(node, "orelse") and node.orelse:
                node.orelse = _transform_func_body(node.orelse, func_name)
            new_body.append(node)
            continue
        if isinstance(node, (ast.With, ast.AsyncWith)):
            with_traces = _make_with_target_traces(node, func_name)
            node.body = with_traces + _transform_func_body(node.body, func_name)
            new_body.append(node)
            continue
        if isinstance(node, ast.Try):
            node.body = _transform_func_body(node.body, func_name)
            for handler in node.handlers:
                except_traces = _make_except_target_trace(handler, func_name)
                handler.body = except_traces + _transform_func_body(handler.body, func_name)
            if node.orelse:
                node.orelse = _transform_func_body(node.orelse, func_name)
            if node.finalbody:
                node.finalbody = _transform_func_body(node.finalbody, func_name)
            new_body.append(node)
            continue
        # Don't recurse into nested functions
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            new_body.append(node)
            continue

        # Trace return values
        if isinstance(node, ast.Return) and node.value is not None:
            ret_stmts = _make_return_trace(node, func_name)
            new_body.extend(ret_stmts)
            continue

        new_body.append(node)
        trace_stmts = _make_trace_stmts(node, func_name)
        new_body.extend(trace_stmts)

    return new_body


def _make_return_trace(node: ast.Return, func_name: str | None = None) -> list:
    """Transform a return statement to trace the return value before returning."""
    lineno = getattr(node, "lineno", 0)
    stmts: list = []

    assign = ast.Assign(
        targets=[ast.Name(id="_trickle_ret", ctx=ast.Store())],
        value=node.value,
    )
    stmts.append(assign)

    if isinstance(node.value, ast.Tuple):
        for elt in node.value.elts:
            if isinstance(elt, ast.Name) and not elt.id.startswith("_"):
                stmts.append(_make_tv_call(
                    ast.Name(id=elt.id, ctx=ast.Load()),
                    f"<return:{elt.id}>", lineno, func_name,
                ))

    stmts.append(_make_tv_call(
        ast.Name(id="_trickle_ret", ctx=ast.Load()),
        "<return>", lineno, func_name,
    ))

    new_return = ast.Return(value=ast.Name(id="_trickle_ret", ctx=ast.Load()))
    stmts.append(new_return)
    return stmts


def _make_trace_stmts(node: ast.AST, func_name: str | None = None) -> list:
    """Generate _trickle_tv() calls for variable names assigned in this node."""
    lineno = getattr(node, "lineno", 0)
    stmts = []

    names = _extract_assigned_names(node)
    for name in names:
        stmts.append(_make_tv_call(
            ast.Name(id=name, ctx=ast.Load()), name, lineno, func_name,
        ))

    attrs = _extract_attr_assignments(node)
    for display_name, value_node in attrs:
        stmts.append(_make_tv_call(value_node, display_name, lineno, func_name))

    # Detect dimension label patterns: B, T, C = x.size() or B, T, C = x.shape
    dl_stmt = _make_dim_label_stmt(node, func_name)
    if dl_stmt:
        stmts.append(dl_stmt)

    return stmts


def _make_dim_label_stmt(node: ast.AST, func_name: str | None = None) -> ast.Expr | None:
    """Detect `A, B, C = x.size()` or `A, B, C = x.shape` and emit a dim_labels record."""
    if not isinstance(node, ast.Assign):
        return None
    if len(node.targets) != 1:
        return None

    target = node.targets[0]
    value = node.value

    if not isinstance(target, ast.Tuple):
        return None
    dim_names = []
    for elt in target.elts:
        if isinstance(elt, ast.Name):
            dim_names.append(elt.id)
        else:
            return None

    tensor_expr = None
    if isinstance(value, ast.Call):
        if isinstance(value.func, ast.Attribute) and value.func.attr == "size" and len(value.args) == 0:
            tensor_expr = value.func.value
    elif isinstance(value, ast.Attribute) and value.attr == "shape":
        tensor_expr = value.value

    if tensor_expr is None:
        return None

    tensor_var_name = _expr_to_name(tensor_expr)
    if not tensor_var_name:
        return None

    lineno = getattr(node, "lineno", 0)
    args: list[ast.expr] = [
        tensor_expr,
        ast.List(elts=[ast.Constant(value=n) for n in dim_names], ctx=ast.Load()),
        ast.Constant(value=tensor_var_name),
        ast.Constant(value=lineno),
    ]
    if func_name:
        args.append(ast.Constant(value=func_name))

    return ast.Expr(value=ast.Call(
        func=ast.Name(id="_trickle_dl", ctx=ast.Load()),
        args=args,
        keywords=[],
    ))


def _expr_to_name(expr: ast.expr) -> str | None:
    """Convert an AST expression to a display name string."""
    if isinstance(expr, ast.Name):
        return expr.id
    if isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name):
        return f"{expr.value.id}.{expr.attr}"
    return None


def _make_param_traces(node: ast.AST, func_name: str | None = None) -> list:
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
    stmts = []
    lineno = getattr(node, "lineno", 0)
    for name in names:
        stmts.append(_make_tv_call(
            ast.Name(id=name, ctx=ast.Load()), name, lineno, func_name,
        ))
    return stmts


def _make_for_target_traces(node: ast.AST, func_name: str | None = None) -> list:
    """Generate trace calls for for-loop iteration variables."""
    if not isinstance(node, (ast.For, ast.AsyncFor)):
        return []
    names = _names_from_target(node.target)
    names = [n for n in names if not n.startswith("_")]
    lineno = getattr(node, "lineno", 0)
    stmts = []
    for name in names:
        stmts.append(_make_tv_call(
            ast.Name(id=name, ctx=ast.Load()), name, lineno, func_name,
        ))
    return stmts


def _make_with_target_traces(node: ast.AST, func_name: str | None = None) -> list:
    """Generate trace calls for with-statement ``as`` variables."""
    if not isinstance(node, (ast.With, ast.AsyncWith)):
        return []
    stmts = []
    lineno = getattr(node, "lineno", 0)
    for item in node.items:
        if item.optional_vars is None:
            continue
        names = _names_from_target(item.optional_vars)
        for name in names:
            if name.startswith("_"):
                continue
            stmts.append(_make_tv_call(
                ast.Name(id=name, ctx=ast.Load()), name, lineno, func_name,
            ))
    return stmts


def _make_except_target_trace(handler: ast.ExceptHandler, func_name: str | None = None) -> list:
    """Generate a trace call for an exception handler ``as`` variable."""
    if not handler.name or handler.name.startswith("_"):
        return []
    lineno = getattr(handler, "lineno", 0)
    return [_make_tv_call(
        ast.Name(id=handler.name, ctx=ast.Load()), handler.name, lineno, func_name,
    )]


def _extract_assigned_names(node: ast.AST) -> list:
    """Extract simple variable names from an assignment node."""
    names: list = []
    if isinstance(node, ast.Assign):
        for target in node.targets:
            names.extend(_names_from_target(target))
    elif isinstance(node, ast.AnnAssign):
        if node.value is not None and node.target:
            names.extend(_names_from_target(node.target))
    elif isinstance(node, ast.AugAssign):
        names.extend(_names_from_target(node.target))
    # Filter out private/dunder names and trickle internals
    return [n for n in names if not n.startswith("_")]


def _extract_attr_assignments(node: ast.AST) -> list:
    """Extract attribute assignments from an assignment node.

    For ``self.weight = expr``, returns [('self.weight', <AST for self.weight>)].
    Only handles single-level attributes (self.x, not self.a.b).
    Skips private/dunder attributes.
    """
    results: list = []

    targets = []
    if isinstance(node, ast.Assign):
        targets = node.targets
    elif isinstance(node, ast.AnnAssign) and node.value is not None and node.target:
        targets = [node.target]
    elif isinstance(node, ast.AugAssign):
        targets = [node.target]

    for target in targets:
        if isinstance(target, ast.Attribute):
            attr_name = target.attr
            if attr_name.startswith("_"):
                continue
            if isinstance(target.value, ast.Name):
                obj_name = target.value.id
                display_name = f"{obj_name}.{attr_name}"
                read_node = ast.Attribute(
                    value=ast.Name(id=obj_name, ctx=ast.Load()),
                    attr=attr_name,
                    ctx=ast.Load(),
                )
                results.append((display_name, read_node))

    return results


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
# Import hook using sys.meta_path
# ---------------------------------------------------------------------------

class _TrickleTraceFinder(importlib.abc.MetaPathFinder):
    """Meta path finder that intercepts user module imports for variable tracing."""

    def find_module(self, fullname: str, path: Any = None) -> Any:
        """Legacy find_module interface (Python 3.3 compat, still called)."""
        if not _should_trace(fullname):
            return None

        # Find the module's spec using the default finders
        spec = self._find_spec_default(fullname, path)
        if spec is None or spec.origin is None:
            return None

        # Only trace .py files
        if not spec.origin.endswith(".py"):
            return None

        # Final filepath check
        if not _should_trace(fullname, spec.origin):
            return None

        return _TrickleTraceLoader(spec)

    def _find_spec_default(self, fullname: str, path: Any) -> Any:
        """Find spec using the default finders (skip ourselves to avoid recursion)."""
        for finder in sys.meta_path:
            if finder is self:
                continue
            if hasattr(finder, "find_spec"):
                try:
                    spec = finder.find_spec(fullname, path)
                    if spec is not None:
                        return spec
                except Exception:
                    continue
        return None


class _TrickleTraceLoader:
    """Loader that transforms module source with variable tracing before compiling."""

    def __init__(self, spec: Any):
        self.spec = spec

    def load_module(self, fullname: str) -> types.ModuleType:
        """Load and transform the module source with variable tracing."""
        if fullname in sys.modules:
            return sys.modules[fullname]

        _traced_modules.add(fullname)

        filepath = os.path.realpath(self.spec.origin)
        module_name = fullname.rsplit(".", 1)[-1]

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                source = f.read()

            transformed = _transform_module_source(source, filepath, module_name)
            code = compile(transformed, filepath, "exec")
        except Exception:
            logger.debug("trickle: failed to transform %s, using default import", fullname, exc_info=True)
            # Fall back to default import
            return self._default_import(fullname)

        # Create the module
        module = types.ModuleType(fullname)
        module.__file__ = filepath
        module.__loader__ = self
        module.__spec__ = self.spec

        # Set package info
        if self.spec.submodule_search_locations is not None:
            module.__path__ = list(self.spec.submodule_search_locations)
            module.__package__ = fullname
        else:
            module.__package__ = fullname.rpartition(".")[0]

        # Register BEFORE executing (handles circular imports)
        sys.modules[fullname] = module

        try:
            exec(code, module.__dict__)
        except Exception:
            # If execution fails, remove from sys.modules and fall back
            sys.modules.pop(fullname, None)
            logger.debug("trickle: exec failed for %s, falling back", fullname, exc_info=True)
            return self._default_import(fullname)

        logger.debug("trickle: traced variables in %s (%s)", fullname, filepath)
        return module

    def _default_import(self, fullname: str) -> types.ModuleType:
        """Fall back to the default import mechanism."""
        _traced_modules.add(fullname)
        # Temporarily remove our finder to avoid recursion
        finder = None
        for f in sys.meta_path:
            if isinstance(f, _TrickleTraceFinder):
                finder = f
                break
        if finder:
            sys.meta_path.remove(finder)
        try:
            module = importlib.import_module(fullname)
        finally:
            if finder and finder not in sys.meta_path:
                sys.meta_path.insert(0, finder)
        # Auto-patch database drivers when they're imported
        _DB_DRIVERS = {
            "psycopg2": "patch_psycopg2",
            "pymysql": "patch_pymysql",
            "mysql.connector": "patch_mysql_connector",
        }
        if fullname in _DB_DRIVERS:
            try:
                from trickle.db_observer import patch_psycopg2, patch_pymysql, patch_mysql_connector
                patcher = {"patch_psycopg2": patch_psycopg2, "patch_pymysql": patch_pymysql, "patch_mysql_connector": patch_mysql_connector}
                patcher[_DB_DRIVERS[fullname]](module)
            except Exception:
                pass
        return module


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def install_trace_hook() -> None:
    """Install the variable-tracing import hook.

    After calling this, any user module that gets imported will have
    ``__trickle_tv()`` calls inserted after every variable assignment,
    capturing runtime types and tensor shapes to ``.trickle/variables.jsonl``.
    """
    global _installed, _include_patterns, _exclude_patterns

    if _installed:
        return
    _installed = True

    enabled = os.environ.get("TRICKLE_ENABLED", "1").lower() not in ("0", "false")
    if not enabled:
        return

    trace_vars = os.environ.get("TRICKLE_TRACE_VARS", "1") not in ("0", "false")
    if not trace_vars:
        return

    debug = os.environ.get("TRICKLE_DEBUG", "").lower() in ("1", "true", "yes")

    include_raw = os.environ.get("TRICKLE_OBSERVE_INCLUDE", "")
    exclude_raw = os.environ.get("TRICKLE_OBSERVE_EXCLUDE", "")

    if include_raw:
        _include_patterns = [s.strip() for s in include_raw.split(",") if s.strip()]
    if exclude_raw:
        _exclude_patterns = [s.strip() for s in exclude_raw.split(",") if s.strip()]

    if debug:
        logging.basicConfig(level=logging.DEBUG)
        logger.debug("trickle: variable trace hook installed")

    finder = _TrickleTraceFinder()
    sys.meta_path.insert(0, finder)
