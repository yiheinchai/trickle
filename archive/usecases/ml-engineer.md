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

Scalar values like `loss` are tracked across iterations. After the cell finishes, trickle prints:
```
[trickle] Scalar tracking:
  loss (L7): 2.513 ↓ 0.209 (min=0.2025, max=2.513, 50 steps)
```
The inline hint also updates to show the trend: `loss: 2.51 ↓ 0.21 (50 steps)`.

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
- HuggingFace datasets: `Dataset(200 rows, text, label) [train]`, `DatasetDict(train: 160, test: 40)`
- Tensor statistics: hover shows `min=-2.3 max=4.1 mean=0.01 std=1.02` — helps detect dead ReLUs (std≈0), exploding activations, or distribution shift
- Memory footprint: hover shows `mem=4.0 MB` per tensor (helps debug OOM)
- Model memory: `GPT(110280192 params 420.7 MB)` shows total model size inline
- Gradient norms: after `loss.backward()`, models show `GPT(834304 params) |∇|=5.32` — total gradient norm across all parameters, plus top layers by norm on hover
- NaN/Inf gradient detection: immediately flags `⚠ grad NaN!` if any parameter has NaN gradients
- Scalar tracking: `loss: 2.51 ↓ 0.21 (50 steps)` tracks value evolution in loops
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

## Use Case 4: Gradient Debugging

After `loss.backward()`, trickle automatically re-traces your model with gradient information:

```python
model = GPT(config)                    # → GPT(834304 params 3.2 MB)
logits, loss = model(idx, targets)
loss.backward()                        # → model updates to: GPT(834304 params 3.2 MB) |∇|=5.32
```

The `|∇|=5.32` badge shows the total L2 gradient norm across all parameters. Hover for per-layer breakdown:

```
grad_norm=5.32 top: c_proj.weight=2.29, c_proj.weight=1.92, wte.weight=1.73
```

**What to look for:**
- `|∇|` very small (< 1e-6) → vanishing gradients, learning has stalled
- `|∇|` very large (> 1000) → exploding gradients, training will diverge
- `⚠ grad NaN!` → NaN in gradients, something is numerically unstable
- `⚠ grad Inf!` → Inf in gradients, likely overflow

This replaces the common debugging pattern:
```python
# Before trickle — manual gradient inspection
for name, param in model.named_parameters():
    if param.grad is not None:
        print(f"{name}: {param.grad.norm():.4f}")

# After trickle — just look at the inline hint
loss.backward()  # gradient info appears automatically on the model variable
```

## Use Case 5: Config and Dataclass Visibility

ML configs defined as dataclasses or NamedTuples now show actual field values inline — not just the class name:

```python
from dataclasses import dataclass
from typing import NamedTuple

@dataclass
class GPTConfig:
    block_size: int = 1024
    vocab_size: int = 50257
    n_layer: int = 12
    n_head: int = 12
    n_embd: int = 768
    dropout: float = 0.0
    bias: bool = True

class TrainConfig(NamedTuple):
    lr: float
    batch_size: int
    epochs: int

config = GPTConfig(n_layer=6, n_head=6, n_embd=384)
# → GPTConfig(block_size=1024, vocab_size=50257, n_layer=6, n_head=6, +3)

train_cfg = TrainConfig(lr=3e-4, batch_size=64, epochs=10)
# → TrainConfig(lr=0.0003, batch_size=64, epochs=10)
```

**Nested configs** work too — sub-fields show their class name compactly:

```python
@dataclass
class TrainArgs:
    model: GPTConfig = field(default_factory=GPTConfig)
    batch_size: int = 12
    learning_rate: float = 6e-4
    max_iters: int = 600000

args = TrainArgs()
# → TrainArgs(model=GPTConfig(...), batch_size=12, learning_rate=0.0006, max_iters=600000)
```

You see the actual values at a glance — no more printing the config to remember what you set. Works for:
- Python `@dataclass` classes (including nested dataclasses/Pydantic models as sub-fields)
- `typing.NamedTuple` classes
- `collections.namedtuple` classes
- Pydantic v1 and v2 models (including nested models)

Hover for full details including all field types and their values.

## Use Case 6: Without the CLI

If you don't want to install Node.js/npm at all:

```python
# Option A: magic command in notebooks
%load_ext trickle

# Option B: one import in scripts — traces all variables automatically
import trickle.auto

# Option C: command line without CLI
TRICKLE_LOCAL=1 python -m trickle train.py
```

All three work with just `pip install trickle-observe`.

**Option B** is the easiest way to get started — just add `import trickle.auto` as the first line of your training script. It traces all variables (tensors, models, optimizers, schedulers, DataLoaders) plus gradient norms after `loss.backward()`. Open the file in VSCode and inline hints appear everywhere.

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

---

## Use Case 7: pytest — See Types While Writing Model Tests

When you install `trickle-observe`, the pytest plugin activates automatically for every `pytest` run. No configuration needed — just write your tests and run them.

```bash
pip install trickle-observe
pytest tests/test_model.py -v
```

Open any test file in VSCode — variable types appear inline as you write tests:

