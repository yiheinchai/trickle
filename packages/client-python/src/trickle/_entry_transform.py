"""AST transformation for entry file deep observation.

When ``trickle run script.py`` is used, the entry file is executed via
``runpy.run_path()`` — which means ``builtins.__import__`` never fires
for functions defined in the entry file itself.  Those functions would
be invisible to trickle.

This module solves the problem by:

1. Parsing the entry file's source with Python's ``ast`` module
2. Finding all function/async function definitions
3. Inserting wrapper calls immediately after each definition
4. Compiling and executing the transformed AST

The result is that ALL functions in the entry file are observed,
matching the deep observation behavior for imported modules.
"""

from __future__ import annotations

import ast
import os
import sys
from typing import Any, Dict, Optional


def run_entry_with_observation(
    filepath: str,
    module_name: Optional[str] = None,
) -> None:
    """Execute a Python script with all its functions wrapped for observation.

    This replaces ``runpy.run_path()`` for entry files, adding automatic
    function wrapping via AST transformation.
    """
    from .decorator import _wrap

    abs_path = os.path.abspath(filepath)

    if module_name is None:
        module_name = os.path.basename(filepath).rsplit(".", 1)[0]

    # Read source
    with open(abs_path, "r", encoding="utf-8") as f:
        source = f.read()

    # Transform AST to wrap functions
    try:
        code = _transform_source(source, abs_path)
    except SyntaxError:
        # If AST parsing fails, fall back to plain exec
        code = compile(source, abs_path, "exec")

    def __trickle_wrap_fn(fn: Any, name: str) -> Any:
        """Wrapper injected into the entry file's namespace."""
        try:
            return _wrap(fn, name=name, module=module_name)
        except Exception:
            return fn  # Never break user code

    # Set up globals to mimic runpy.run_path behavior
    globs: Dict[str, Any] = {
        "__name__": "__main__",
        "__file__": abs_path,
        "__cached__": None,
        "__doc__": None,
        "__loader__": None,
        "__package__": None,
        "__spec__": None,
        "__builtins__": __builtins__,
        "__trickle_wrap": __trickle_wrap_fn,
    }

    # Set sys.argv[0] to the script path
    sys.argv[0] = abs_path

    # Add the script's directory to sys.path (like python script.py does)
    script_dir = os.path.dirname(abs_path)
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)

    exec(code, globs)


def _transform_source(source: str, filename: str) -> Any:
    """Parse and transform source to wrap all function definitions.

    For each function/async function definition at any level, inserts
    a re-assignment statement immediately after::

        def process_data(items):
            ...
        process_data = __trickle_wrap(process_data, 'process_data')  # inserted

    Only wraps top-level and class-level functions (not nested functions,
    which are handled by their parent's observation).
    """
    tree = ast.parse(source, filename)

    # Transform the top-level body
    tree.body = _transform_body(tree.body)

    # Also transform class bodies (methods)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            node.body = _transform_body(node.body)

    ast.fix_missing_locations(tree)
    return compile(tree, filename, "exec")


def _transform_body(body: list) -> list:
    """Insert wrapper calls after each function definition in a body."""
    new_body: list = []

    for node in body:
        new_body.append(node)

        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # Skip private/dunder methods
            if node.name.startswith("_"):
                continue

            # Insert: func_name = __trickle_wrap(func_name, 'func_name')
            wrap_stmt = ast.Assign(
                targets=[ast.Name(id=node.name, ctx=ast.Store())],
                value=ast.Call(
                    func=ast.Name(id="__trickle_wrap", ctx=ast.Load()),
                    args=[
                        ast.Name(id=node.name, ctx=ast.Load()),
                        ast.Constant(value=node.name),
                    ],
                    keywords=[],
                ),
            )
            new_body.append(wrap_stmt)

    return new_body
