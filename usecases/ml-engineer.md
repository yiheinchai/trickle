# ML Engineer: Stop Printing Tensor Shapes

You're training a model and debugging shape mismatches. Instead of scattering `print(x.shape)` everywhere, trickle captures every tensor's shape, dtype, and device automatically — and shows them inline in VSCode.

## Install

```bash
pip install trickle-observe
```

Then install the VSCode extension: search "trickle" in Extensions (Cmd+Shift+X), publisher `yiheinchai`.

## Use Case 1: Jupyter Notebook

This is the most common ML workflow — iterating in a notebook.

**Cell 1:**
```python
%load_ext trickle
```

You'll see: `[trickle] Variable tracing active. Data → .trickle/variables.jsonl`

**Cell 2:**
```python
import torch
import torch.nn as nn

model = nn.Linear(784, 10)
x = torch.randn(32, 784)       # → Tensor[32, 784] float32
output = model(x)               # → Tensor[32, 10] float32
loss = nn.functional.cross_entropy(output, torch.randint(0, 10, (32,)))
                                # → Tensor[] float32 (scalar)
```

Every variable is now traced. In VSCode:
- **Inline hints** appear after each assignment showing the type
- **Hover** over any variable for full details (shape, dtype, device, sample value)

**Cell 3 — training loop:**
```python
for epoch in range(5):
    for batch_idx, (data, target) in enumerate(loader):
        # data:   Tensor[32, 784] float32
        # target: Tensor[32] int64
        out = model(data)
        loss = criterion(out, target)
```

Loop variables (`epoch`, `data`, `target`) are traced too. Same shape at the same line is deduplicated, so loops don't explode the data file.

**Cell 4 — defining model classes directly in notebook:**
```python
class SimpleModel(nn.Module):
    def __init__(self, in_dim, hidden, out_dim):
        super().__init__()
        self.fc1 = nn.Linear(in_dim, hidden)    # → Linear (traced as SimpleModel.__init__.self.fc1)
        self.fc2 = nn.Linear(hidden, out_dim)    # → Linear (traced as SimpleModel.__init__.self.fc2)

    def forward(self, x):
        # x: Tensor[32, 784] float32 (traced as SimpleModel.forward.x)
        h = self.fc1(x)                          # → Tensor[32, 128] float32
        h = torch.relu(h)                        # → Tensor[32, 128] float32
        return self.fc2(h)                       # → returns Tensor[32, 10] float32
```

All variables inside class methods are traced with full context — `funcName` shows which method they belong to (e.g., `SimpleModel.forward`), and `self.x` attribute assignments are captured too. Return values are also traced: `return expr` shows `-> Tensor[...]` on the return line.

**Swapping layers and re-running:**
```python
# Change fc1 to a Conv1d — just re-run the cell
class SimpleModel(nn.Module):
    def __init__(self, in_dim, hidden, out_dim):
        super().__init__()
        self.conv1 = nn.Conv1d(1, hidden, 3)    # → Conv1d
        self.fc2 = nn.Linear(hidden, out_dim)

    def forward(self, x):
        x = x.unsqueeze(1)                      # → Tensor[32, 1, 784] float32
        h = self.conv1(x)                        # → Tensor[32, 128, 782] float32
        h = h.mean(dim=-1)                       # → Tensor[32, 128] float32
        return self.fc2(h)
```

Re-running the cell automatically re-traces all variables with updated shapes. No need to restart the kernel.

**What gets traced:**
- Simple assignments: `x = torch.randn(4, 8)`
- Tuple unpacking: `B, T, C = x.size()`
- For-loop variables: `for i, (x, y) in enumerate(loader)`
- Function parameters: `def forward(self, x, targets=None)`
- Attribute assignments: `self.fc1 = nn.Linear(...)`, `self.encoder = ...`
- Variables inside class methods with full function context (e.g., `GPT.forward`)
- Return values: `return logits` shows `-> Tensor[B, T, vocab_size]` inline
- Gradient context: tensors in `torch.no_grad()` show `[no_grad]` badge
- Model mode: modules in eval mode show `[eval]` (helps catch `.eval()` bugs)
- Optimizers: `Adam(lr=0.001, betas=(0.9, 0.999), ...)` with param count
- LR schedulers: `StepLR(step_size=10, gamma=0.5, ...)` with current lr
- Loss functions: `CrossEntropyLoss(ignore_index=-100, label_smoothing=0.0)`
- DataLoaders: `DataLoader(batch_size=32, dataset_size=8000, batches=250, ...)`
- Datasets: `TensorDataset(size=10000, tensors=2)`, `Subset(size=8000, from=TensorDataset)`
- Memory footprint: hover shows `mem=4.0 MB` per tensor (helps debug OOM)
- Variables inside imported local modules (your model.py, not torch internals)

**Managing the session:**
```python
import trickle.notebook

trickle.notebook.clear()       # wipe traced data, start fresh
trickle.notebook.deactivate()  # stop tracing
%unload_ext trickle            # same as deactivate
%load_ext trickle              # re-activate
```

## Use Case 2: Training Script

```bash
# Install the CLI too
npm install -g trickle-cli

# Run your script
trickle run train.py
```

After the script finishes, trickle prints a summary:

```
  Variables traced: 68
  Tensor variables: 38

    train.py:14  x          Tensor[32, 784] float32
    train.py:15  output     Tensor[32, 10] float32
    train.py:20  loss       Tensor[] float32
    model.py:8   weight     Tensor[784, 128] float32
    model.py:12  hidden     Tensor[32, 128] float32
```

Open the file in VSCode — inline hints appear on every line.

**Inspect from the terminal:**
```bash
# All tensor variables
trickle vars --tensors

# Filter by file
trickle vars --file model.py

# All variables as JSON
trickle vars --json
```

## Use Case 3: Crash Debugging

When your code crashes with a shape mismatch, trickle automatically prints the tensor shapes near the crash site:

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

No more guessing. You immediately see that `x` is `[4, 8]` but `weight` expects `[16, 32]`.

## Use Case 4: Without the CLI

If you don't want to install Node.js/npm at all:

```python
# Option A: magic command in notebooks
%load_ext trickle

# Option B: one import in scripts
import trickle.auto

# Option C: command line without CLI
TRICKLE_LOCAL=1 python -m trickle train.py
```

All three work with just `pip install trickle-observe`.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TRICKLE_LOCAL` | `0` | `1` for offline mode (no backend needed) |
| `TRICKLE_TRACE_VARS` | `1` | `0` to disable variable tracing |
| `TRICKLE_OBSERVE_INCLUDE` | all user code | Comma-separated module patterns to trace |
| `TRICKLE_OBSERVE_EXCLUDE` | none | Comma-separated module patterns to skip |
| `TRICKLE_DEBUG` | `0` | `1` for verbose output |

## Tips

- **Clear between experiments**: `trickle.notebook.clear()` or `rm .trickle/variables.jsonl` before starting fresh
- **Re-run cells freely**: The extension matches cells by content, so editing and re-running a cell updates hints correctly without restarting the kernel.
- **Exclude noisy modules**: `TRICKLE_OBSERVE_EXCLUDE=data_utils,logging trickle run train.py`
- **Check the status bar**: You should see "Trickle: N vars" in VSCode. If not, the extension isn't finding `.trickle/variables.jsonl` — make sure VSCode's workspace folder matches where you ran the code.