```python
# tests/test_model.py
import pytest
import torch
from model import GPTConfig, GPT

@pytest.fixture
def small_config():
    return GPTConfig(block_size=32, vocab_size=128, n_layer=2, n_head=2, n_embd=64)

def test_model_init(small_config):
    model = GPT(small_config)
    # → model: GPT{training, params, memory}

    n_params = model.get_num_params()
    # → n_params: 106816

    param_list = list(model.parameters())
    # → param_list: Parameter[]

def test_forward_pass(small_config):
    model = GPT(small_config)
    idx = torch.randint(0, small_config.vocab_size, (2, 16))
    # → idx: Tensor[2, 16] int64

    logits, loss = model(idx, idx)
    # → logits: Tensor[2, 16, 128] float32
    # → loss: Tensor[] float32

    loss_val = loss.item()
    # → loss_val: 4.8732

def test_generate(small_config):
    model = GPT(small_config)
    model.eval()
    prompt = torch.zeros((1, 4), dtype=torch.long)
    generated = model.generate(prompt, max_new_tokens=8)
    # → generated: Tensor[1, 12] int64

    gen_shape = generated.shape
    # → gen_shape: (1, 12)
```

**What gets traced automatically:**
- All `const`/`let`-style local variable assignments in test functions
- Function parameters (e.g., `small_config` from the fixture)
- Tensor shapes, dtypes, and actual scalar values
- Model objects showing their class and key attributes

**Opt out** if needed: `TRICKLE_TRACE_VARS=0 pytest` or add `-p no:trickle` to your pytest invocation.

---

## Use Case 8: Model Config Visibility — See Constructor Params Inline

When you instantiate a model like `model = GPT(config)`, the inline hint now shows the actual configuration parameters from the config object — not just the class name.

```python
# train.py
import trickle.auto

config = GPTConfig(block_size=1024, vocab_size=50257, n_layer=12, n_head=12, n_embd=768)
# → config: GPTConfig{block_size=1024, vocab_size=50257, n_layer=12, n_head=12, n_embd=768, ...}

model = GPT(config)
# → model: GPT(block_size=1024, vocab_size=50257, n_layer=12, n_head=12, n_embd=768, +2)
```

Hovering over `model` shows the full structured type with all config fields plus `params`, `memory`, `training` status:
```typescript
GPT {
  block_size: 1024
  vocab_size: 50257
  n_layer: 12
  n_head: 12
  n_embd: 768
  dropout: 0.0
  bias: true
  training: True
  params: 85336064
  memory: 325.5 MB
}
```

This works for any model that stores its config as `self.config` — which is the standard pattern in HuggingFace, nanoGPT, and most modern ML frameworks.

---

## Use Case 9: HuggingFace Integration — Config Fields Inline

When you load or instantiate a HuggingFace model or config, trickle automatically surfaces the most important architecture parameters inline — no need to print or inspect the config object.

```python
import trickle.auto
from transformers import GPT2Config, BertConfig, AutoModelForCausalLM

# Config objects show priority fields
gpt2_config = GPT2Config()
# → gpt2_config: GPT2Config{vocab_size=50257, n_embd=768, n_layer=12, n_head=12, n_positions=1024, model_type=gpt2}

bert_config = BertConfig()
# → bert_config: BertConfig{vocab_size=30522, hidden_size=768, num_hidden_layers=12, num_attention_heads=12, ...}

# Custom small config
small_config = GPT2Config(vocab_size=1000, n_embd=128, n_layer=4, n_head=4)
# → small_config: GPT2Config{vocab_size=1000, n_embd=128, n_layer=4, n_head=4, ...}

# Models with config show constructor-call style hint
model = AutoModelForCausalLM.from_config(small_config)
# → model: GPT2LMHeadModel(vocab_size=1000, n_embd=128, n_layer=4, n_head=4, +1)
```

**Priority fields shown first:** `vocab_size`, `hidden_size`/`n_embd`/`d_model`, `num_hidden_layers`/`n_layer`, `num_attention_heads`/`n_head`, `intermediate_size`, `max_position_embeddings`, `model_type`.

Works for all `PretrainedConfig` subclasses: GPT-2, BERT, T5, LLaMA, Mistral, Falcon, etc.

---

## Use Case 10: Type Drift Alerts — Catch Shape Regressions Between Runs

When you change a model architecture or dataset and re-run training, tensor shapes may silently change. Trickle detects when a variable's type changes between runs and marks the inline hint with ⚠.

```python
import trickle.auto
import torch
import torch.nn as nn

# First run: hidden_size=768
W = nn.Linear(768, 10)
x = torch.randn(32, 768)
out = W(x)
# → out: Tensor[32, 10] float32

# Second run after refactoring to hidden_size=512:
W = nn.Linear(512, 10)
x = torch.randn(32, 512)
out = W(x)
# → out: Tensor[32, 10] float32 ⚠  ← hover shows "Type changed since last run"
```

**When it triggers:** any time the `typeHash` of a variable at the same file+line changes between two executions within a VSCode session. Useful for catching:
- Tensor shape changes (e.g. batch size or embedding dim changes)
- dtype changes (float32 → float16 after mixed precision is enabled)
- Return type changes after refactoring a function

The ⚠ indicator appears inline next to the type hint and the hover tooltip explains the drift.

---

## Use Case 11: Variable Flow Across Function Calls — Input→Output Shape Transformation

When debugging a neural network, you often want to know not just what shape a tensor is, but how it was transformed — what layer produced it and what the input shape was. Trickle now surfaces this automatically.

