"""trickle.auto — Zero-config type generation for Python.

Add ONE LINE to your app and .pyi type stubs appear automatically::

    import trickle.auto

This module:
1. Forces local mode (no backend needed)
2. Installs the import hook to wrap all user functions in imported modules
3. Installs a sys.setprofile hook to observe functions in the entry file
4. Runs a background thread that generates .pyi files from observations
5. On process exit, does a final type generation
6. In IPython/Jupyter, generates types after each cell execution

No CLI. No backend. No configuration. Just types.
Works for ALL functions — including those defined in the entry file itself.
Works in Jupyter notebooks — types update after each cell.
"""

from __future__ import annotations

import atexit
import json
import os
import sys
import threading

# Force local mode BEFORE importing anything that calls configure
os.environ["TRICKLE_LOCAL"] = "1"

# Install the auto-observe import hook (wraps all user module functions)
from trickle._observe_auto import install as _install_observe_hook  # noqa: E402
_install_observe_hook()

# Import the codegen
from trickle._auto_codegen import generate_types, inject_python_types, generate_coverage_report, generate_type_summary  # noqa: E402

_debug = os.environ.get("TRICKLE_DEBUG", "").lower() in ("1", "true", "yes")
_last_function_count = 0
_generation_count = 0
_stop_event = threading.Event()


def _run_generation(is_final: bool) -> None:
    """Run type generation and optionally log results."""
    global _last_function_count, _generation_count

    try:
        count = generate_types()
        if count == -1:
            return  # no change

        if count > 0:
            _generation_count += 1
            new_types = count - _last_function_count
            if new_types > 0 and _generation_count > 1:
                print(f"[trickle.auto] +{new_types} type(s) generated ({count} total)")
            _last_function_count = count

        if is_final and _last_function_count > 0:
            print(f"[trickle.auto] {_last_function_count} function type(s) written to .pyi")
            # Inject type annotations into source files if TRICKLE_INJECT=1
            try:
                injected = inject_python_types()
                if injected > 0:
                    print(f"[trickle.auto] {injected} function(s) annotated with type hints in source")
            except Exception:
                pass
            # Print coverage report if TRICKLE_COVERAGE=1
            try:
                report = generate_coverage_report()
                if report:
                    print(report)
            except Exception:
                pass
            # Print type summary if TRICKLE_SUMMARY=1
            try:
                summary = generate_type_summary()
                if summary:
                    print(summary)
            except Exception:
                pass
    except Exception:
        # Never crash user's app
        pass


def _background_worker() -> None:
    """Background thread that regenerates types every 3 seconds."""
    while not _stop_event.wait(timeout=3.0):
        _run_generation(False)


# Start background thread (daemon so it doesn't keep the process alive)
_worker = threading.Thread(target=_background_worker, daemon=True, name="trickle-auto-codegen")
_worker.start()

# Also do a first check after 1 second
_initial_timer = threading.Timer(1.0, lambda: _run_generation(False))
_initial_timer.daemon = True
_initial_timer.start()


# ── Entry file observation via sys.setprofile ──
#
# The import hook (above) wraps functions in IMPORTED modules. But functions
# defined directly in the entry file (the script you run) can't be caught
# by the import hook because the entry file is already executing when the
# hook is installed.
#
# Solution: use sys.setprofile() to intercept function calls in the entry
# file. The profile hook fires on 'call' and 'return' events with minimal
# overhead (no per-line tracing like sys.settrace). We filter to only
# observe functions whose code object lives in the entry file.

_entry_file: str | None = None
_ipython_mode = False

# Check if we're in IPython FIRST — this affects entry file handling
try:
    _ip_check = get_ipython()  # type: ignore[name-defined]  # noqa: F821
    if _ip_check is not None:
        _ipython_mode = True
except NameError:
    pass

# Determine the entry file path (skip in IPython — argv[0] points to ipython binary)
if not _ipython_mode and hasattr(sys, "argv") and sys.argv:
    _candidate = os.path.abspath(sys.argv[0])
    if os.path.isfile(_candidate):
        _entry_file = _candidate

