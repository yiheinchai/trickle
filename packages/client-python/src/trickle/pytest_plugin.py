"""Pytest plugin for trickle variable tracing.

When trickle-observe is installed, this plugin automatically activates for
all pytest runs. It parses each test file's AST to find assignment lines,
then uses sys.settrace to capture variable values as tests execute.

The results are written to .trickle/variables.jsonl in the project root,
where the VSCode extension picks them up and shows inline type hints.

Opt out by setting TRICKLE_TRACE_VARS=0 in your environment, or by adding
`-p no:trickle` to your pytest invocation or addopts in pytest.ini.
"""

from __future__ import annotations

import os


def pytest_sessionstart(session: object) -> None:
    """Clear the variables file and install import hook at the start of each pytest run."""
    if os.environ.get("TRICKLE_TRACE_VARS", "1") in ("0", "false"):
        return

    local_dir = os.environ.get("TRICKLE_LOCAL_DIR") or os.path.join(os.getcwd(), ".trickle")
    os.makedirs(local_dir, exist_ok=True)
    vars_file = os.path.join(local_dir, "variables.jsonl")
    # Clear so each run starts fresh (VSCode extension will reload)
    try:
        open(vars_file, "w").close()
    except Exception:
        pass

    # Install the import hook so source modules (not just test files)
    # get variable tracing. This lets users see values flowing through
    # functions being tested, not just the test assertions.
    try:
        from trickle._trace_import_hook import install_trace_hook
        install_trace_hook()
    except Exception:
        pass


def pytest_collection_finish(session: object) -> None:
    """After all test items are collected, register their files for tracing."""
    if os.environ.get("TRICKLE_TRACE_VARS", "1") in ("0", "false"):
        return

    # Collect unique test file paths from collected items
    try:
        items = session.items  # type: ignore[attr-defined]
    except AttributeError:
        return

    test_files: list[str] = []
    seen: set[str] = set()
    for item in items:
        try:
            fspath = str(item.fspath)
        except Exception:
            continue
        if fspath and fspath not in seen and os.path.isfile(fspath):
            seen.add(fspath)
            test_files.append(fspath)

    if not test_files:
        return

    try:
        from trickle._auto_var_tracer import install_files
        install_files(test_files)
    except Exception:
        pass

    debug = os.environ.get("TRICKLE_DEBUG", "").lower() in ("1", "true", "yes")
    if debug:
        print(f"\n[trickle] pytest plugin: tracing {len(test_files)} test file(s)")