```python
import trickle.auto
import torch
import torch.nn as nn

class MLP(nn.Module):
    def __init__(self, n_embd):
        super().__init__()
        self.fc1 = nn.Linear(n_embd, 4 * n_embd)
        self.fc2 = nn.Linear(4 * n_embd, n_embd)

    def forward(self, x):
        h = self.fc1(x)
        # Hover on `h` shows:
        # Flow: `self.fc1` (Linear): `x`: `Tensor[8, 64]` → `Tensor[8, 256]`

        out = self.fc2(h)
        # Hover on `out` shows:
        # Flow: `self.fc2` (Linear): `h`: `Tensor[8, 256]` → `Tensor[8, 64]`
        return out

mlp = MLP(64)
x = torch.randn(8, 64)
out = mlp(x)
# Hover on `out` shows:
# Flow: `mlp` (MLP): `x`: `Tensor[8, 64]` → `Tensor[8, 64]`

W = nn.Linear(784, 10)
inp = torch.randn(32, 784)
result = W(inp)
# Hover on `result` shows:
# Flow: `W` (Linear): `inp`: `Tensor[32, 784]` → `Tensor[32, 10]`
```

**How it works:** Trickle's AST parser detects call-site assignments (`out = layer(x)`). At runtime, it captures the callee object's class and the input argument types, then associates them with the output variable. The VSCode hover shows the complete transformation chain.

**Shape flow chain:** When a tensor variable changes shape multiple times within a function, the hover shows the entire chain:
```
x shape flow (in MLP.forward):
  L12: Tensor[8, 256] (AddmmBackward0) ← self.fc1(Linear) ←
  L13: Tensor[8, 64]  (AddmmBackward0) ← self.fc2(Linear) ←
```

---

## Use Case 12: Cross-Run Type History — Persist Drift Detection Across VSCode Restarts

Type drift alerts now survive VSCode restarts. Trickle persists type hashes to `.trickle/type_history.json` so that when you reload VSCode and re-run your training script, drift is still detected compared to previous runs.

```python
import trickle.auto
import torch
import torch.nn as nn

# Run on Monday: hidden_size=256
model = nn.Linear(256, 10)
x = torch.randn(32, 256)
out = model(x)  # → Tensor[32, 10] float32

# [close VSCode, reopen Tuesday]

# Run on Tuesday after refactoring to hidden_size=512:
model = nn.Linear(512, 10)
x = torch.randn(32, 512)
out = model(x)  # → Tensor[32, 10] float32 ⚠  ← detected even after restart!
```

**How it works:** 
- `.trickle/type_history.json` is written after every run, keyed by `file:line:varName`
- On VSCode activation, this file is loaded into memory as the baseline for drift detection
- Drift is now persistent across sessions — not just within a single VSCode window

**When this matters:**
- Day-over-day experiments where you refactor and reopen VSCode between runs
- CI pipelines that open a fresh editor for each run
- Team workflows where one engineer's type history catches a regression introduced by another's merge

Commit `.trickle/type_history.json` to share drift baselines with your team, or add it to `.gitignore` to keep history local.

---

## Use Case 13: Training Loop Progress — Real-Time Status Bar Display

For long GPU training runs, you want to monitor loss and metrics without leaving VSCode. Add one line to your training loop and the status bar updates in real time.

```python
import trickle
import torch
import torch.nn as nn

model = nn.TransformerEncoder(...)
optimizer = torch.optim.AdamW(model.parameters(), lr=6e-4)
scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max_iters)

for iter_num in range(max_iters):
    x, y = get_batch('train')
    logits, loss = model(x, y)
    optimizer.zero_grad()
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    optimizer.step()
    scheduler.step()

    # Emit progress — VSCode status bar shows this in real time
    trickle.progress(
        iter=iter_num,
        loss=loss,           # tensors are automatically unwrapped with .item()
        lr=scheduler.get_last_lr()[0],
        every=10,            # write every 10 iterations to avoid file I/O overhead
    )
```

**VSCode status bar shows:**
```
🔄 Training: iter 245 | loss 2.3401 | lr 0.0006
```

**Arguments:**
- `every=N` — only write every N calls (default 1). Use `every=10` or `every=100` for tight loops.
- Any keyword argument becomes a metric: `loss=`, `epoch=`, `step=`, `acc=`, `lr=`, `val_loss=`, etc.
- PyTorch/NumPy scalars are unwrapped automatically (`.item()` is called for you).

**Status bar ordering:** `epoch` → `step`/`iter`/`batch` → `loss` → `val_loss` → `acc` → `lr` → custom metrics.

**Auto-hides** after 120 seconds of no new progress records (switches back to var count display).

---

## Use Case 14: Dict/Object Inline Value Display — See Metric Values at a Glance

When you collect training metrics or evaluation results in a dict, trickle now shows the actual values inline instead of the generic `{key: type}` display.

```python
import trickle.auto

# Metrics dict — shows values inline, not just types
train_metrics = {
    "loss": 0.42,
    "acc": 0.91,
    "lr": 1e-4,
    "tokens_per_sec": 45000,
}
# → {loss: 0.42, acc: 0.91, lr: 0.0001, tokens_per_sec: 45000}

eval_results = {
    "val_loss": 0.55,
    "val_acc": 0.88,
    "perplexity": 1.73,
}
# → {val_loss: 0.55, val_acc: 0.88, perplexity: 1.73}

# Mixed-type dicts also work
config_summary = {
    "model": "gpt2",
    "layers": 12,
    "accuracy": 0.9512,
    "trained": True,
}
# → {model: "gpt2", layers: 12, accuracy: 0.9512, trained: True}

# Large dicts show the first 5 keys + count of remaining
all_metrics = {"loss": 0.42, "acc": 0.91, "lr": 1e-4, "val_loss": 0.55, "val_acc": 0.88, "f1": 0.90, "auc": 0.95}
# → {loss: 0.42, acc: 0.91, lr: 0.0001, val_loss: 0.55, val_acc: 0.88, +2}
```

