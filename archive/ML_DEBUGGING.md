# Trickle for ML Engineers

Stop adding `print(x.shape)` everywhere. Trickle automatically captures tensor shapes, dtypes, and devices at every variable assignment — then shows them inline in VSCode when you hover.

## Quick Start

```bash
# 1. Install
pip install trickle-observe
npm install -g trickle-cli

# 2. Install the VSCode extension
# Search "trickle" in VSCode Extensions (Cmd+Shift+X)
# or install from marketplace: publisher yiheinchai, extension trickle-vscode

# 3. Run your script
trickle run train.py
```

That's it. Open your script in VSCode — tensor shapes appear inline next to every variable.

## What You Get

### Inline tensor shapes in VSCode

After running your script, every variable gets an inline type hint:

```python
x = torch.randn(4, 8)          # → Tensor[4, 8] float32
w = torch.randn(16, 8)         # → Tensor[16, 8] float32
h = x @ w.T                    # → Tensor[4, 16] float32
```

This works for:
- Simple assignments (`x = ...`)
- Tuple unpacking (`B, T, C = x.size()`)
- For-loop variables (`for i, (x, y) in enumerate(loader)`)
- Function parameters (`def forward(self, x, targets=None)`)
- Variables inside imported modules (your model code, not torch internals)

### Hover for full details

Hover over any variable to see its runtime type, shape, dtype, device, and a sample value.

### Automatic error context

When your code crashes with a shape mismatch, trickle prints the tensor shapes near the crash site:

```
────────────────────────────────────────────────────────
  trickle: tensor shapes near the error
────────────────────────────────────────────────────────
  train.py
    line   31  batch                Tensor[4, 8] float32
    line   32  w                    Tensor[16, 32] float32
    line   32  b                    Tensor[16] float32
    line   27  x                    Tensor[4, 8] float32 ◄ error
    line   27  weight               Tensor[16, 32] float32
────────────────────────────────────────────────────────
```

No more guessing which tensor had the wrong shape.

### CLI inspection

```bash
# Show all captured variables
trickle vars

# Show only tensors
trickle vars --tensors

# Filter by file
trickle vars --file model.py
```

## Usage

### Training scripts

```bash
trickle run train.py
```

### Jupyter Notebooks

#### Setup

You only need the Python package — no CLI or backend required:

```bash
pip install trickle-observe
```

Then install the VSCode extension for inline hints (search "trickle" in Extensions, publisher `yiheinchai`).

#### Activation

Add this as your **first cell** and run it before anything else:

```python
%load_ext trickle
```

You should see:
```
[trickle] Variable tracing active. Data → .trickle/variables.jsonl
```

Every cell you run after this is automatically traced. Nothing else to configure.

Alternative ways to activate:
```python
import trickle.notebook; trickle.notebook.activate()  # programmatic
import trickle.auto                                    # auto-detects Jupyter
```

#### What gets traced

Every variable assignment in every cell after activation:

```python
# Cell 1
%load_ext trickle

# Cell 2 — imports and model setup
import torch
import torch.nn as nn

model = nn.Linear(784, 10)     # traced: Linear(in_features=784, out_features=10, ...)
x = torch.randn(32, 784)      # traced: Tensor[32, 784] float32
output = model(x)              # traced: Tensor[32, 10] float32
loss = nn.functional.cross_entropy(output, torch.randint(0, 10, (32,)))
                               # traced: Tensor[] float32 (scalar loss)

# Cell 3 — training loop variables are also traced
for epoch in range(5):
    for batch_idx, (data, target) in enumerate(loader):
        # data:   Tensor[32, 784] float32
        # target: Tensor[32] int64
        out = model(data)      # Tensor[32, 10] float32
        loss = criterion(out, target)  # Tensor[] float32
```

Traced variable types:
- **Simple assignments**: `x = torch.randn(4, 8)` → `Tensor[4, 8] float32`
- **Tuple unpacking**: `B, T, C = x.size()` → each gets its own trace
- **For-loop variables**: `for epoch in range(5)` / `for i, (data, target) in enumerate(loader)`
- **Function parameters**: `def forward(self, x, targets=None)` — parameters traced on each call
- **Imported module variables**: if you `import model` from a local `.py` file, variables inside that module are traced too (torch/numpy internals are skipped)

#### Viewing results

**In VSCode** — open the notebook, hover over any variable to see its type/shape. Inline type hints appear after variable assignments automatically.

**In the terminal** — while the notebook kernel is running or after:

