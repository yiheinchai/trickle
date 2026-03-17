<p align="center">
  <h1 align="center">trickle</h1>
  <p align="center">
    Runtime type annotations for Python — see tensor shapes, variable types, and crash-time values inline as you code.
  </p>
  <p align="center">
    <a href="https://pypi.org/project/trickle-observe/"><img src="https://img.shields.io/pypi/v/trickle-observe?label=pypi&color=blue" alt="PyPI"></a>
    <a href="https://www.npmjs.com/package/trickle-cli"><img src="https://img.shields.io/npm/v/trickle-cli?label=npm&color=red" alt="npm"></a>
    <a href="https://marketplace.visualstudio.com/items?itemName=yiheinchai.trickle-vscode"><img src="https://img.shields.io/visual-studio-marketplace/v/yiheinchai.trickle-vscode?label=vscode&color=purple" alt="VS Marketplace"></a>
    <a href="https://pypi.org/project/trickle-observe/"><img src="https://img.shields.io/pypi/pyversions/trickle-observe" alt="Python"></a>
    <a href="https://github.com/yiheinchai/trickle/blob/main/LICENSE"><img src="https://img.shields.io/github/license/yiheinchai/trickle" alt="License"></a>
  </p>
</p>

---

No more `print(x.shape)`. Run your code, see every variable's type and value inline — in VSCode or in the terminal.

![Pytorch tensor shape annotations from runtime](image.png)

## Install

```bash
pip install trickle-observe                        # Python runtime tracer
npm install -g trickle-cli                         # CLI (trickle run, trickle hints)
code --install-extension yiheinchai.trickle-vscode  # VSCode inline hints
```

## See tensor shapes flow through your model

```python
def forward(self, x: Tensor[32, 784] float32):
    x: Tensor[32, 128] float32 = self.fc1(x)
    x: Tensor[32, 128] float32 = self.relu(x)
    x: Tensor[32, 10] float32  = self.fc2(x)
    return x
```

Every layer, every shape, every dtype — visible without adding a single print statement.

## See exactly what caused a crash

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

`file_path` is `"demographics.txt"`. `patient_gait_data` is `string[]` — headers, not numbers. Bug found in seconds.

## Quick start

### Scripts

```bash
trickle run python train.py          # run with tracing
trickle hints                        # source with inline types
trickle hints --errors               # crash-time values + error underline
```

### Jupyter Notebooks

```python
%load_ext trickle                    # first cell, then run your code
```

Types appear inline in VSCode immediately after each cell runs.

### Try the demo

```bash
git clone https://github.com/yiheinchai/trickle.git
cd trickle
trickle run python demo/demo.py
trickle hints demo/demo.py
```

## For AI agents

`trickle hints` outputs source with inline types in the terminal — no VSCode needed.

```bash
trickle hints --errors --show types        # types only
trickle hints --errors --show values       # values only
trickle hints --errors --show both         # both (default in error mode)
```

## Use cases

- **[ML Engineer](usecases/ml-engineer.md)** — tensor shapes, training loops, Jupyter notebooks
- **[AI Agent](usecases/ai-agent.md)** — runtime context in the terminal for debugging unfamiliar code

## How it works

Trickle rewrites your Python source via AST transformation before execution. After every variable assignment, it inserts a lightweight call that captures the type and a sample value, then writes to `.trickle/variables.jsonl`. The VSCode extension watches this file and renders inline hints.

- Only your code is traced — stdlib, site-packages, torch/numpy internals are skipped
- No code changes to your files. No decorators. No type annotations required
- Same value at the same line is deduplicated — loops don't explode the data file

## Documentation

- [Features](features.md)
- [ML Engineer Guide](usecases/ml-engineer.md)
- [AI Agent Guide](usecases/ai-agent.md)

## Additional Documentation

- [Full Features - including TS/JS and React support](archive/pre_steve_jobs_features.md)
- [Full Usecases](usecases/additional%20usecases/)
- [FULL DOCS](docs.md)
