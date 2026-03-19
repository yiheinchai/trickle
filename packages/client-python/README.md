# trickle-observe

Runtime type annotations for Python — see tensor shapes, variable types, and crash-time values as you code.

```bash
pip install trickle-observe
```

## Quick Start

### Scripts

```bash
pip install trickle-observe
npm install -g trickle-cli

trickle run python train.py     # run with tracing
trickle hints                   # view source with inline types
trickle hints --errors          # crash-time values + error underline
```

### Jupyter Notebooks

```python
%load_ext trickle               # first cell, then run your code
```

Types appear inline in VSCode immediately after each cell runs.

## What You See

Every variable gets its runtime type visible — in VSCode or in the terminal:

```python
def forward(self, x: Tensor[128, 2] float32):
    x: Tensor[128, 256] float32 = self.relu(self.bn0(self.embed(x)))
    x: Tensor[128, 16, 16] float32 = x.view(x.size(0), 16, 16)
    x: Tensor[128, 32, 16] float32 = self.relu(self.bn1(self.conv1(x)))
```

When code crashes, see exactly what each variable held:

```
# train.py — ERROR
# ValueError: could not convert string to float: 'ID' (line 20)
file_path: string = "demographics.txt"
patient_gait_data: string[] = ["ID\tStudy\tGroup\t..."]
    [float(d) for d in time.split('\t')] for time in patient_gait_data
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~  <- ValueError: ...
```

## Usage

### With the CLI (recommended)

```bash
pip install trickle-observe
npm install -g trickle-cli

trickle run python your_script.py
trickle hints your_script.py
```

### As a library

```python
import trickle

# Wrap individual functions
@trickle.trickle
def process(data):
    ...

# Instrument a FastAPI/Flask/Django app
trickle.instrument(app)

# Universal observation — wrap all functions on a module
trickle.observe(my_module)
```

### In Jupyter Notebooks

```python
%load_ext trickle
```

All cells after this are traced. The VSCode extension shows inline type hints.

### With pytest

```bash
trickle run pytest tests/
```

## What Gets Traced

- **Tensor shapes** — PyTorch (shape, dtype, device, memory, gradient norms), MLX (shape, dtype, memory), NumPy, pandas
- **All variable assignments** — simple, for-loops, function parameters, tuple unpacking, with-as
- **Imported modules** — your local modules are traced too, not just the entry file
- **Error snapshots** — all variables at crash time, including list comprehension scopes

## Supported Frameworks

- **ML**: PyTorch, MLX, NumPy, pandas, scikit-learn, HuggingFace
- **Web**: FastAPI, Flask, Django, Litestar
- **LLM**: OpenAI, Anthropic, Google Gemini, LangChain, CrewAI

## How It Works

Trickle rewrites your Python source via AST transformation before execution. After every variable assignment, it inserts a lightweight call that captures the type and a sample value, then writes to `.trickle/variables.jsonl`.

Only your code is traced — stdlib, site-packages, torch/numpy internals are skipped. No code changes to your files. No decorators required.

## Related Packages

| Package | Description |
|---------|-------------|
| [trickle-cli](https://www.npmjs.com/package/trickle-cli) | CLI for `trickle run` and `trickle hints` |
| [trickle-vscode](https://marketplace.visualstudio.com/items?itemName=yiheinchai.trickle-vscode) | VSCode extension for inline type hints |

## License

Apache-2.0