```bash
# See all traced tensor variables
trickle vars --tensors

# See all variables from a specific cell
trickle vars --file cell_2

# Full table of everything
trickle vars
```

Example output:
```
  __notebook__cell_2.py

┌────────┬────────────────────┬───────────────────────────────────┬──────────────────────────┐
│ Line   │ Variable           │ Type                              │ Sample Value             │
├────────┼────────────────────┼───────────────────────────────────┼──────────────────────────┤
│ 14     │ x                  │ Tensor[32, 784] float32           │ "Tensor(shape=[32, 784]  │
│ 19     │ output             │ Tensor[32, 10] float32            │ "Tensor(shape=[32, 10]   │
│ 20     │ loss               │ Tensor[] float32                  │ "Tensor(shape=[]         │
│ 29     │ data               │ Tensor[32, 784] float32           │ "Tensor(shape=[32, 784]  │
│ 30     │ target             │ Tensor[32] int64                  │ "Tensor(shape=[32]       │
└────────┴────────────────────┴───────────────────────────────────┴──────────────────────────┘
```

#### Managing traced data

```python
import trickle.notebook

# Clear all traced data (useful when re-running experiments)
trickle.notebook.clear()

# Deactivate tracing (stop tracing new cells)
trickle.notebook.deactivate()

# Or via magic commands
%unload_ext trickle      # stop tracing
%load_ext trickle        # re-activate
```

The traced data lives in `.trickle/variables.jsonl` in your working directory. It's deduplicated — running the same cell multiple times won't create duplicate entries (same variable + same shape + same line = recorded once).

#### How it works under the hood

When you run `%load_ext trickle`:

1. An **AST transformer** is registered with IPython. Before each cell is compiled, trickle rewrites the AST to insert `_trickle_tv()` calls after every variable assignment.
2. An **import hook** is installed on `sys.meta_path`. When you `import` a local module (e.g., your model file), that module's source is also transformed so its variables are traced.
3. Each cell execution increments a counter (`cell_1`, `cell_2`, ...). Variables are tagged with their cell index and line number.
4. Results are written to `.trickle/variables.jsonl`. The VSCode extension watches this file and updates inline hints automatically.

Only your code is traced — stdlib, site-packages, and libraries like torch/numpy/pandas are skipped.

#### Notebook-specific tips

- **Run `%load_ext trickle` first**: It must come before any code cells. If you load it mid-notebook, only cells executed *after* loading are traced.
- **Restart kernel to re-count cells**: Cell indices are based on execution order. If hints appear on the wrong cell in VSCode, restart the kernel and run cells top-to-bottom.
- **Works in VSCode notebook editor**: Hover and inline hints work in `.ipynb` files opened in VSCode. The extension matches cells by code cell index (markdown cells are skipped).
- **Works with Jupyter Lab / Notebook too**: The tracing itself works in any Jupyter environment. VSCode inline hints are only available when editing the notebook in VSCode.
- **Clear between experiments**: Run `trickle.notebook.clear()` or `!rm .trickle/variables.jsonl` before starting a new experiment to avoid stale data from previous runs.

### pytest / unittest

```bash
trickle run pytest tests/
trickle run "python -m unittest test_model"
```

### Without the CLI

If you don't want to install the CLI:

```bash
TRICKLE_LOCAL=1 python -m trickle train.py
```

## How It Works

Trickle uses AST transformation — it rewrites your Python source at import time to insert lightweight tracing calls after every variable assignment. These calls capture the type, shape, dtype, and device of each value and write them to `.trickle/variables.jsonl`.

