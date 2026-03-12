"""AST transformation for entry file deep observation.

When ``trickle run script.py`` is used, the entry file is executed via
``runpy.run_path()`` — which means ``builtins.__import__`` never fires
for functions defined in the entry file itself.  Those functions would
be invisible to trickle.

This module solves the problem by:

1. Parsing the entry file's source with Python's ``ast`` module
2. Finding all function/async function definitions
3. Inserting wrapper calls immediately after each definition
4. Inserting variable trace calls after each assignment statement
5. Compiling and executing the transformed AST

The result is that ALL functions in the entry file are observed and
ALL variable assignments are traced with their runtime types/shapes,
matching the deep observation behavior for imported modules.
"""

from __future__ import annotations

import ast
import json
import os
import sys
from typing import Any, Dict, Optional, Set


def run_entry_with_observation(
    filepath: str,
    module_name: Optional[str] = None,
    trace_vars: bool = True,
) -> None:
    """Execute a Python script with all its functions wrapped for observation.

    This replaces ``runpy.run_path()`` for entry files, adding automatic
    function wrapping via AST transformation and variable tracing.

    Instead of using exec() with custom globals (which breaks complex imports
    like torch), this writes a transformed source file and runs it with
    runpy.run_path(), prepending the tracer/wrapper setup code as imports.
    """
    import tempfile

    abs_path = os.path.abspath(filepath)

    if module_name is None:
        module_name = os.path.basename(filepath).rsplit(".", 1)[0]

    # Check env for trace_vars override
    if os.environ.get("TRICKLE_TRACE_VARS", "1") in ("0", "false"):
        trace_vars = False

    # Read source
    with open(abs_path, "r", encoding="utf-8") as f:
        source = f.read()

    # Transform source text (not AST-compiled code, but source string)
    try:
        transformed_source = _transform_to_source(source, abs_path, module_name, trace_vars=trace_vars)
    except SyntaxError:
        # If AST parsing fails, fall back to plain runpy
        import runpy
        runpy.run_path(filepath, run_name="__main__")
        return

    # Write transformed source to a temp file next to the original
    # so relative imports still work
    script_dir = os.path.dirname(abs_path)
    fd, tmp_path = tempfile.mkstemp(suffix=".py", dir=script_dir, prefix=".trickle_")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(transformed_source)

        # Add the script's directory to sys.path
        if script_dir not in sys.path:
            sys.path.insert(0, script_dir)

        sys.argv[0] = abs_path

        import runpy
        runpy.run_path(tmp_path, run_name="__main__")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _make_var_tracer(filepath: str, module_name: str) -> Any:
    """Create the __trickle_tv function that traces variable assignments.

    Returns a function(value, var_name, line_no) that:
    1. Infers the runtime type (including tensor shapes)
    2. Caches by (file, line, var_name, type_hash) to avoid redundant writes
    3. Appends to .trickle/variables.jsonl
    """
    from .type_inference import infer_type

    cache: Set[str] = set()
    vars_file: Optional[str] = None

    def _tv(value: Any, var_name: str, line_no: int) -> None:
        nonlocal vars_file
        try:
            if vars_file is None:
                local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
                os.makedirs(local_dir, exist_ok=True)
                vars_file = os.path.join(local_dir, "variables.jsonl")

            type_node = infer_type(value, max_depth=3)
            type_hash = json.dumps(type_node, sort_keys=True)[:32]
            cache_key = f"{filepath}:{line_no}:{var_name}:{type_hash}"

            if cache_key in cache:
                return
            cache.add(cache_key)

            # Build a small sample value for display
            sample = _sanitize(value, depth=2)

            record = {
                "kind": "variable",
                "varName": var_name,
                "line": line_no,
                "module": module_name,
                "file": filepath,
                "type": type_node,
                "typeHash": type_hash,
                "sample": sample,
            }
            with open(vars_file, "a") as f:
                f.write(json.dumps(record) + "\n")
        except Exception:
            pass  # Never break user code

    return _tv


def _sanitize(value: Any, depth: int = 2) -> Any:
    """Create a small JSON-safe sample of a value for display."""
    if depth <= 0:
        return "[truncated]"
    if value is None:
        return None
    t = type(value)
    tname = t.__name__

    # Tensor-like objects: show shape info as the sample
    if hasattr(value, "shape") and hasattr(value, "dtype"):
        parts = [f"shape={list(value.shape)}", f"dtype={value.dtype}"]
        if hasattr(value, "device"):
            parts.append(f"device={value.device}")
        return f"{tname}({', '.join(parts)})"

    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        return value[:100] + "..." if len(value) > 100 else value
    if isinstance(value, (list, tuple)):
        items = [_sanitize(v, depth - 1) for v in value[:3]]
        if len(value) > 3:
            items.append(f"...({len(value)} total)")
        return items
    if isinstance(value, dict):
        r = {}
        for i, (k, v) in enumerate(value.items()):
            if i >= 5:
                r["..."] = f"({len(value)} total)"
                break
            r[str(k)] = _sanitize(v, depth - 1)
        return r
    return str(value)[:100]