**How it works:** For dicts with string keys and up to 20 entries, trickle stores the actual values in the observation's sample field. The VSCode renderer detects `class_name: "dict"` and shows `{key: value}` format. Hover shows the full dict with all key-type pairs.

**When useful:**
- Metrics dicts from training loops — see exact values without opening a terminal
- Evaluation result dicts — compare val_loss/val_acc at a glance
- Config summaries — verify hyperparameter values are set correctly

---

## Use Case 15: Exception Observability — See Variable State at the Crash Line

When your training script crashes with a shape mismatch or other error, trickle now shows the local variable values directly on the failing line as inlay hints — no print statements, no debugger needed.

```python
import trickle.auto

def train_step(model, x, y, optimizer):
    batch_size = x.shape[0]   # → 32
    hidden_dim = 512
    lr = 3e-4
    
    logits = model(x)          # ← if x has wrong shape, this line gets annotated
    loss = criterion(logits, y)
    loss.backward()
    optimizer.step()
```

**When a crash occurs:**
```
RuntimeError: mat1 and mat2 shapes cannot be multiplied (32x512 and 784x10)
```

**VSCode shows on the crashing line:**
```
logits = model(x)   ✗ x: Tensor[32, 512] | batch_size: 32 | hidden_dim: 512 | lr: 0.0003
```

**Hover tooltip shows full variable state:**
```
### Trickle: Variables at crash

`x`: `Tensor[32, 512] float32`
`batch_size`: `integer` = `32`
`hidden_dim`: `integer` = `512`
`lr`: `number` = `0.0003`
`model`: `MLP(512 params)`
```

**Also visible in the Problems panel:**
```
RuntimeError: mat1 and mat2 shapes cannot be multiplied (32x512 and 784x10)

Local variables at crash:
  x: Tensor[32, 512] float32
  batch_size: integer = 32
  hidden_dim: integer = 512
  lr: number = 0.0003

Tensor shapes near error:
  L12 x: Tensor[32, 512] float32
```

**How it works:** `trickle.auto` installs a `sys.excepthook` that fires on any unhandled exception. It walks the traceback to find the innermost user-code frame (skipping PyTorch/NumPy internals), captures all local variables there, and writes them to `.trickle/errors.jsonl`. The VSCode extension picks this up within 300ms and shows crash-site inlay hints + an enhanced diagnostic.

---

## Use Case 16: Automatic Training Metric Detection

**User:** ML engineer training a neural network with `trickle.auto`, without calling `trickle.progress()` explicitly.

**Before trickle:** The status bar shows nothing during training. To see progress you add print statements or a progress library.

**With trickle:**
```python
import trickle.auto  # just this one line

for epoch in range(10):
    for step, (x, y) in enumerate(loader):
        loss = criterion(model(x), y)
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        acc = (predictions == y).float().mean()
        lr = scheduler.get_last_lr()[0]
        # No trickle.progress() needed!
```

The VSCode status bar automatically shows:
```
🔄 Training: epoch 3 | step 247 | loss 0.3421 | acc 0.8912 | lr 0.0006
```

**How it works:** `trickle.auto` uses the AST variable tracer to detect which lines are inside `for`/`while` loop bodies. When a variable with a training-metric name (`loss`, `acc`, `epoch`, `step`, `lr`, `val_loss`, etc.) is assigned in a loop, trickle automatically emits a `kind: "progress"` record to `.trickle/variables.jsonl`. Rate-limited to every 10 iterations by default (configurable via `TRICKLE_AUTO_PROGRESS_EVERY`). No code changes required beyond `import trickle.auto`.

---

## Use Case 17: Gradient Flow Visualization

**User:** ML engineer debugging a deep neural network that's not converging, suspecting vanishing gradients.

**Before trickle:** Must add `for name, p in model.named_parameters(): print(name, p.grad.norm())` after every backward call, or register manual hooks.

**With trickle:**
```python
import trickle.auto  # just this one line

for step in range(1000):
    loss = criterion(model(x), y)
    optimizer.zero_grad()
    loss.backward()  # ← inlay hint appears here automatically
    optimizer.step()
```

VSCode shows at the `loss.backward()` line:
```
loss.backward()  ∇ model: ↓ vanishing: layers.0, layers.1, layers.2 | layers.9=4.09e-01
```

Hover tooltip shows the full table:
```
∇ Gradient Norms: `model`

| Layer    | Grad Norm  |
|----------|------------|
| out      | 5.30e+00   |
| layers.9 | 4.09e-01   |
| layers.8 | 4.78e-04   |
| layers.7 | 6.60e-07 ↓ |
| layers.0 | 0.00e+00 ↓ |

max: 5.30e+00 · min: 6.60e-07
↓ Vanishing (<1e-6): layers.7, layers.0, layers.1, ...
```

**How it works:** `trickle.auto` patches `torch.Tensor.backward()`. After each backward pass it walks the caller's frame locals to find `nn.Module` instances, calls `model.named_parameters()` to compute per-parameter gradient norms, groups by module path (e.g. `layers.0`), then writes a `kind: "gradient"` record to `.trickle/variables.jsonl`. The VSCode extension reads this and shows it as an inlay hint at the exact `backward()` call line.