- **Entry file**: Transformed before execution via `_entry_transform.py`
- **Imported modules**: Transformed at import time via a `sys.meta_path` hook
- **Skipped**: stdlib, site-packages, torch/numpy/pandas internals (only your code is traced)
- **Deduplication**: Same shape at the same line is only recorded once (loops don't explode the file)

The VSCode extension reads `.trickle/variables.jsonl` and displays the data as inline hints and hover tooltips. It watches the file for changes, so running your script again updates the display automatically.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TRICKLE_LOCAL` | `0` | Set to `1` for offline mode (no backend needed) |
| `TRICKLE_TRACE_VARS` | `1` | Set to `0` to disable variable tracing |
| `TRICKLE_OBSERVE_INCLUDE` | (all user code) | Comma-separated module patterns to trace |
| `TRICKLE_OBSERVE_EXCLUDE` | (none) | Comma-separated module patterns to skip |
| `TRICKLE_DEBUG` | `0` | Set to `1` for verbose debug output |

## Error Mode

When your code crashes, trickle switches to error mode. Instead of stacking all variable info on the error line, it shows crash-time variable values inline on each variable's **assignment line** — so you can see exactly what each variable held when things went wrong.

```python
x = torch.randn(4, 8)          # → Tensor[4, 8] float32
w = torch.randn(16, 32)        # → Tensor[16, 32] float32    ← wrong shape
b = torch.zeros(16)            # → Tensor[16] float32
out = x @ w.T + b              # RuntimeError: mat1 and mat2 shapes cannot be multiplied (4x8 and 32x16)
```

Each variable's last-known value before the crash appears on the line where it was assigned, making shape mismatches immediately visible without scrolling or hovering.

To clear error mode annotations and return to normal display, run **Cmd+Shift+P** and select `Trickle: Clear Variables`.

## Error Mode for AI Agents (CLI)

The `trickle hints --errors` command outputs your source code with inline type annotations showing crash-time values, formatted for AI agents and LLMs. The error line is underlined with `~~~` for easy identification.

```bash
trickle hints --errors
```

Example output:

```
train.py

x = torch.randn(4, 8)                          # x: Tensor[4, 8] float32
w = torch.randn(16, 32)                         # w: Tensor[16, 32] float32
b = torch.zeros(16)                             # b: Tensor[16] float32
out = x @ w.T + b                               # RuntimeError: mat1 and mat2 shapes cannot be multiplied (4x8 and 32x16)
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
```

You can control what information is shown with the `--show` flag:

- `--show types` — show only type annotations (e.g., `Tensor[4, 8] float32`)
- `--show values` — show only runtime values (e.g., `tensor([[0.3, -1.2, ...]])`)
- `--show both` — show types and values together

## Runtime-aware Autocomplete

When trickle knows a variable's runtime type, VSCode provides context-aware autocomplete based on observed types. For example, if trickle has seen that `t` is a `torch.Tensor`, typing `t.` offers completions for `shape`, `dtype`, `view`, `reshape`, `permute`, `unsqueeze`, and other tensor methods — without needing type stubs or static analysis.

Trickle also applies semantic highlighting to distinguish properties from methods:

- **Properties** are highlighted in blue (e.g., `t.shape`, `t.dtype`, `t.device`)
- **Methods** are highlighted in yellow (e.g., `t.view()`, `t.reshape()`, `t.permute()`)

This works for any type trickle has observed at runtime, not just tensors.

## trickle hints

The `trickle hints` command outputs source code with inline type annotations, designed for AI agents and CLI workflows where VSCode is not available.

```bash
# Show types for a specific file
trickle hints train.py

# Show runtime values alongside types
trickle hints --values

# Show error-mode output (crash-time variable values with error underline)
trickle hints --errors
```

Example output for `trickle hints train.py`:

```
train.py

x = torch.randn(4, 8)                          # x: Tensor[4, 8] float32
w = torch.randn(16, 8)                          # w: Tensor[16, 8] float32
h = x @ w.T                                     # h: Tensor[4, 16] float32
loss = criterion(h, targets)                     # loss: Tensor[] float32
```

This gives AI coding agents full visibility into runtime types without needing editor integration.

## Troubleshooting

### No inline hints in VSCode

1. Check the status bar — you should see "Trickle: N vars". If not, the extension isn't finding `.trickle/variables.jsonl`.
2. Make sure the workspace folder in VSCode matches where you ran `trickle run` (the `.trickle/` directory must be in the workspace root).
3. Try Cmd+Shift+P → "Trickle: Refresh Variable Data".

### No inline hints in Jupyter notebooks

1. Make sure the VSCode extension is up to date — older versions don't support notebook cells.
2. Run `%load_ext trickle` before your code cells.
3. The extension matches notebook cells by index — if hints appear on the wrong cell, try restarting the kernel and running cells in order.

### Shapes not updating

Run your script again — trickle overwrites `.trickle/variables.jsonl` on each run. The VSCode extension watches this file and refreshes automatically.

### Too many variables traced

Use `TRICKLE_OBSERVE_EXCLUDE` to skip noisy modules:

```bash
TRICKLE_OBSERVE_EXCLUDE=data_utils,logging trickle run train.py
```

## Tested On

- Karpathy's [nanoGPT](https://github.com/karpathy/nanoGPT) — GPT-2 implementation (68 vars, 38 tensors in model.py)
- Karpathy's [makemore](https://github.com/karpathy/makemore) — Transformer character-level model (76 vars, 41 tensors)
