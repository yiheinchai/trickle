"""Run a Python application with universal auto-observation.

Unlike ``python -m trickle`` which only patches Flask/FastAPI, this
wraps ALL exported functions in user modules automatically.

Usage:
    python -c "from trickle.observe_runner import main; main()" script.py

This is invoked by ``trickle run`` for Python commands.
"""

from __future__ import annotations

import os
import runpy
import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m trickle.observe_runner <script.py | module>")
        print()
        print("Runs your application with universal function observation.")
        print("All exported functions in user modules are auto-wrapped.")
        sys.exit(1)

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

    # Patch HTTP libraries (requests, httpx) for API type capture
    import os as _os
    _debug = _os.environ.get("TRICKLE_DEBUG", "").lower() in ("1", "true", "yes")
    try:
        from trickle.http_observer import patch_http
        patch_http(environment="default", debug=_debug)
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