def _transform_to_source(source: str, filename: str, module_name: str, trace_vars: bool = True) -> str:
    """Parse and transform source, returning the transformed Python source string.

    This generates a self-contained Python source with the tracer/wrapper
    setup code prepended, so it can be written to a file and run with runpy.
    """
    tree = ast.parse(source, filename)

    # Transform the top-level body
    tree.body = _transform_body(tree.body, trace_vars=trace_vars)

    # Also transform class bodies (methods)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            node.body = _transform_body(node.body, trace_vars=trace_vars)

    # Transform function bodies for variable tracing (including parameter traces)
    # Walk with class context to build qualified function names (Class.method)
    if trace_vars:
        _transform_functions_with_context(tree, class_name=None)

    ast.fix_missing_locations(tree)

    # Convert AST back to source
    transformed = ast.unparse(tree)

    # Prepend the tracer setup code
    setup = _generate_setup_code(filename, module_name, trace_vars)
    return setup + "\n" + transformed


def _transform_functions_with_context(node: ast.AST, class_name: str | None) -> None:
    """Walk the AST and transform function bodies with qualified function names.

    For methods inside classes, produces names like 'GPT.forward'.
    For top-level functions, just 'train'.
    """
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.ClassDef):
            # Recurse into class body with class context
            _transform_functions_with_context(child, class_name=child.name)
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            func_name = f"{class_name}.{child.name}" if class_name else child.name
            param_traces = _make_param_traces(child, func_name=func_name)
            child.body = param_traces + _transform_func_body(child.body, func_name=func_name)
            # Don't recurse into nested functions from here — _transform_func_body handles them
        else:
            # Recurse into other compound nodes (if/for/with/try at module level)
            _transform_functions_with_context(child, class_name=class_name)


def _generate_setup_code(filename: str, module_name: str, trace_vars: bool) -> str:
    """Generate the Python source code that sets up _trickle_wrap and _trickle_tv.

    Uses single-underscore prefix (_trickle_tv, not __trickle_tv) to avoid
    Python's name mangling inside class bodies.
    """
    lines = [
        "# --- trickle auto-instrumentation preamble ---",
        "import os as _trickle_os",
        "import json as _trickle_json",
    ]

    # Function wrapper — when variable tracing is active, function wrapping
    # is redundant (the tracer captures all values) and can interfere with
    # frameworks like PyTorch whose tensors don't work through proxies.
    if trace_vars:
        lines.append("def _trickle_wrap(__fn, __name): return __fn")
    else:
        lines.extend([
            "def _trickle_wrap(__fn, __name):",
            "    try:",
            "        from trickle.decorator import _wrap",
            f"        return _wrap(__fn, name=__name, module={module_name!r})",
            "    except Exception:",
            "        return __fn",
        ])

    if trace_vars:
        lines.extend([
            "# Variable tracer with tensor shape support",
            "_trickle_tv_cache = set()",
            "_trickle_tv_file = None",
            "def _trickle_tv(_val, _name, _line, _func=None):",
            "    global _trickle_tv_file",
            "    try:",
            "        if _trickle_tv_file is None:",
            "            _d = _trickle_os.environ.get('TRICKLE_LOCAL_DIR') or _trickle_os.path.join(_trickle_os.getcwd(), '.trickle')",
            "            _trickle_os.makedirs(_d, exist_ok=True)",
            "            _trickle_tv_file = _trickle_os.path.join(_d, 'variables.jsonl')",
            "        from trickle.type_inference import infer_type",
            "        _t = infer_type(_val, max_depth=3)",
            "        _th = _trickle_json.dumps(_t, sort_keys=True)[:32]",
            f"        _ck = {filename!r} + ':' + str(_line) + ':' + _name + ':' + _th",
            "        if _ck in _trickle_tv_cache:",
            "            return",
            "        _trickle_tv_cache.add(_ck)",
            "        # Build sample",
            "        _s = None",
            "        if hasattr(_val, 'shape') and hasattr(_val, 'dtype'):",
            "            _parts = [f'shape={list(_val.shape)}', f'dtype={_val.dtype}']",
            "            if hasattr(_val, 'device'): _parts.append(f'device={_val.device}')",
            "            _s = f'{type(_val).__name__}({\", \".join(_parts)})'",
            "        elif isinstance(_val, (int, float, bool)):",
            "            _s = _val",
            "        elif isinstance(_val, str):",
            "            _s = _val[:100]",
            "        else:",
            "            _s = str(_val)[:100]",
            f"        _r = {{'kind': 'variable', 'varName': _name, 'line': _line, 'module': {module_name!r}, 'file': {filename!r}, 'type': _t, 'typeHash': _th, 'sample': _s}}",
            "        if _func: _r['funcName'] = _func",
            "        with open(_trickle_tv_file, 'a') as _f:",
            "            _f.write(_trickle_json.dumps(_r) + '\\n')",
            "    except Exception:",
            "        pass",
        ])
    else:
        lines.append("def _trickle_tv(_val, _name, _line): pass")

    lines.append("# --- end trickle preamble ---")
    return "\n".join(lines)


