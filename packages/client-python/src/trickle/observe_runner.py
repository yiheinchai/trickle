"""Run a Python application with runtime type tracing.

Wraps the entry script (and imported user modules) so variable types,
tensor shapes, and sample values are written to ``.trickle/variables.jsonl``.

Usage:
    python -c "from trickle.observe_runner import main; main()" script.py

This is invoked by ``trickle run`` for Python commands.
"""

from __future__ import annotations

import json
import os
import runpy
import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m trickle.observe_runner <script.py | module>")
        print()
        print("Runs your application with runtime type tracing.")
        print("Variable types and tensor shapes are written to .trickle/variables.jsonl.")
        sys.exit(1)

    # Enable lovely-tensors for better tensor display (optional dependency)
    try:
        import lovely_tensors as _lt
        _lt.monkey_patch()
    except ImportError:
        pass

    # Clear previous trace data so only the latest run's results show
    _local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    _vars_file = os.path.join(_local_dir, "variables.jsonl")
    _errors_file = os.path.join(_local_dir, "errors.jsonl")
    try:
        if os.path.exists(_vars_file):
            with open(_vars_file, "w") as _f:
                _f.truncate(0)
    except OSError:
        pass
    try:
        if os.path.exists(_errors_file):
            with open(_errors_file, "w") as _f:
                _f.truncate(0)
    except OSError:
        pass

    os.environ["TRICKLE_LOCAL"] = "1"
    if not os.environ.get("TRICKLE_LOCAL_DIR"):
        os.environ["TRICKLE_LOCAL_DIR"] = _local_dir

    from trickle._trace_import_hook import install_trace_hook
    install_trace_hook()

    _debug = os.environ.get("TRICKLE_DEBUG", "").lower() in ("1", "true", "yes")

    target = sys.argv[1]
    sys.argv = sys.argv[1:]

    # Handle -m flag: "observe_runner -m module_name [args...]"
    if target == "-m" and len(sys.argv) >= 2:
        target = sys.argv[1]
        sys.argv = sys.argv[1:]  # keep module name as sys.argv[0]
        _user_code_error = None
        try:
            runpy.run_module(target, run_name="__main__", alter_sys=True)
        except SystemExit:
            raise
        except BaseException as exc:
            _user_code_error = exc

        _print_run_summary()

        if _user_code_error is not None:
            try:
                from trickle._error_context import print_error_context
                print_error_context(_user_code_error)
            except Exception:
                pass
            raise _user_code_error

        return

    _user_code_error = None

    if target.endswith(".py"):
        _transform_failed = False
        try:
            from trickle._entry_transform import run_entry_with_observation
            run_entry_with_observation(target)
        except SystemExit:
            raise
        except Exception as exc:
            # Transform-only failures are typically ImportError, SyntaxError,
            # or NameError from the preamble code.
            _is_trickle_internal = (
                isinstance(exc, (SyntaxError, ImportError))
                or (isinstance(exc, NameError) and "trickle" in str(exc))
            )
            if not _is_trickle_internal:
                _user_code_error = exc
            else:
                if _debug:
                    import traceback
                    print(f"[trickle] Entry transform failed, falling back to runpy: {exc}")
                    traceback.print_exc()
                _transform_failed = True

        if _transform_failed:
            try:
                runpy.run_path(target, run_name="__main__")
            except SystemExit:
                raise
            except BaseException as exc:
                _user_code_error = exc
    else:
        try:
            runpy.run_module(target, run_name="__main__", alter_sys=True)
        except SystemExit:
            raise
        except BaseException as exc:
            _user_code_error = exc

    _print_run_summary()

    if _user_code_error is not None:
        try:
            _write_error_snapshots(_user_code_error)
        except Exception:
            pass
        try:
            from trickle._error_context import print_error_context
            print_error_context(_user_code_error)
        except Exception:
            pass
        raise _user_code_error


def _print_run_summary() -> None:
    """Print how many variable records were captured this run."""
    try:
        local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
        vars_file = os.path.join(local_dir, "variables.jsonl")
        if not os.path.exists(vars_file):
            return
        n = 0
        with open(vars_file) as f:
            for line in f:
                if line.strip():
                    n += 1
        if n:
            print(f"[trickle] {n} variable record(s) captured → {os.path.relpath(vars_file)}")
    except Exception:
        pass