---

## Use Case 18: Multi-File Variable Tracing

**User:** ML engineer with a modular codebase: `train.py` (entry), `model.py` (architecture), `data.py` (dataloader).

**Before trickle:** Inline hints only appeared in `train.py`. Variables defined inside `model.py` (like `self.n_embd`, `hidden_states`, `attention_weights`) showed no hints even with `trickle.auto`.

**With trickle:**
```python
# train.py
import trickle.auto  # one line
from model import GPT  # <-- model.py now ALSO gets inline hints

model = GPT(vocab_size=50257, n_embd=768, n_layer=12)
```

```python
# model.py (no trickle import needed)
class GPT(nn.Module):
    def __init__(self, vocab_size, n_embd, n_layer):
        self.vocab_size = vocab_size  # ← inline hint: integer = 50257
        self.n_embd = n_embd          # ← inline hint: integer = 768
        self.n_layer = n_layer        # ← inline hint: integer = 12
```

**How it works:** The import hook in `trickle.auto` already wraps function calls in imported user modules for type inference. Multi-file tracing adds one more step: when a user module is imported, its source file is parsed by the AST variable tracer and registered in the assignment map. The existing `sys.settrace`-based global trace then picks it up automatically — no changes to `model.py` or any imported file required.

---

## Use Case 19: Model Checkpoint Observability

**User:** ML engineer saving model checkpoints during training, wanting to know which metrics corresponded to each saved checkpoint without adding print statements.

**Before trickle:** Must add `print(f"Saved checkpoint: epoch={epoch}, loss={loss:.4f}")` after every `torch.save()`, or check filename conventions to infer training state.

**With trickle:**
```python
import trickle.auto  # just this one line

for epoch in range(100):
    loss = train_one_epoch(model, loader)
    val_loss = evaluate(model, val_loader)
    
    if val_loss < best_val_loss:
        best_val_loss = val_loss
        torch.save(model.state_dict(), f'checkpoints/model_epoch{epoch}.pt')
        # ↑ inlay hint appears here automatically:
        # 💾 model_epoch42.pt | epoch=42 | step=12600 | loss=0.3421 | val_loss=0.3105 (×15)
```

Hover tooltip shows the full checkpoint history:
```
💾 Checkpoint Saves

1. `model_epoch10.pt` — epoch=10, val_loss=0.8213 @ 14:32:01
2. `model_epoch23.pt` — epoch=23, val_loss=0.5447 @ 14:45:12
...
15. `model_epoch42.pt` — epoch=42, val_loss=0.3105 @ 15:23:44
```

**How it works:** `trickle.auto` patches `torch.save()` and `transformers.PreTrainedModel.save_pretrained()`. After each save, it scans the caller's frame locals for training metric variables (`epoch`, `step`, `loss`, `val_loss`, `acc`, `lr`, etc.) and writes a `kind: "checkpoint"` record to `.trickle/variables.jsonl`. The VSCode extension reads these records and shows them as inlay hints at the save line, accumulating a history across the training run.

---

## Use Case 20: Learning Rate Scheduler Visualization

**User:** ML engineer using a cosine annealing or warmup LR schedule, wanting to verify the LR curve is correct without adding logging.

**Before trickle:** Must add `print(f"lr={scheduler.get_last_lr()[0]:.2e}")` after every `scheduler.step()`, or use TensorBoard/W&B to plot the LR curve.

**With trickle:**
```python
import trickle.auto  # just this one line

scheduler = CosineAnnealingLR(optimizer, T_max=1000, eta_min=1e-6)

for epoch in range(100):
    for step, batch in enumerate(loader):
        loss = train_step(model, batch)
        optimizer.step()
        scheduler.step()  # ← inlay hint appears here automatically:
                          #   📈 lr=1.04e-04 | epoch=3 | step=450
```

Hover tooltip shows:
```
📈 Learning Rate: `CosineAnnealingLR`

Current LR: `1.04e-04`
Context: epoch: 3 · step: 450 · loss: 0.342
Step: 450
```

**Multi param-group example** (different LRs for backbone vs head):
```
scheduler.step()  📈 lr=[1.04e-05, 1.04e-04]
```

**How it works:** `trickle.auto` patches `torch.optim.lr_scheduler.LRScheduler.step()` (the base class). After each step, it reads the current LR from each optimizer param group, captures training context (epoch/step/loss) from the caller's frame, and writes a `kind: "lr_schedule"` record. Rate-limited to every 10 steps by default (`TRICKLE_LR_EVERY` to tune). Works with all PyTorch schedulers: CosineAnnealingLR, OneCycleLR, LinearWarmup, ReduceLROnPlateau, etc.

---

## Use Case 21: Memory Profiling Inlay Hints

**User:** ML engineer hitting CUDA OOM errors, wanting to see which tensor allocations are consuming the most memory without adding `torch.cuda.memory_allocated()` print statements everywhere.

**Before trickle:** Must manually add `print(f"GPU memory: {torch.cuda.memory_allocated()/1e9:.1f}GB")` after each suspicious line, or use memory profilers with separate workflows.

**With trickle:**
```python
import trickle.auto  # just this one line

# GPU training
x = tokenizer(batch)            # x: Tensor[32,512] int64  🟡 342MB GPU
embeddings = model.embed(x)     # embeddings: Tensor[32,512,768] float16  🟡 940MB GPU
attn_output = attn(embeddings)  # attn_output: Tensor[32,512,768] float16  🔴 1.8GB GPU
logits = head(attn_output)      # logits: Tensor[32,512,50257] float16  🔴 2.6GB GPU
```

