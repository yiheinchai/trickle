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

    # Transform top-level body
    tree.body = _transform_body(tree.body)

    # Transform class bodies
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            node.body = _transform_body(node.body)

    # Transform function bodies (including parameter traces)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            param_traces = _make_param_traces(node)
            node.body = param_traces + _transform_func_body(node.body)

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
# --- trickle variable tracer ---
import os as _trickle_os
import json as _trickle_json
_trickle_tv_cache = set()
_trickle_tv_file = None
def _trickle_tv(_val, _name, _line):
    global _trickle_tv_file
    try:
        if _trickle_tv_file is None:
            _d = _trickle_os.environ.get('TRICKLE_LOCAL_DIR') or _trickle_os.path.join(_trickle_os.getcwd(), '.trickle')
            _trickle_os.makedirs(_d, exist_ok=True)
            _trickle_tv_file = _trickle_os.path.join(_d, 'variables.jsonl')
        from trickle.type_inference import infer_type
        _t = infer_type(_val, max_depth=3)
        _th = _trickle_json.dumps(_t, sort_keys=True)[:32]
        _ck = {filename!r} + ':' + str(_line) + ':' + _name + ':' + _th
        if _ck in _trickle_tv_cache:
            return
        _trickle_tv_cache.add(_ck)
        _s = None
        if hasattr(_val, 'shape') and hasattr(_val, 'dtype'):
            _parts = [f'shape={{list(_val.shape)}}', f'dtype={{_val.dtype}}']
            if hasattr(_val, 'device'): _parts.append(f'device={{_val.device}}')
            _s = f'{{type(_val).__name__}}({{", ".join(_parts)}})'
        elif isinstance(_val, (int, float, bool)):
            _s = _val
        elif isinstance(_val, str):
            _s = _val[:100]
        else:
            _s = str(_val)[:100]
        _r = {{'kind': 'variable', 'varName': _name, 'line': _line, 'module': {module_name!r}, 'file': {filename!r}, 'type': _t, 'typeHash': _th, 'sample': _s}}
        with open(_trickle_tv_file, 'a') as _f:
            _f.write(_trickle_json.dumps(_r) + '\\n')
    except Exception:
        pass