def _quick_type_sample(val):
    """Lightweight type + sample for error snapshots. No heavy imports."""
    _SL = int(os.environ.get("TRICKLE_SAMPLE_LEN", "200"))
    import types as _types
    if isinstance(val, (type, _types.ModuleType, _types.FunctionType, _types.BuiltinFunctionType)):
        return None, None
    if isinstance(val, bool):
        return {"kind": "primitive", "name": "boolean"}, val
    if isinstance(val, int):
        return {"kind": "primitive", "name": "integer"}, val
    if isinstance(val, float):
        return {"kind": "primitive", "name": "number"}, val
    if isinstance(val, str):
        return {"kind": "primitive", "name": "string"}, val[:_SL]
    if hasattr(val, "shape") and hasattr(val, "dtype"):
        shape = val.shape
        parts = [f"shape={list(shape)}", f"dtype={val.dtype}"]
        if hasattr(val, "device"):
            parts.append(f"device={val.device}")
        cn = type(val).__name__
        props = {
            "shape": {"kind": "primitive", "name": str(list(shape))},
            "dtype": {"kind": "primitive", "name": str(val.dtype)},
        }
        return {"kind": "object", "properties": props, "class_name": cn}, f'{cn}({", ".join(parts)})'
    if isinstance(val, (list, tuple)):
        items = []
        for item in val[:5]:  # limit to 5 for speed (tensors are slow to stringify)
            if item is None or isinstance(item, (bool, int, float)):
                items.append(item)
            elif isinstance(item, str):
                items.append(item[:80])
            elif hasattr(item, "shape") and hasattr(item, "dtype"):
                s = f"{type(item).__name__}(shape={list(item.shape)}, dtype={item.dtype})"
                items.append(s)
            else:
                items.append(type(item).__name__)
        if len(val) > 5:
            items.append(f"... ({len(val)} total)")
        elem_name = "unknown"
        if val and isinstance(val[0], str):
            elem_name = "string"
        elif val and isinstance(val[0], (int, float)):
            elem_name = "number"
        elif val and hasattr(val[0], "shape"):
            elem_name = type(val[0]).__name__
        return {"kind": "array", "element": {"kind": "primitive", "name": elem_name}}, items
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
        return {"kind": "primitive", "name": type(val).__name__}, d if d else str(val)[:_SL]
    return {"kind": "primitive", "name": type(val).__name__}, str(val)[:_SL]


def _write_error_snapshots(exc: BaseException) -> None:
    """Write error_snapshot records to variables.jsonl for script crashes."""
    import types as _types

    tb = exc.__traceback__
    if tb is None:
        return

    # Collect all user-code frames (same approach as notebook.py)
    user_frames = []
    user_lineno = 0
    user_filename = ""
    while tb is not None:
        fn = tb.tb_frame.f_code.co_filename
        skip = (
            fn.startswith("<") or "site-packages" in fn
            or "/lib/python" in fn or "\\lib\\python" in fn
        )
        if not skip:
            user_frames.append(tb.tb_frame)
            user_lineno = tb.tb_lineno
            user_filename = fn
        tb = tb.tb_next

    if not user_frames:
        return

    # Merge locals from all user frames
    merged_locals: dict = {}
    for frame in user_frames:
        merged_locals.update(frame.f_locals)

    error_msg = f"{type(exc).__name__}: {exc}"

    # Resolve temp file path back to original source file.
    # _entry_transform writes to .trickle_XXXXX.py in the same dir as the original.
    import re as _re
    base = os.path.basename(user_filename)
    if _re.match(r'\.trickle_\w+\.py$', base):
        # The original file is sys.argv[0] (set by _entry_transform)
        original = sys.argv[0] if len(sys.argv) > 0 else user_filename
        if os.path.exists(original):
            user_filename = os.path.abspath(original)

        # ast.unparse reformats code, so preamble subtraction doesn't give
        # correct original line numbers. Instead, extract the error line's
        # source text from the temp file and search for it in the original.
        preamble = int(os.environ.get("TRICKLE_PREAMBLE_LINES", "0"))
        try:
            # Get the source line from the innermost user frame
            err_source = user_frames[-1].f_code.co_filename
            import linecache
            err_line_text = linecache.getline(err_source, user_lineno).strip()
            if err_line_text:
                orig_lines = open(user_filename).readlines()
                found = False
                for i, line in enumerate(orig_lines):
                    if err_line_text == line.strip():
                        user_lineno = i + 1
                        found = True
                        break
                if not found:
                    import re as _re2
                    fragments = _re2.findall(r'[\w.]+\([^)]*\)', err_line_text)
                    if not fragments:
                        fragments = [err_line_text[:40]]
                    for frag in fragments:
                        for i, line in enumerate(orig_lines):
                            if frag in line:
                                user_lineno = i + 1
                                found = True
                                break
                        if found:
                            break
                if not found:
                    user_lineno = max(1, user_lineno - preamble)
            else:
                user_lineno = max(1, user_lineno - preamble)
        except Exception:
            user_lineno = max(1, user_lineno - preamble)

    trickle_dir = os.path.join(os.getcwd(), ".trickle")
    vars_file = os.path.join(trickle_dir, "variables.jsonl")
    if not os.path.exists(trickle_dir):
        os.makedirs(trickle_dir, exist_ok=True)

    _SKIP_NAMES = {
        '__name__', '__doc__', '__package__', '__loader__', '__spec__',
        '__annotations__', '__builtins__', '__file__', '__cached__',
    }

    records = []
    for name, val in list(merged_locals.items()):
        if name.startswith("_") or name.startswith(".") or name in _SKIP_NAMES:
            continue
        if isinstance(val, (type, _types.ModuleType, _types.FunctionType,
                            _types.BuiltinFunctionType, _types.MethodType)):
            continue
        try:
            type_node, sample = _quick_type_sample(val)
            if type_node is None:
                continue
            records.append({
                "kind": "error_snapshot",
                "varName": name,
                "line": user_lineno,
                "module": os.path.basename(user_filename).replace(".py", ""),
                "file": user_filename,
                "type": type_node,
                "typeHash": json.dumps(type_node, sort_keys=True)[:32],
                "sample": sample,
                "error": error_msg,
                "errorLine": user_lineno,
            })
        except Exception:
            pass

    if records:
        with open(vars_file, "a") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")


if __name__ == "__main__":
    main()
