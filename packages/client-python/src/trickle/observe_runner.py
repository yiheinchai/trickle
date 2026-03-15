"""Run a Python application with universal auto-observation.

Unlike ``python -m trickle`` which only patches Flask/FastAPI, this
wraps ALL exported functions in user modules automatically.

Usage:
    python -c "from trickle.observe_runner import main; main()" script.py

This is invoked by ``trickle run`` for Python commands.
"""

from __future__ import annotations

import json
import os
import runpy
import sys
import time


def _patch_console(local_dir: str) -> None:
    """Patch sys.stdout/stderr to also capture output to console.jsonl."""
    console_file = os.path.join(local_dir, "console.jsonl")
    try:
        os.makedirs(local_dir, exist_ok=True)
        open(console_file, "w").close()  # Clear previous
    except Exception:
        return

    _orig_stdout_write = sys.stdout.write
    _orig_stderr_write = sys.stderr.write

    def _capture(level: str, text: str) -> None:
        try:
            msg = text.strip()
            if not msg or msg.startswith("[trickle"):
                return
            record = {"level": level, "message": msg[:500], "timestamp": int(time.time() * 1000)}
            with open(console_file, "a") as f:
                f.write(json.dumps(record) + "\n")
        except Exception:
            pass

    def _stdout_write(text: str) -> int:
        _capture("log", text)
        return _orig_stdout_write(text)

    def _stderr_write(text: str) -> int:
        _capture("error", text)
        return _orig_stderr_write(text)

    sys.stdout.write = _stdout_write  # type: ignore
    sys.stderr.write = _stderr_write  # type: ignore


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m trickle.observe_runner <script.py | module>")
        print()
        print("Runs your application with universal function observation.")
        print("All exported functions in user modules are auto-wrapped.")
        sys.exit(1)

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

    # Configure transport for local mode (writes observations to .trickle/observations.jsonl)
    os.environ["TRICKLE_LOCAL"] = "1"
    if not os.environ.get("TRICKLE_LOCAL_DIR"):
        os.environ["TRICKLE_LOCAL_DIR"] = _local_dir
    from trickle.transport import configure as _configure_transport
    _configure_transport()

    # Initialize call trace for execution flow recording
    from trickle.call_trace import init_call_trace
    init_call_trace()

    # Start memory profiling
    try:
        from trickle.profile_observer import start_profiling
        start_profiling()
    except Exception:
        pass

    # Install hooks BEFORE loading user code.
    import os as _os2
    _trace_vars = _os2.environ.get("TRICKLE_TRACE_VARS", "1") not in ("0", "false")
    if _trace_vars:
        # Variable tracing mode: use AST import hook to trace variables
        # in all imported user modules (captures tensor shapes, etc.)
        from trickle._trace_import_hook import install_trace_hook
        install_trace_hook()
    else:
        # Legacy function-wrapping mode
        from trickle._observe_auto import install
        install()

    # Capture console output to .trickle/console.jsonl for agent debugging
    if _os2.environ.get("TRICKLE_CAPTURE_CONSOLE", "1") != "0":
        _patch_console(_local_dir)

    # Patch HTTP libraries (requests, httpx) for API type capture
    import os as _os
    _debug = _os.environ.get("TRICKLE_DEBUG", "").lower() in ("1", "true", "yes")
    try:
        from trickle.http_observer import patch_http
        patch_http(environment="default", debug=_debug)
    except Exception:
        pass  # Never block the user's app

    # Patch database drivers (sqlite3, psycopg2, pymysql, mysql.connector)
    try:
        from trickle.db_observer import patch_databases
        patch_databases(debug=_debug)
    except Exception:
        pass  # Never block the user's app

    target = sys.argv[1]
    sys.argv = sys.argv[1:]

    _user_code_error = None

    if target.endswith(".py"):
        # Use AST transformation to observe entry file functions
        _transform_failed = False
        try:
            from trickle._entry_transform import run_entry_with_observation
            run_entry_with_observation(target)
        except SystemExit:
            raise
        except Exception as exc:
            # Check if this is a transform/setup error vs user code error
            # Transform errors happen before user code runs (SyntaxError in transform, etc.)
            # User code errors propagate through runpy
            # Heuristic: if the exception isn't an import/syntax error from
            # trickle internals, treat it as a user code error.
            # Transform-only failures are typically ImportError, SyntaxError,
            # or NameError from the preamble code.
            _is_trickle_internal = (
                isinstance(exc, (SyntaxError, ImportError))
                or (isinstance(exc, NameError) and "trickle" in str(exc))
            )
            _has_user_frames = not _is_trickle_internal

            if _has_user_frames:
                # User code crashed — show error context and re-raise
                _user_code_error = exc
            else:
                # Transform/setup error — fall back to plain runpy
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

    # Generate .pyi stubs from observations (unless TRICKLE_STUBS=0)
    _stubs_enabled = os.environ.get("TRICKLE_STUBS", "1").lower() not in ("0", "false")
    if _stubs_enabled:
        try:
            from trickle._auto_codegen import generate_types
            count = generate_types()
            if count and count > 0:
                print(f"[trickle] {count} function type(s) written to .pyi")
        except Exception:
            pass

    # Print summary after run (success or failure)
    if _trace_vars:
        try:
            from trickle._run_summary import print_run_summary
            print_run_summary()
        except Exception:
            pass

    if _user_code_error is not None:
        # Print tensor shape context for the error before re-raising
        if _trace_vars:
            try:
                from trickle._error_context import print_error_context
                print_error_context(_user_code_error)
            except Exception:
                pass
        raise _user_code_error


if __name__ == "__main__":
    main()