🔴 appears when GPU memory exceeds 1GB, 🟡 otherwise. Hover shows:
```
GPU Memory: `940.2MB allocated (1024MB reserved)`
```

**CPU example:**
```python
weights = torch.randn(1024, 1024)  # weights: Tensor[1024,1024] float32  261MB RAM
```

**How it works:** `trickle.auto`'s variable tracer calls `torch.cuda.memory_allocated()` after tracing each CUDA tensor and `resource.getrusage()` for CPU tensors. The memory snapshot is stored in `gpu_memory_mb` / `cpu_memory_mb` fields of the variable record. The VSCode extension appends the memory suffix to the type hint label so it's visible at a glance.

---

## Use Case 22: Dataset Shape Observability

**User:** ML engineer iterating over a DataLoader for the first time and wanting to immediately verify the batch shapes without adding print statements.

**Before trickle:** Must add `print(batch[0].shape, batch[1].shape)` or `print({k: v.shape for k, v in batch.items()})` on the line after the for loop, then remove them after debugging.

**With trickle:**
```python
import trickle.auto  # just this one line

for images, labels in train_loader:
    # ↑ inlay hint appears automatically: ⬛ [32,3,224,224] float32, [32] int64
    loss = criterion(model(images), labels)
    loss.backward()
```

HuggingFace-style dict batches:
```python
for batch in train_loader:
    # ↑ ⬛ {input_ids[8,128] int64, attention_mask[8,128] int64, labels[8] int64}
    outputs = model(**batch)
```

Hover shows full breakdown:
```
⬛ DataLoader Batch Shapes

item 0: [32, 3, 224, 224] · torch.float32
item 1: [32] · torch.int64

Batch #1 captured by trickle
```

**How it works:** `trickle.auto` patches `_SingleProcessDataLoaderIter.__next__` and `_MultiProcessingDataLoaderIter.__next__`. After each `__next__` call, it walks the call stack to find the user's for-loop frame, extracts tensor shapes from the batch (handling tuples, lists, and dicts), and writes a `kind: "dataloader_batch"` record. Rate-limited to 3 batches per loop location (`TRICKLE_DL_BATCHES` to tune). The VSCode extension shows the shapes as an inlay hint on the for line.

---

## Use Case 23: Optimizer State Observability

**User:** ML engineer training a transformer and wanting to monitor gradient health and weight update magnitudes on optimizer.step() lines without adding manual gradient clipping checks or custom callbacks.

**Before trickle:** Must add `torch.nn.utils.clip_grad_norm_()` monitoring, custom `optimizer.step_post_hook()`, or print statements after each step.

**With trickle:**
```python
import trickle.auto  # just this one line

optimizer.step()  # ⚙ grad=6.50e-01 | Δθ=7.66e-02 | σ=5.40e-01
```

When gradients explode:
```python
optimizer.step()  # ⚡ grad=1.46e+02 | Δθ=1.46e+00 | σ=1.60
```

Hover tooltip shows full breakdown:
```
⚙ Optimizer: `AdamW`

Gradient norm: `6.5013e-01`

Weight update: `||Δθ|| = 7.6595e-02`

Parameter groups:
| Group | LR | Norm | Mean | Std | #Params |
|---|---|---|---|---|---|
| group 0 | lr=`0.0003` | norm=`259.2211` | μ=`-0.0000` | σ=`0.5404` | params=`230,144` |

Context: epoch: 1 · step: 100 · loss: 2.438

Step #100
```

**How it works:** `trickle.auto` patches all concrete optimizer subclasses' `step()` methods (including custom user-defined optimizers via `__init_subclass__` hook). Before each step, captures the gradient norm across all parameters. After the step, computes the weight update norm (`||θ_new - θ_old||`) and per-group parameter statistics. Works with SGD, Adam, AdamW, RMSprop, and any custom optimizer. Rate-limited to every 10 steps by default (`TRICKLE_OPT_EVERY` to tune). The `⚡` warning triggers when `grad_norm > 10.0`, `↓` when `grad_norm < 1e-5`.

---

## Use Case 24: Training Throughput Metrics

**User:** ML engineer training a ResNet on ImageNet and wanting to know if their DataLoader is a bottleneck, how fast they're processing samples, and how long until the epoch finishes.

**Before trickle:** Must manually record timestamps, compute rolling averages, or use tqdm with `samples/s` display — all requiring explicit instrumentation.

**With trickle:**
```python
import trickle.auto  # just this one line

for batch in train_loader:   # ⬛ [32,3,224,224] float32  ⚡ 1.23k smp/s | ETA 0:42 (38%)
    ...
```

Hover tooltip shows:
```
⚡ Training Throughput

Samples/sec: 1234.5
Batches/sec: 38.578
Batch size: 32
Batches done: 60 / 157
ETA: 0:42

Tracked by trickle (rolling avg)
```

**How it works:** The DataLoader hook tracks inter-batch timing at each for-loop call site. After every 10 batches (configurable via `TRICKLE_THROUGHPUT_EVERY`), it computes a rolling average over the last 20 durations, derives samples/sec and batches/sec, and reads the total batch count from `_index_sampler` to compute ETA. The VSCode extension shows the throughput inlay hint on the for-loop line, after the shape hint.

---

## Use Case 25: Activation Statistics Observability

