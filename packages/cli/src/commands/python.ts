/**
 * trickle python — Python observability commands.
 *
 * Subcommands:
 *   trickle python setup   — Print setup instructions for Python type hint generation
 */

import { Command } from 'commander';

export function pythonCommand(program: Command): void {
  const py = program
    .command('python')
    .description('Python observability — instant inline type hints for any Python code');

  // trickle python setup
  py
    .command('setup')
    .description('Print setup instructions for getting inline type hints from any Python script')
    .option('--venv', 'Show virtual environment setup instructions')
    .action((opts) => {
      console.log(`
╔════════════════════════════════════════════════════════════════╗
║         trickle Python Setup                                   ║
╚════════════════════════════════════════════════════════════════╝

Step 1 — Install trickle:
─────────────────────────
  pip install trickle-observe

Step 2 — Choose your approach:
───────────────────────────────

  ┌─ Approach A: One import (simplest) ─────────────────────────┐
  │                                                               │
  │  Add ONE line to the top of any Python file:                 │
  │                                                               │
  │    import trickle.auto                                        │
  │                                                               │
  │  Then run it normally:                                        │
  │    python app.py                                              │
  │                                                               │
  │  When it exits, .pyi stubs appear next to your source files.  │
  │  Open the file in VSCode — inline hints appear automatically. │
  └───────────────────────────────────────────────────────────────┘

  ┌─ Approach B: Zero code changes (CLI wrapper) ────────────────┐
  │                                                               │
  │    trickle run python app.py                                  │
  │                                                               │
  │  No code changes needed. Trickle wraps the Python process.   │
  │  All functions in your modules are observed automatically.    │
  └───────────────────────────────────────────────────────────────┘

  ┌─ Approach C: Module runner ──────────────────────────────────┐
  │                                                               │
  │    TRICKLE_LOCAL=1 python -m trickle app.py                  │
  │                                                               │
  │  Useful when you can't install the CLI globally.             │
  └───────────────────────────────────────────────────────────────┘

Step 3 — Open in VSCode and see hints:
───────────────────────────────────────
  After running your script, open it in VSCode with the trickle
  extension installed. Inline type hints appear on every function
  and variable that was observed:

    def process_users(users, limit=10):    # → (list[dict], int) → list[dict]
        result = filter_active(users)      # → list[dict]
        scores = [score(u) for u in result]  # → list[float]
        return scores[:limit]

  Hover over any hint for full type details, sample values, and
  call frequency.

What gets tracked automatically:
──────────────────────────────────
  ✓ All function argument and return types
  ✓ Variable assignments (local variables inferred at runtime)
  ✓ Class methods and properties
  ✓ Async functions and await results
  ✓ Generator functions and yield types
  ✓ Nested functions and closures
  ✓ Decorators (the underlying function is still observed)
  ✓ Common ML types: numpy arrays, torch tensors, pandas DataFrames

What is NOT instrumented:
──────────────────────────
  ✗ Python stdlib (os, sys, json, etc.)
  ✗ Third-party packages (torch, numpy, pandas, etc.)
  ✗ Only your own code is observed

Terminal type output (no VSCode needed):
─────────────────────────────────────────
  TRICKLE_SUMMARY=1 python app.py

  After your script finishes, prints a summary of all observed
  variable types and function signatures directly to the terminal:

    ──────────────────────────────────────────────────────────────
      trickle: 8 variables | 3 functions typed
    ──────────────────────────────────────────────────────────────
      app.py
        L5   user_id        int           = 42
        L6   name           str           = "Alice"
        L9   scores         list[float]
        L12  result         dict[str, int]

      Functions:
        process(data: list[float], n: int) → dict[str, int]
        greet(name: str) → str
    ──────────────────────────────────────────────────────────────

  Works with import trickle.auto too:
    TRICKLE_SUMMARY=1 python -c "import trickle.auto; ..."

Advanced options:
─────────────────
  # Only observe specific modules
  TRICKLE_OBSERVE_INCLUDE=services,models trickle run python app.py

  # Skip noisy modules
  TRICKLE_OBSERVE_EXCLUDE=tests,migrations trickle run python app.py

  # Generate .pyi stubs in a specific directory
  trickle stubs src/

  # Inject annotations directly into source files
  trickle annotate src/services/user.py

Testing with pytest:
─────────────────────
  trickle run python -m pytest tests/

  Running your test suite observes types for every function called
  during tests — great for typing a legacy codebase quickly.

Jupyter / IPython:
───────────────────
  In a notebook cell:
    %load_ext trickle

  Or at the top of your notebook:
    import trickle.auto

  Types update after each cell execution.
${opts.venv ? `
Virtual environment setup:
───────────────────────────
  python -m venv .venv
  source .venv/bin/activate   # Windows: .venv\\Scripts\\activate
  pip install trickle-observe
  trickle run python app.py
` : ''}
`);
    });
}
