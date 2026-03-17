# trickle

Runtime context for every variable in your code — types, shapes, values, error state — without adding print statements.

It's for the development process: when you're working with unfamiliar data, iterating on code, and need to understand what's actually flowing through each line.

For example: Pytorch tensor shape annotations from runtime

![Pytorch tensor shape annotations from runtime](image.png)

```bash
pip install trickle-observe
npm install -g trickle-cli
code --install-extension yiheinchai.trickle-vscode
```

## See tensor shapes flow through your model

```python
def forward(self, x: Tensor[32, 784] float32):
    x: Tensor[32, 128] float32 = self.fc1(x)
    x: Tensor[32, 128] float32 = self.relu(x)
    x: Tensor[32, 10] float32  = self.fc2(x)
    return x
```

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

## Try it

There's a demo project in `demo/` you can run immediately:

```bash
# Script
trickle run python demo/demo.py
trickle hints demo/demo.py

# Jupyter notebook
# Open demo/demo.ipynb in VSCode, run the cells
```

## Setup

```bash
pip install trickle-observe          # runtime tracer
npm install -g trickle-cli           # CLI
code --install-extension yiheinchai.trickle-vscode  # VSCode inline hints
```

## Scripts

```bash
trickle run python train.py          # run with tracing
trickle hints                        # source with inline types
trickle hints --errors               # crash-time values + error underline
```

## Jupyter Notebooks

```python
%load_ext trickle                    # first cell, then run your code
```

Types appear inline in VSCode immediately after each cell runs.

## For AI agents

Two interfaces: VSCode inline hints for human developers, and `trickle hints` CLI output for AI agents that need runtime context in the terminal.

```bash
trickle hints --errors --show types        # types only
trickle hints --errors --show values       # values only
trickle hints --errors --show both         # both (default in error mode)
```

## Use cases

- [ML Engineer](usecases/ml-engineer.md) — tensor shapes, training loops, Jupyter notebooks
- [AI Agent](usecases/ai-agent.md) — runtime context in the terminal for debugging unfamiliar code

## How it works

Trickle rewrites your Python source via AST transformation before execution. After every variable assignment, it inserts a lightweight call that captures the type and a sample value, then writes to `.trickle/variables.jsonl`. The VSCode extension watches this file and renders inline hints.

Only your code is traced — stdlib, site-packages, torch/numpy internals are skipped. No code changes to your files. No decorators. No type annotations required.
