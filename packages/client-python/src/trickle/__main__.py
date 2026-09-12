"""Run a Python script with Trickle runtime type tracing.

Usage:
    python -m trickle app.py           # Run a script
    python -m trickle mypackage        # Run a package/module

Captures variable types, tensor shapes, and crash-time values into
``.trickle/variables.jsonl`` for VSCode inline hints and ``trickle hints``.
"""

from __future__ import annotations

from .observe_runner import main


if __name__ == "__main__":
    main()