**User:** ML engineer debugging a deep transformer where training loss stagnates. Suspects dead neurons or vanishing activations in the MLP layers but doesn't want to add manual `print(x.mean(), x.std())` calls after every layer.

**Before trickle:** Must manually add hooks via `model.register_forward_hook()` or insert debug print statements, then remove them before committing.

**With trickle:**
```python
import trickle.auto  # just this one line

class MLP(nn.Module):
    def forward(self, x):
        x = self.gelu(self.c_fc(x))   # ◆ μ=0.11 σ=0.33
        return self.c_proj(x)          # ◆ μ=-0.01 σ=0.20

class Block(nn.Module):
    def forward(self, x):
        x = x + self.attn(self.ln_1(x))
        x = x + self.mlp(self.ln_2(x))  # ◆ μ=0.05 σ=1.53 [sat:56%]
        return x

logits = model(idx)   # ◆ μ=-0.00 σ=0.54
```

When dead ReLUs are detected:
```python
x = self.relu(self.fc1(x))   # ◆ μ=0.23 σ=0.33 [dead:50%]
```

Hover tooltip shows:
```
◆ Activation Stats

Module: ReLU
Shape: [32, 256]
Mean: 0.2266
Std: 0.3338
Min: 0.0 · Max: 2.847
Zero fraction: 50.3% ⚠ dead neurons detected

Sampled at call #20 by trickle
```

**How it works:** `trickle.auto` registers a global forward hook via `nn.modules.module.register_module_forward_hook()`. After each module's forward pass, the hook walks the call stack to find the user's call site (skipping site-packages and trickle internals), computes mean/std/min/max of the output tensor, and checks for dead neurons (>50% zeros), saturation (>50% of |values| > 0.9), vanishing (std < 1e-5), and exploding (|max| > 1e3). Rate-limited to every 20 calls per call site (`TRICKLE_ACT_EVERY` to tune). Works for all nn.Module subclasses including custom modules.

---

## Use Case 26: Loss Landscape Probing

**User:** ML engineer training a transformer who notices loss stagnation after a few epochs. Wants to know if the loss is plateauing, oscillating, or truly converging — without manually plotting loss curves.

**Before trickle:** Must save loss to a list, plot with matplotlib after training, or add TensorBoard logging — all requiring extra code.

**With trickle:**
```python
import trickle.auto  # just this one line

for epoch in range(epochs):
    for batch in train_loader:
        ...
        loss.backward()   # ↘ loss=2.3412 Δ=-0.0041/step
```

Different patterns show automatically:
```python
loss.backward()   # — loss=1.2345 Δ=-0.0000/step [plateau — try raising LR]
loss.backward()   # 〰 loss=1.8230 Δ=+0.0021/step [oscillating — try lowering LR]
loss.backward()   # ↗ loss=4.2100 Δ=+0.1200/step [increasing — check LR/data]
loss.backward()   # ⚠ loss=inf [diverging — NaN/Inf detected — lower LR or add gradient clipping]
```

Hover tooltip shows:
```
↘ Loss Landscape

Pattern: decreasing  —  training healthy
Current loss: 2.3412
Moving avg: 2.4891
Std (window): 0.1234
Δ/step: -0.0041
Step: 150

Tracked by trickle (20-step rolling window)
```

**How it works:** `trickle.auto` patches `torch.Tensor.backward()`. When called on a scalar tensor (the loss), it captures the value and the call site. A rolling 20-step window is maintained per call site, and every 5 steps (configurable via `TRICKLE_LOSS_EVERY`) the pattern is classified:
- **plateau**: coefficient of variation < 0.5%
- **oscillating**: >55% of consecutive loss differences change sign
- **increasing**: positive linear trend slope
- **diverging**: NaN/inf detected
- **decreasing**: healthy negative trend

---

## Use Case 27: Attention Pattern Visualization

**User:** ML engineer training a transformer who suspects some attention heads have collapsed to uniform distributions (dead heads) or are over-focusing on single tokens (sharp heads), but doesn't want to add custom attention visualization code.

**Before trickle:** Must add `print(att.mean(0).mean(0))` inside the attention module, or write a separate script to plot attention heatmaps with matplotlib.

**With trickle:**
```python
import trickle.auto  # just this one line

class CausalSelfAttention(nn.Module):
    def forward(self, x):
        ...
        att = F.softmax(att, dim=-1)  # 🎯 H=2.50/3.47 | sharp:2 | dead:1
        y = att @ v
        return self.c_proj(y)
```

Hover tooltip shows full per-head breakdown:
```
🎯 Attention Pattern Stats

Heads: 8  ·  Seq len: 512
Mean entropy: 2.5021 / 3.4657 (72% of max)
Sharp heads (< 10% entropy): 2
Dead heads (> 95% entropy): 1
Mean max-attended position: 128.3
Diagonal attention (self): 12.5%

Per-head entropy:
head 0: 0.234 (7%) ⚡ sharp
head 1: 3.412 (98%) 💤 dead
head 2: 2.891 (83%)
...

Sampled at call #20 by trickle
```

**How it works:** `trickle.auto` patches `torch.nn.functional.softmax`. When softmax is called on a 4-D tensor with shape `(B, H, T, T)` — the signature of self-attention weights — the hook captures the result. It computes per-head entropy (`H = -Σ p·log(p)`), classifies heads as dead (entropy > 95% of log(T)) or sharp (entropy < 10% of log(T)), and records mean max-attended position and diagonal attention fraction. Rate-limited to every 20 calls per line (`TRICKLE_ATT_EVERY` to tune). Works with any attention implementation that uses `F.softmax`: nanoGPT, custom transformers, nn.MultiheadAttention.