def _transform_source(source: str, filename: str, trace_vars: bool = True) -> Any:
    """Parse and transform source to wrap all function definitions and trace variables.

    For each function/async function definition at any level, inserts
    a re-assignment statement immediately after::

        def process_data(items):
            ...
        process_data = _trickle_wrap(process_data, 'process_data')  # inserted

    For each variable assignment, inserts a trace call::

        x = some_computation()
        __trickle_tv(x, 'x', 42)  # inserted — line 42

    Only wraps top-level and class-level functions (not nested functions,
    which are handled by their parent's observation).
    """
    tree = ast.parse(source, filename)

    # Transform the top-level body
    tree.body = _transform_body(tree.body, trace_vars=trace_vars)

    # Also transform class bodies (methods)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            node.body = _transform_body(node.body, trace_vars=trace_vars)

    # Transform function bodies for variable tracing (including parameter traces)
    if trace_vars:
        _transform_functions_with_context(tree, class_name=None)

    ast.fix_missing_locations(tree)
    return compile(tree, filename, "exec")


def _transform_body(body: list, trace_vars: bool = True) -> list:
    """Insert wrapper calls after function defs and trace calls after assignments.

    Also recurses into compound statements (for, if, while, with, try) at
    module/class level so that variable assignments and for-loop iteration
    variables inside those blocks are traced.
    """
    new_body: list = []

    for node in body:
        new_body.append(node)

        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # Skip private/dunder methods
            if node.name.startswith("_"):
                continue

            # Insert: func_name = _trickle_wrap(func_name, 'func_name')
            wrap_stmt = ast.Assign(
                targets=[ast.Name(id=node.name, ctx=ast.Store())],
                value=ast.Call(
                    func=ast.Name(id="_trickle_wrap", ctx=ast.Load()),
                    args=[
                        ast.Name(id=node.name, ctx=ast.Load()),
                        ast.Constant(value=node.name),
                    ],
                    keywords=[],
                ),
            )
            new_body.append(wrap_stmt)
            continue

        if isinstance(node, ast.ClassDef):
            continue

        # Recurse into compound statements at module level
        if trace_vars:
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
    """Transform a block inside a module-level compound statement.

    Similar to _transform_func_body but used for module-level for/if/while etc.
    """
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

        # Don't recurse into nested function defs (they get their own treatment)
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

    return stmts


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
    """Generate trace calls for with-statement ``as`` variables.

    For ``with open(path) as f:`` or ``with ctx_a as a, ctx_b as b:``,
    trace each bound variable at the start of the with body.
    """
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
    """Generate a trace call for an exception handler ``as`` variable.

    For ``except RuntimeError as e:``, trace ``e`` at the start of the handler body.
    """
    if not handler.name or handler.name.startswith("_"):
        return []
    lineno = getattr(handler, "lineno", 0)
    return [_make_tv_call(
        ast.Name(id=handler.name, ctx=ast.Load()), handler.name, lineno, func_name,
    )]


def _extract_assigned_names(node: ast.AST) -> list:
    """Extract simple variable names from an assignment node.

    Handles:
      - ast.Assign: x = ..., x, y = ..., (a, b) = ...
      - ast.AnnAssign: x: int = ...
      - ast.AugAssign: x += ...
      - Destructuring: a, b = ..., [a, b] = ..., etc.
    """
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
            # Skip private/dunder
            if attr_name.startswith("_"):
                continue
            # Build the display name (e.g. "self.weight")
            if isinstance(target.value, ast.Name):
                obj_name = target.value.id
                display_name = f"{obj_name}.{attr_name}"
                # Build AST node to read the value back
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