if _entry_file or _ipython_mode:
    from trickle.type_inference import infer_type  # noqa: E402
    from trickle.type_hash import hash_type  # noqa: E402
    from trickle.transport import enqueue  # noqa: E402
    from trickle.env_detect import detect_environment  # noqa: E402

    _env = detect_environment()
    if _ipython_mode:
        _entry_module = "__interactive__"
    elif _entry_file:
        _entry_module = os.path.basename(_entry_file).rsplit(".", 1)[0]
    else:
        _entry_module = "__interactive__"
    _pending_calls: dict = {}  # id(frame) -> (name, args_type, sample_input)
    _old_profile = sys.getprofile()

    def _entry_profile(frame: object, event: str, arg: object) -> None:
        """Profile hook that observes function calls in the entry file (or IPython cells)."""
        # Chain to previous profiler if any
        if _old_profile is not None:
            _old_profile(frame, event, arg)

        try:
            # Fast path: skip non-relevant frames
            co_filename = frame.f_code.co_filename  # type: ignore[union-attr]
            if _ipython_mode:
                # In IPython, observe functions from cells (filename contains
                # 'ipykernel' or starts with '<ipython-input-')
                is_cell = (
                    "<ipython-input-" in co_filename
                    or "ipykernel_" in co_filename
                    or co_filename.startswith("/tmp/ipykernel")
                    or co_filename == "<stdin>"
                )
                if not is_cell:
                    return
            elif co_filename != _entry_file:
                return

            if event == "call":
                name = frame.f_code.co_name  # type: ignore[union-attr]
                # Skip private, module-level, lambda, and special functions
                if name.startswith("_") or name in ("<module>", "<lambda>", "<listcomp>", "<dictcomp>", "<setcomp>", "<genexpr>"):
                    return

                # Capture args from frame locals
                code = frame.f_code  # type: ignore[union-attr]
                nargs = code.co_argcount
                arg_names = code.co_varnames[:nargs]
                locals_dict = frame.f_locals  # type: ignore[union-attr]
                args = tuple(locals_dict.get(n) for n in arg_names)

                # Infer arg types
                if len(args) == 0:
                    args_type = {"kind": "tuple", "elements": []}
                elif len(args) == 1:
                    args_type = {"kind": "tuple", "elements": [infer_type(args[0])]}
                else:
                    args_type = {
                        "kind": "tuple",
                        "elements": [infer_type(a) for a in args],
                    }

                # Store pending call (keyed by frame id for correct matching)
                _pending_calls[id(frame)] = (name, args_type, list(args[:3]), list(arg_names))

            elif event == "return":
                key = id(frame)  # type: ignore[arg-type]
                if key not in _pending_calls:
                    return

                func_name, args_type, sample_input, param_names = _pending_calls.pop(key)

                # Infer return type
                return_type = infer_type(arg)

                # Compute type hash
                type_hash = hash_type(args_type, return_type)

                # Build and enqueue payload
                payload: dict = {
                    "functionName": func_name,
                    "module": _entry_module,
                    "language": "python",
                    "environment": _env,
                    "typeHash": type_hash,
                    "argsType": args_type,
                    "returnType": return_type,
                }

                if param_names:
                    payload["paramNames"] = param_names

                if sample_input:
                    try:
                        json_test = json.dumps(sample_input)  # noqa: F841
                        payload["sampleInput"] = sample_input
                    except (TypeError, ValueError):
                        pass
                try:
                    json_test = json.dumps(arg)  # noqa: F841
                    payload["sampleOutput"] = arg
                except (TypeError, ValueError):
                    pass

                enqueue(payload)

                if _debug:
                    print(f"[trickle.auto] Observed entry file function: {func_name}")

            elif event == "exception":
                # Clean up pending call on exception
                _pending_calls.pop(id(frame), None)  # type: ignore[arg-type]

        except Exception:
            # Never crash user's app
            pass

    sys.setprofile(_entry_profile)

    if _debug:
        print(f"[trickle.auto] Entry file profiler installed for: {_entry_file}")


# Final generation on exit
def _exit_handler() -> None:
    # Remove profile hook first (no more observations needed)
    try:
        if _entry_file or _ipython_mode:
            sys.setprofile(None)
    except Exception:
        pass

    _stop_event.set()
    # In IPython mode, don't print "written to .pyi" on kernel shutdown
    # since types were already shown after each cell
    if not _ipython_mode:
        _run_generation(True)
    else:
        # Just do a quiet final generation
        try:
            generate_types()
        except Exception:
            pass


atexit.register(_exit_handler)


# ── IPython / Jupyter integration ──
#
# When running inside IPython or a Jupyter notebook, atexit may not fire
# for hours (until the kernel dies). Instead, register a post_run_cell
# event that triggers type generation after each cell execution. This
# gives developers immediate type feedback as they work interactively.
#
# Functions defined in cells live in __main__ and are observed by
# sys.setprofile. Functions in imported modules are observed by the
# import hook. Both work normally — the only difference is *when*
# types are generated and displayed.

_ipython_hooked = False


def _is_ipython() -> bool:
    """Check if we're running inside IPython/Jupyter."""
    try:
        ip = get_ipython()  # type: ignore[name-defined]  # noqa: F821
        return ip is not None
    except NameError:
        return False


def _post_run_cell(result: object = None) -> None:
    """IPython post_run_cell event handler — generate types after each cell."""
    global _last_function_count

    try:
        count = generate_types()
        if count == -1:
            return  # no change since last generation

        if count > 0 and count != _last_function_count:
            # Build a compact summary of what's new
            new_count = count - _last_function_count if _last_function_count > 0 else count
            _last_function_count = count

            # Always show summary in interactive mode (most useful feedback)
            from trickle._auto_codegen import generate_type_summary as _gen_summary
            try:
                # Temporarily enable summary for the call
                old_val = os.environ.get("TRICKLE_SUMMARY")
                os.environ["TRICKLE_SUMMARY"] = "1"
                summary = _gen_summary()
                if old_val is None:
                    del os.environ["TRICKLE_SUMMARY"]
                else:
                    os.environ["TRICKLE_SUMMARY"] = old_val

                if summary:
                    print(summary)
                else:
                    print(f"[trickle.auto] {count} function type(s) observed")
            except Exception:
                print(f"[trickle.auto] {count} function type(s) observed (+{new_count} new)")

    except Exception:
        pass


def _setup_ipython() -> None:
    """Register IPython cell execution hooks if running interactively."""
    global _ipython_hooked
    if _ipython_hooked:
        return
    _ipython_hooked = True

    try:
        ip = get_ipython()  # type: ignore[name-defined]  # noqa: F821
        if ip is None:
            return

        # Register the post-cell hook
        ip.events.register("post_run_cell", _post_run_cell)

        # Detect notebook vs terminal
        cls_name = type(ip).__name__
        if cls_name == "ZMQInteractiveShell":
            env_label = "Jupyter notebook"
        elif cls_name == "TerminalInteractiveShell":
            env_label = "IPython"
        else:
            env_label = "IPython"

        print(f"[trickle.auto] Active in {env_label} — types update after each cell")

        if _debug:
            print(f"[trickle.auto] IPython shell class: {cls_name}")

    except Exception:
        pass


if _is_ipython():
    _setup_ipython()
