# trickle

See the runtime types of every variable in your code — without adding print statements.

```bash
pip install trickle-observe
npm install -g trickle-cli
```

## How it works

Run your code through trickle. It captures the type, shape, and value of every variable at every assignment. Then view the results — inline in VSCode, or in the terminal via `trickle hints`.

### Scripts

```bash
trickle run python train.py
trickle hints                    # see types inline in source
trickle hints --errors           # see crash-time values with error underline
```

### Jupyter Notebooks

```python
%load_ext trickle
```

That's it. Every cell you run after this is traced. Types appear inline in VSCode.

## What you see

### In VSCode

After running your code, every variable gets an inline type hint:

```python
x = torch.randn(4, 8)          # x: Tensor[4, 8] float32
w = torch.randn(16, 8)         # w: Tensor[16, 8] float32
h = x @ w.T                    # h: Tensor[4, 16] float32
```

Works for assignments, for-loops, function parameters, with-as, tuple unpacking.

Hover for full details. When code crashes, error mode shows crash-time values on each variable's assignment line.

Typing `t.` when trickle knows `t` is a Tensor gives autocomplete for `shape`, `dtype`, `view`, `reshape`, etc. Properties are highlighted blue, methods yellow.

### In the terminal (for AI agents)

```bash
trickle hints train.py
```

```python
x: Tensor(shape=[4, 8], dtype=torch.float32) = torch.randn(4, 8)
w: Tensor(shape=[16, 8], dtype=torch.float32) = torch.randn(16, 8)
h: Tensor(shape=[4, 16], dtype=torch.float32) = x @ w.T
```

```bash
trickle hints --errors
```

```
# train.py — ERROR
# ValueError: could not convert string to float: 'ID' (line 20)
# Variables at crash time:
file_path: string = "demographics.txt"
patient_gait_data: string[] = ["ID\tStudy\tGroup\t..."]
    [float(d) for d in time.split("\t")] for time in patient_gait_data
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~  <- ValueError: could not convert string to float: 'ID'
```

Options:
- `--show types` — only type annotations
- `--show values` — only runtime values
- `--show both` — types and values (default in error mode)

### In the terminal (table view)

```bash
trickle vars                     # all variables
trickle vars --tensors           # only tensors
trickle vars --file model.py     # filter by file
```

## Install

```bash
# Python
pip install trickle-observe

# CLI (for trickle run, trickle hints, trickle vars)
npm install -g trickle-cli

# VSCode extension
# Search "trickle" in Extensions (Cmd+Shift+X), publisher yiheinchai
```

## Supported

- Python scripts, Jupyter notebooks, pytest
- PyTorch tensors (shape, dtype, device, memory, gradient norms)
- NumPy arrays, Pandas DataFrames/Series
- Any Python object (type name, properties)
- JavaScript/TypeScript (Express, Fastify, Koa, Hono)

## How it works under the hood

Trickle uses AST transformation. It rewrites your source at import time to insert lightweight tracing calls after every variable assignment. These calls capture the type and a sample value, then write to `.trickle/variables.jsonl`.

- Entry file: transformed before execution
- Imported modules: transformed at import time via `sys.meta_path` hook
- Skipped: stdlib, site-packages, torch/numpy internals (only your code is traced)
- Deduplication: same value at the same line is recorded once

The VSCode extension watches `variables.jsonl` and updates inline hints automatically.

## Clear data

```bash
# CLI
rm .trickle/variables.jsonl

# VSCode
Cmd+Shift+P -> "Trickle: Clear Variables"
```