# --- end trickle variable tracer ---
"""


def _transform_body(body: list) -> list:
    """Insert trace calls after assignments in a module/class body.

    Also recurses into compound statements (for, if, while, with, try) so that
    variable assignments and for-loop iteration variables are traced.
    """
    new_body: list = []
    for node in body:
        new_body.append(node)
        # Skip function/class defs — they're handled separately
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
            node.body = _transform_toplevel_block(node.body)
            continue
        if isinstance(node, ast.Try):
            node.body = _transform_toplevel_block(node.body)
            for handler in node.handlers:
                handler.body = _transform_toplevel_block(handler.body)
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
            node.body = _transform_toplevel_block(node.body)
            continue
        if isinstance(node, ast.Try):
            node.body = _transform_toplevel_block(node.body)
            for handler in node.handlers:
                handler.body = _transform_toplevel_block(handler.body)
            if node.orelse:
                node.orelse = _transform_toplevel_block(node.orelse)
            if node.finalbody:
                node.finalbody = _transform_toplevel_block(node.finalbody)
            continue
        trace_stmts = _make_trace_stmts(node)
        new_body.extend(trace_stmts)
    return new_body


def _transform_func_body(body: list) -> list:
    """Insert trace calls after variable assignments inside function bodies.

    Also transforms ``return`` statements to trace return values before returning.
    """
    new_body: list = []
    for node in body:
        # Recurse into compound statements
        if isinstance(node, (ast.If, ast.While)):
            node.body = _transform_func_body(node.body)
            if hasattr(node, "orelse") and node.orelse:
                node.orelse = _transform_func_body(node.orelse)
            new_body.append(node)
            continue
        if isinstance(node, (ast.For, ast.AsyncFor)):
            loop_var_traces = _make_for_target_traces(node)
            node.body = loop_var_traces + _transform_func_body(node.body)
            if hasattr(node, "orelse") and node.orelse:
                node.orelse = _transform_func_body(node.orelse)
            new_body.append(node)
            continue
        if isinstance(node, (ast.With, ast.AsyncWith)):
            node.body = _transform_func_body(node.body)
            new_body.append(node)
            continue
        if isinstance(node, ast.Try):
            node.body = _transform_func_body(node.body)
            for handler in node.handlers:
                handler.body = _transform_func_body(handler.body)
            if node.orelse:
                node.orelse = _transform_func_body(node.orelse)
            if node.finalbody:
                node.finalbody = _transform_func_body(node.finalbody)
            new_body.append(node)
            continue
        # Don't recurse into nested functions
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            new_body.append(node)
            continue

        # Trace return values
        if isinstance(node, ast.Return) and node.value is not None:
            ret_stmts = _make_return_trace(node)
            new_body.extend(ret_stmts)
            continue

        new_body.append(node)
        trace_stmts = _make_trace_stmts(node)
        new_body.extend(trace_stmts)

    return new_body


def _make_return_trace(node: ast.Return) -> list:
    """Transform a return statement to trace the return value before returning.

    ``return logits, loss`` becomes::

        _trickle_ret = (logits, loss)
        _trickle_tv(logits, '<return:logits>', lineno)
        _trickle_tv(loss, '<return:loss>', lineno)
        _trickle_tv(_trickle_ret, '<return>', lineno)
        return _trickle_ret
    """
    lineno = getattr(node, "lineno", 0)
    stmts: list = []

    assign = ast.Assign(
        targets=[ast.Name(id="_trickle_ret", ctx=ast.Store())],
        value=node.value,
    )
    stmts.append(assign)

    # If returning a tuple literal (return a, b, c), trace each element
    if isinstance(node.value, ast.Tuple):
        for elt in node.value.elts:
            if isinstance(elt, ast.Name) and not elt.id.startswith("_"):
                trace = ast.Expr(value=ast.Call(
                    func=ast.Name(id="_trickle_tv", ctx=ast.Load()),
                    args=[
                        ast.Name(id=elt.id, ctx=ast.Load()),
                        ast.Constant(value=f"<return:{elt.id}>"),
                        ast.Constant(value=lineno),
                    ],
                    keywords=[],
                ))
                stmts.append(trace)

    trace_ret = ast.Expr(value=ast.Call(
        func=ast.Name(id="_trickle_tv", ctx=ast.Load()),
        args=[
            ast.Name(id="_trickle_ret", ctx=ast.Load()),
            ast.Constant(value="<return>"),
            ast.Constant(value=lineno),
        ],
        keywords=[],
    ))
    stmts.append(trace_ret)

    new_return = ast.Return(value=ast.Name(id="_trickle_ret", ctx=ast.Load()))
    stmts.append(new_return)

    return stmts


def _make_trace_stmts(node: ast.AST) -> list:
    """Generate __trickle_tv() calls for variable names assigned in this node."""
    names = _extract_assigned_names(node)
    stmts = []
    for name in names:
        trace_call = ast.Expr(
            value=ast.Call(
                func=ast.Name(id="_trickle_tv", ctx=ast.Load()),
                args=[
                    ast.Name(id=name, ctx=ast.Load()),
                    ast.Constant(value=name),
                    ast.Constant(value=getattr(node, "lineno", 0)),
                ],
                keywords=[],
            )
        )
        stmts.append(trace_call)
    return stmts


def _make_param_traces(node: ast.AST) -> list:
    """Generate trace calls for function parameters.

    For ``def forward(self, x, mask=None):``, this produces trace calls
    for x and mask (skipping self/cls and _-prefixed params) inserted
    at the start of the function body.
    """
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
        trace_call = ast.Expr(
            value=ast.Call(
                func=ast.Name(id="_trickle_tv", ctx=ast.Load()),
                args=[
                    ast.Name(id=name, ctx=ast.Load()),
                    ast.Constant(value=name),
                    ast.Constant(value=lineno),
                ],
                keywords=[],
            )
        )
        stmts.append(trace_call)
    return stmts


def _make_for_target_traces(node: ast.AST) -> list:
    """Generate trace calls for for-loop iteration variables.

    For ``for batch_idx, (data, target) in enumerate(loader):``,
    this produces trace calls for batch_idx, data, and target
    inserted at the start of the loop body.
    """
    if not isinstance(node, (ast.For, ast.AsyncFor)):
        return []
    names = _names_from_target(node.target)
    names = [n for n in names if not n.startswith("_")]
    stmts = []
    for name in names:
        trace_call = ast.Expr(
            value=ast.Call(
                func=ast.Name(id="_trickle_tv", ctx=ast.Load()),
                args=[
                    ast.Name(id=name, ctx=ast.Load()),
                    ast.Constant(value=name),
                    ast.Constant(value=getattr(node, "lineno", 0)),
                ],
                keywords=[],
            )
        )
        stmts.append(trace_call)
    return stmts


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

        filepath = self.spec.origin
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
