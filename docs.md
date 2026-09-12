# Trickle Documentation

Runtime type capture: instrumented code writes `.trickle/variables.jsonl`, which VSCode and the CLI read. There is no backend.

---

## Overview

Trickle watches your code as it runs, captures the actual types of every variable, then surfaces that information in your editor and CLI. No type annotations required.

The primary workflow:

1. Run with `trickle run <command>` or `%load_ext trickle` in Jupyter
2. Trickle instruments your code via AST transformation, capturing types, tensor shapes, and sample values
3. Observations are written to `.trickle/variables.jsonl` (errors to `.trickle/errors.jsonl`)
4. The VSCode extension reads the JSONL and renders inline type hints, hover tooltips, and error diagnostics
5. The CLI provides `trickle hints` (annotated source for AI agents) and `trickle vars` (table of captured data)

### Packages

| Package | Path | Description |
|---------|------|-------------|
| `trickle` (JS client) | `packages/client-js` | JS/TS instrumentation (`node -r trickle/observe`) |
| `trickle` (Python client) | `packages/client-python` | Python instrumentation (`observe_runner`, notebook transformer) |
| `trickle-cli` | `packages/cli` | CLI (`trickle run`, `hints`, `vars`, `init`) |
| `trickle-vscode` | `packages/vscode-extension` | VSCode inline hints from `variables.jsonl` |

**Removed:** `trickle-backend` / `packages/backend` (Express + SQLite on port 4888). Local JSONL is the only store.

---

## Architecture

```
  Your Code
     |
     v
  trickle run          or     %load_ext trickle
  (AST transform + import hooks / IPython cell transformer)
     |
     |         writes
     v
  .trickle/variables.jsonl   <──  VSCode Extension (inline hints, hover, error mode)
  .trickle/errors.jsonl      <──  VSCode Extension (crash diagnostics)
     |
     v
  CLI: trickle hints, trickle vars
```

No HTTP ingest. No SQLite. Clients append newline-delimited JSON; the extension and CLI parse those files.

### Data Flow

- **Python**: `observe_runner.py` installs a `builtins.__import__` hook that transforms user modules. `_entry_transform.py` instruments the entry file (executed via `runpy`, so it never goes through `__import__`). Variable assignments get `_trickle_tv()` calls inserted after them.
- **JavaScript**: `observe-register.ts` patches `Module._compile` to insert `__trickle_tv()` after variable declarations.
- **Notebooks**: `%load_ext trickle` registers an IPython cell transformer that injects tracing calls into each cell before execution.
- **Local storage**: Observations go to `.trickle/variables.jsonl`. Errors go to `.trickle/errors.jsonl`. The VSCode extension watches these files with a debounced `FileSystemWatcher`.

---

## CLI Commands

The CLI is registered as `trickle` (package `trickle-cli`).

### `trickle run [command...]`

Run any command or file with variable tracing. Zero code changes needed.

```bash
trickle run python train.py
trickle run node server.js
trickle run pytest
```

**Options:**
- `--include <patterns>` -- Only observe matching modules
- `--exclude <patterns>` -- Skip matching modules
- `-w, --watch` -- Watch source files and re-run on changes

**Implementation** (`packages/cli/src/commands/run.ts`):
- Auto-detects language (Python vs Node) from the command or file extension
- For Python: spawns `python -c "from trickle.observe_runner import main; main()" <script>`
- For Node: spawns `node -r trickle/observe <script>`

### `trickle hints [file]`

Output source code with inline type hints from runtime observations. Designed for AI agents.

```bash
trickle hints src/model.py
trickle hints --errors
trickle hints --errors --show types|values|both
```

**Implementation** (`packages/cli/src/commands/hints.ts`):
- Reads `.trickle/variables.jsonl`
- Inserts type annotations inline after variable names
- In error mode, reads `error_snapshot` records and underlines the crash line
- Supports notebook cell paths (`__notebook__cell_N.py`)

### `trickle vars`

Table of captured variable types and sample values.

```bash
trickle vars
trickle vars --tensors
trickle vars --file model.py
```

### `trickle init`

Set up trickle in a project (`trickle init`, `trickle init --python`).

---

## Python Client

**Package**: `trickle` (`packages/client-python`)

Public surface:
- `load_ipython_extension` / `unload_ipython_extension` -- `%load_ext trickle`
- `observe_runner.main` -- used by `trickle run` / `python -m trickle`
- `notebook.py` -- cell transformer writing `variables.jsonl`
- `type_inference.py` -- runtime value → TypeNode
- `_entry_transform.py` -- AST rewrite of the entry script
- `_trace_import_hook.py` -- transform imported user modules
- `_error_context.py` -- crash-time snapshots

### `type_inference.py`

Infers a `TypeNode` dictionary from any Python runtime value: primitives, lists, tuples, dicts, sets, dataclasses, PyTorch `Tensor` (shape, dtype, device), NumPy `ndarray`, Pandas `DataFrame`/`Series`.

### `notebook.py`

```python
%load_ext trickle
```

Registers an IPython AST transformer. After every assignment, injects `_trickle_tv()` and writes to `.trickle/variables.jsonl`.

### `_entry_transform.py`

When `trickle run script.py` is used, parses the entry file, inserts variable trace calls after assignments, compiles and executes the transformed AST. Installs a traceback rewriter that maps temp file line numbers back to original source.

### `observe_runner.py`

Clears previous `.trickle/variables.jsonl` and `.trickle/errors.jsonl`, installs the import hook, runs the target via `_entry_transform`, catches exceptions and writes error context.

---

## JS Client

**Package**: `trickle` (`packages/client-js`)

Core capture path: `node -r trickle/observe` (used by `trickle run`).

- `observe-register.ts` -- patches `Module._compile`, inserts `__trickle_tv()` after declarations
- `trace-var.ts` -- infers TypeNode, appends to `.trickle/variables.jsonl`
- `type-inference.ts` -- JS runtime value → TypeNode

---

## VSCode Extension

**Package**: `trickle-vscode` (`packages/vscode-extension`)

Activates when `.trickle/variables.jsonl` exists or a Jupyter notebook is opened. Reads JSONL and renders:

- **Inlay hints** after variable assignments (types, or crash-time values in error mode)
- **Hover** with full type, shape, sample value
- **Autocomplete** for known runtime types (Tensor, ndarray, DataFrame, …)
- **Semantic highlighting** for properties vs methods

Watches `**/.trickle/variables.jsonl` and `**/.trickle/errors.jsonl` (debounced reload).

---

## Backend (removed)

`packages/backend` / `trickle-backend` no longer exists. There is no ingest server, SQLite database, dashboard, or `/api/*` routes. Capture is local JSONL only.

Historical implementation lives in `archive/` and `snapshot/pre-subtraction-2026-03-17`.

---

## Local File Format

Stored in `.trickle/` at the project root:

| File | Format | Description |
|------|--------|-------------|
| `variables.jsonl` | Newline-delimited JSON | Variable observations and error snapshots |
| `errors.jsonl` | Newline-delimited JSON | Runtime errors with stack traces |

### `variables.jsonl` record kinds (core)

| Kind | Source | Description |
|------|--------|-------------|
| `variable` | trace-var / notebook | Variable assignment observation |
| `error_snapshot` | error context | Variable values captured at crash time |
