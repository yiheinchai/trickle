"""Run any Python script with trickle.auto instrumentation — zero code changes.

Usage:
    python -m trickle.auto_run script.py [args...]

This pre-imports trickle.auto (which installs all hooks) then executes
the target script via runpy.run_path.  The entry file's functions are
observed via sys.setprofile, and imported modules via the import hook.

No source modification required.  Works on any Python script.
"""

from __future__ import annotations

import os
import runpy
import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m trickle.auto_run <script.py> [args...]")
        print()
        print("Runs your script with automatic type observation.")
        print("Generated .pyi stubs appear next to your source files.")
        sys.exit(1)

    target = sys.argv[1]

    if not os.path.isfile(target):
        print(f"Error: {target} not found")
        sys.exit(1)

    # Fix up sys.argv so the target script sees itself as argv[0]
    sys.argv = sys.argv[1:]

    # Import trickle.auto — this installs all hooks (import hook +
    # sys.setprofile for the entry file) and starts the background
    # codegen thread.  Must happen AFTER sys.argv is fixed so that
    # trickle.auto detects the correct entry file.
    import trickle.auto  # noqa: F401

    # Now run the target script
    runpy.run_path(target, run_name="__main__")


if __name__ == "__main__":
    main()