---

## Use Case 28: Error Mode in Notebooks

When your code crashes in a Jupyter cell, trickle captures all variables at the moment of the crash and shows them as inlay hints on their original assignment lines — not stacked on the error line. This means you see each variable's value right where it was defined, making it immediately obvious which assignment introduced the bad data.

**Cell 1:**
```python
%load_ext trickle
```

**Cell 2:**
```python
import pandas as pd

file_path = "demographics.txt"
patient_gait_data = open(file_path).readlines()[:3]
ages = [int(line.split(",")[1]) for line in patient_gait_data]
mean_age = sum(ages) / len(ages)
```

If the cell crashes (say, a malformed line causes `int()` to fail), trickle captures every variable at crash time and pins hints to their assignment lines:

```python
file_path = "demographics.txt"                       # → "demographics.txt"
patient_gait_data = open(file_path).readlines()[:3]  # → ["Name,Age,Stride\n", "Alice,34,1.2\n", "Bob,NA,1.1\n"]
ages = [int(line.split(",")[1]) for line in patient_gait_data]  # ✗ ValueError
```

Variables from list comprehension scopes are captured too — you can see the value of `line` at the time of the crash, not just the outer locals.

**How it works:** The `%load_ext trickle` magic installs a custom exception handler on the IPython shell. When any cell raises an unhandled exception, trickle walks the traceback frames, captures all local variables (including comprehension scope variables like loop iterators), and writes error snapshot records to `.trickle/variables.jsonl` keyed by file and line. The VSCode extension reads these and renders each variable as an inlay hint on the line where it was originally assigned — not on the line that threw the error.

---

## Use Case 29: Error Mode for Scripts (CLI)

For debugging script crashes outside of notebooks, the CLI provides `trickle hints --errors`. When a script fails, trickle captures the variable state at the crash site and displays it in your terminal with source context.

```bash
trickle hints --errors
```

Output:
```
train.py:47
~~~~~~~~~~~
  45 │ batch_size = x.shape[0]         batch_size: 32
  46 │ hidden_dim = 512                 hidden_dim: 512
  47 │ logits = model(x)               x: Tensor[32, 512]  model: MLP(512 params)
     │ ✗ RuntimeError: mat1 and mat2 shapes cannot be multiplied (32x512 and 784x10)
  48 │ loss = criterion(logits, y)
  49 │ loss.backward()
```

The `~~~` underline marks the file and line where the crash occurred. Variable values appear to the right of each source line, showing exactly what state existed when the error was thrown.

**Display modes:**

- `trickle hints --errors --show types` — show only the inferred types (e.g. `Tensor[32, 512] float32`, `integer`)
- `trickle hints --errors --show values` — show only the runtime values (e.g. `32`, `512`, `"demographics.txt"`)
- `trickle hints --errors --show both` — show types and values together

This gives you a debugger-like experience for post-mortem analysis without needing to reproduce the crash interactively.

---

## Use Case 30: Runtime Autocomplete

When trickle knows the runtime type of a variable, it provides autocomplete suggestions scoped to that type. For example, if `t` is a `torch.Tensor`, typing `t.` in VSCode triggers completions for `shape`, `dtype`, `view`, `reshape`, `unsqueeze`, `permute`, `contiguous`, and other Tensor methods — based on the actual observed type, not static analysis guesses.

```python
import trickle.auto

t = torch.randn(32, 784)
# trickle knows t is Tensor[32, 784] float32

t.  # autocomplete shows: shape, dtype, view, reshape, unsqueeze, permute, ...
```

**Function-scoped:** Autocomplete is scoped to the function context where the variable was observed. If you have a variable called `t` in `train_step()` that is a Tensor, and another `t` in `preprocess()` that is a string, each function gets the correct completions for its own `t`. They do not interfere with each other.

```python
def train_step(model, x):
    t = model(x)       # t is Tensor — autocomplete shows .shape, .view, .reshape, ...

def preprocess(path):
    t = open(path).read()  # t is str — autocomplete shows .split, .strip, .upper, ...
```

**How it works:** The variable tracer records each variable's type along with its function scope (module + qualified function name). The VSCode extension registers a `CompletionItemProvider` that looks up the most recent type observation for the variable at the cursor position, filtered by the enclosing function. If a match is found, it returns method and attribute completions for that type.

---

## Use Case 31: Union Type Support

When an array contains tensors with different shapes, trickle now correctly infers the element type as `Tensor` and shows the array as `Tensor[]` instead of falling back to `unknown[]`.

```python
import trickle.auto
import torch

layers = [
    torch.randn(128, 64),    # Tensor[128, 64]
    torch.randn(64, 32),     # Tensor[64, 32]
    torch.randn(32, 10),     # Tensor[32, 10]
]
# → layers: Tensor[]
```

Previously, because each element had a different shape (`Tensor[128, 64]` vs `Tensor[64, 32]` vs `Tensor[32, 10]`), the type inferrer could not unify them and fell back to `unknown[]`. Now, trickle recognizes that all elements share the same base type (`Tensor`) and collapses the union to `Tensor[]`.

This applies to any list of same-class objects with differing type parameters — not just tensors. For example, a list of `ndarray` objects with different shapes also shows as `ndarray[]` instead of `unknown[]`.
