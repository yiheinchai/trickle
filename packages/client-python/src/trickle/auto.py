"""trickle.auto — Zero-config type generation for Python.

Add ONE LINE to your app and .pyi type stubs appear automatically::

    import trickle.auto

This module:
1. Forces local mode (no backend needed)
2. Installs the import hook to wrap all user functions in imported modules
3. Installs a sys.setprofile hook to observe functions in the entry file
4. Runs a background thread that generates .pyi files from observations
5. On process exit, does a final type generation

No CLI. No backend. No configuration. Just types.
Works for ALL functions — including those defined in the entry file itself.
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
from trickle._auto_codegen import generate_types, inject_python_types  # noqa: E402

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

# Determine the entry file path
if hasattr(sys, "argv") and sys.argv:
    _candidate = os.path.abspath(sys.argv[0])
    if os.path.isfile(_candidate):
        _entry_file = _candidate

if _entry_file:
    from trickle.type_inference import infer_type  # noqa: E402
    from trickle.type_hash import hash_type  # noqa: E402
    from trickle.transport import enqueue  # noqa: E402
    from trickle.env_detect import detect_environment  # noqa: E402

    _env = detect_environment()
    _entry_module = os.path.basename(_entry_file).rsplit(".", 1)[0]
    _pending_calls: dict = {}  # id(frame) -> (name, args_type, sample_input)
    _old_profile = sys.getprofile()

    def _entry_profile(frame: object, event: str, arg: object) -> None:
        """Profile hook that observes function calls in the entry file."""
        # Chain to previous profiler if any
        if _old_profile is not None:
            _old_profile(frame, event, arg)

        try:
            # Fast path: skip non-entry-file frames
            if frame.f_code.co_filename != _entry_file:  # type: ignore[union-attr]
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
        if _entry_file:
            sys.setprofile(None)
    except Exception:
        pass

    _stop_event.set()
    _run_generation(True)


atexit.register(_exit_handler)
