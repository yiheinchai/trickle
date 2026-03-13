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
