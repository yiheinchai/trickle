# Features

The retained features — everything trickle does and nothing more.

## Core: Runtime Type Capture

| Feature | Interface | What it does |
|---------|-----------|-------------|
| `trickle run` | CLI | Run any script/command with automatic variable tracing |
| `trickle hints` | CLI | Output source code with inline type annotations |
| `trickle hints --errors` | CLI | Show crash-time variable values with error underline |
| `trickle hints --show` | CLI | Control display: `types`, `values`, or `both` |
| `trickle vars` | CLI | Table of captured variable types and sample values |
| `trickle init` | CLI | Set up trickle in a project |
| Inline type hints | VSCode | Types appear after variable assignments |
| Error mode | VSCode | Crash-time values on each variable's assignment line |
| Runtime autocomplete | VSCode | `t.` gives Tensor/DataFrame/ndarray completions |
| Semantic highlighting | VSCode | Properties blue, methods yellow for known types |
| Hover tooltips | VSCode | Full type, shape, sample value on hover |
| `%load_ext trickle` | Jupyter | Activate tracing in notebook cells |

## Type Inference Engine

- Python: `type_inference.py` — infers types from runtime values (primitives, tensors, arrays, dicts, objects, unions)
- JavaScript: `type-inference.ts` — same for JS values
- Handles: PyTorch tensors (shape, dtype, device, memory, stats), NumPy arrays, Pandas DataFrames/Series, nested objects, union types

## AST Transformation

- `_entry_transform.py` — rewrites entry script to inject `__trickle_tv()` calls after every assignment
- `notebook.py` — IPython AST transformer for Jupyter cells
- `_trace_import_hook.py` — transforms imported user modules at import time
- `observe_runner.py` — orchestrates `trickle run` for Python scripts
- JS: `register.ts`, `observe-register.ts` — equivalent for Node.js

## Error Snapshots

- Captures ALL variables from ALL user-code frames at crash time
- Handles list comprehension scopes (inner variables like `d` + outer variables like `file_path`)
- Maps temp file line numbers back to original source
- Fast serialization (tensor-aware, avoids `str()` on large objects)
- Works in both notebooks and scripts

## ML/PyTorch Hooks

| Hook | What it captures |
|------|-----------------|
| `_backward_hook.py` | Gradient norms per parameter |
| `_activation_hook.py` | Activation statistics per layer |
| `_attention_hook.py` | Attention pattern capture |
| `_checkpoint_hook.py` | Checkpoint save/load events |
| `_dataloader_hook.py` | DataLoader batch tensor shapes |
| `_optimizer_hook.py` | Optimizer state (lr, momentum, weight decay) |
| `_lr_scheduler_hook.py` | Learning rate schedule tracking |
| `_loss_probe_hook.py` | Loss landscape probing |

## Framework Auto-Instrumentation

Python: FastAPI, Flask, Django (middleware-based route capture)
JavaScript: Express, Fastify, Koa, Hono, Lambda (monkey-patch / middleware)

## Archived Features

Everything else (90+ CLI commands, cloud sync, dashboards, security scanning, RBAC, compliance, agent eval, etc.) is preserved in the `snapshot/pre-subtraction-2026-03-17` branch and the `archive/` directory. These can be restored if a real user need emerges.
