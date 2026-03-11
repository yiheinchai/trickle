"""Run a Python application with universal auto-observation.

Unlike ``python -m trickle`` which only patches Flask/FastAPI, this
wraps ALL exported functions in user modules automatically.

Usage:
    python -c "from trickle.observe_runner import main; main()" script.py

This is invoked by ``trickle run`` for Python commands.
"""

from __future__ import annotations

import runpy
import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m trickle.observe_runner <script.py | module>")
        print()
        print("Runs your application with universal function observation.")
        print("All exported functions in user modules are auto-wrapped.")
        sys.exit(1)

    # Install observe hooks BEFORE loading user code
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

    if target.endswith(".py"):
        # Use AST transformation to observe entry file functions
        try:
            from trickle._entry_transform import run_entry_with_observation
            run_entry_with_observation(target)
        except Exception as exc:
            if _debug:
                import traceback
                print(f"[trickle] Entry transform failed, falling back to runpy: {exc}")
                traceback.print_exc()
            runpy.run_path(target, run_name="__main__")
    else:
        runpy.run_module(target, run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
