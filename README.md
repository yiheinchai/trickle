<p align="center">
  <h1 align="center">trickle</h1>
  <p align="center">
    <strong>Stop adding <code>print(x.shape)</code> everywhere.</strong><br>
    Run your Python code once — see every variable's type, shape, and value inline.
  </p>
  <p align="center">
    <a href="https://pypi.org/project/trickle-observe/"><img src="https://img.shields.io/pypi/v/trickle-observe?label=pypi&color=blue" alt="PyPI"></a>
    <a href="https://www.npmjs.com/package/trickle-cli"><img src="https://img.shields.io/npm/v/trickle-cli?label=npm&color=red" alt="npm"></a>
    <a href="https://marketplace.visualstudio.com/items?itemName=yiheinchai.trickle-vscode"><img src="https://img.shields.io/visual-studio-marketplace/v/yiheinchai.trickle-vscode?label=vscode&color=purple" alt="VS Marketplace"></a>
    <a href="https://pypi.org/project/trickle-observe/"><img src="https://img.shields.io/pypi/pyversions/trickle-observe" alt="Python"></a>
    <a href="https://github.com/yiheinchai/trickle/blob/main/LICENSE"><img src="https://img.shields.io/github/license/yiheinchai/trickle" alt="License"></a>
  </p>
</p>

<p align="center">
  <img src="image.png" alt="Tensor shapes visible inline in VSCode" width="800">
</p>

## The problem

You're training a model. Your code crashes with a shape mismatch. You add `print(x.shape)` on line 32, `print(w.shape)` on line 33, run it again, read the output, delete the prints, change the layer, add the prints back...

With trickle, you run your code once and every variable's shape is visible:

```python
def forward(self, x: Tensor[128, 2] float32):
    x: Tensor[128, 256] float32  = self.relu(self.bn0(self.embed(x)))
    x: Tensor[128, 16, 16] float32  = x.view(x.size(0), 16, 16)
    x: Tensor[128, 32, 16] float32  = self.relu(self.bn1(self.conv1(x)))
    x: Tensor[128, 64, 16] float32  = self.gelu(self.ln2(self.conv2(x)))
    x: Tensor[128, 128, 16] float32  = self.relu(self.bn3(self.conv3(x)))
    x: Tensor[128, 64, 7] float32  = self.gelu(self.bn4(self.conv4(x)))
    x: Tensor[128, 32, 3] float32  = self.relu(self.ln5(self.conv5(x)))
    x: Tensor[128, 96] float32  = x.flatten(1)
    x: Tensor[128, 64] float32  = self.gelu(self.ln6(self.fc1(x)))
    return self.fc2(x)
```

No print statements. No debugger. Just run and look.

## When your code crashes

You don't just see the error — you see what every variable held at the moment of the crash:

```python
data_dir: PosixPath = Path("../data/gaitpdb/1.0.0")
excluded_files: unknown[] = []
data_file_paths: string[] = [p for p in os.listdir(data_dir) if '.txt' in p]

for file_path: string = "demographics.txt" in data_file_paths:
    with open(data_dir / file_path, 'r') as data:
        patient_gait_data: string[] = data.readlines()
        parsed_data = [[float(d) for d in time.split('\t')] for time in patient_gait_data]
        ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
        <- ValueError: could not convert string to float: 'ID'
```

`file_path` is `"demographics.txt"`. `patient_gait_data` is `string[]` — it has headers, not numbers. Bug found in seconds without adding a single log statement.

## Try it now

```bash
pip install trickle-observe
npm install -g trickle-cli

git clone https://github.com/yiheinchai/trickle.git && cd trickle
trickle run python demo/demo.py
trickle hints demo/demo.py
```

For VSCode inline hints, install the extension: `code --install-extension yiheinchai.trickle-vscode`

## Usage

**Scripts:**
```bash
trickle run python train.py     # run with tracing
trickle hints                   # see types inline in source
trickle hints --errors          # crash-time values + error underline
```

**Jupyter Notebooks:**
```python
%load_ext trickle               # first cell — all subsequent cells are traced
```

**Terminal (for AI agents):**
```bash
trickle hints --errors --show types     # types only
trickle hints --errors --show values    # values only
trickle hints --errors --show both      # both (default)
```

## What gets traced

- Every variable assignment — simple, for-loops, function parameters, tuple unpacking, with-as
- Imported local modules — not just the entry file
- PyTorch tensors — shape, dtype, device, memory, gradient norms
- NumPy arrays, pandas DataFrames/Series
- Any Python object — type name and properties

## How it works

Trickle rewrites your Python source via AST transformation before execution. After every variable assignment, it inserts a lightweight call that captures the type and a sample value, then writes to `.trickle/variables.jsonl`. The VSCode extension watches this file and renders inline hints.

Only your code is traced — stdlib, site-packages, and library internals (torch, numpy, pandas) are skipped. No code changes. No decorators. No type annotations required.

## FAQ

**Why does a Python tool need npm?**
The Python package (`trickle-observe`) does the runtime tracing. The npm package (`trickle-cli`) provides the `trickle run` and `trickle hints` CLI commands that parse and display the results. The CLI is TypeScript because it also supports JavaScript/TypeScript projects. You can use trickle without the CLI — in Jupyter notebooks, `%load_ext trickle` is all you need.

**How much does it slow my code?**
The tracing adds overhead — expect 2-5x slowdown depending on how many variables are assigned. It's designed for development and debugging, not production.

**Does it work without VSCode?**
Yes. `trickle hints` outputs annotated source in the terminal. No editor needed.

## Documentation

- **[ML Engineer Guide](usecases/ml-engineer.md)** — tensor shapes, training loops, Jupyter notebooks
- **[AI Agent Guide](usecases/ai-agent.md)** — runtime context for debugging unfamiliar code
- **[All Features](docs.md)** — exhaustive documentation of every component
