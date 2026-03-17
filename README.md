# trickle

You're writing Python. Your code crashes. You don't know what `data` looks like on line 18, what shape `x` is on line 32, or why `file_path` is wrong on line 11. So you add `print(data)`, `print(x.shape)`, `print(file_path)`, run it again, read the output, delete the prints, repeat.

Trickle eliminates this. Run your code once, and every variable's type, shape, and value is captured — visible inline in VSCode or in the terminal.

## The tensor shape problem

You're building a neural network. Every layer transforms the shape. You can't see it unless you print:

```python
def forward(self, x):
    x = self.fc1(x)        # what shape is x now?
    x = self.relu(x)       # still the same?
    x = self.fc2(x)        # does this match the next layer?
    return x
```

With trickle, the shapes are right there:

```python
def forward(self, x: Tensor[32, 784] float32):
    x: Tensor[32, 128] float32 = self.fc1(x)
    x: Tensor[32, 128] float32 = self.relu(x)
    x: Tensor[32, 10] float32  = self.fc2(x)
    return x
```

Every layer, every shape, every dtype. No print statements. No debugger. Just run your code and look.

## The debugging problem

Your code crashes. You don't know which variable is wrong. Without trickle:

```python
data_dir = Path("../data/gaitpdb/1.0.0")
excluded_files = []
data_file_paths = [p for p in os.listdir(data_dir) if '.txt' in p]

for file_path in data_file_paths:
    with open(data_dir / file_path, 'r') as data:
        patient_gait_data = data.readlines()
        parsed_data = [[float(d) for d in time.split('\t')] for time in patient_gait_data]
        # ValueError: could not convert string to float: 'ID'
        # Which file? What's in patient_gait_data? You have no idea.
```

With trickle, every variable's value at crash time is visible:

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

Now you can see: `file_path` is `"demographics.txt"`, `patient_gait_data` is `string[]` (it has headers, not numbers). Bug found in seconds, zero print statements added.

## Setup (30 seconds)

```bash
pip install trickle-observe          # Python runtime tracer
npm install -g trickle-cli           # CLI for trickle run / trickle hints
```

Install the VSCode extension: search "trickle" in Extensions (Cmd+Shift+X), publisher `yiheinchai`.

## Usage

### Scripts

```bash
trickle run python train.py          # run with tracing
trickle hints                        # view source with inline types
trickle hints --errors               # view crash-time values + error underline
```

### Jupyter Notebooks

Add this as your first cell:

```python
%load_ext trickle
```

Every cell after this is traced. Types appear inline in VSCode immediately after each cell runs.

### What you see in VSCode

Every variable gets an inline type hint after you run your code:

```python
x = torch.randn(4, 8)              # -> Tensor[4, 8] float32
w = torch.randn(16, 8)             # -> Tensor[16, 8] float32
h = x @ w.T                        # -> Tensor[4, 16] float32
model = nn.Linear(784, 10)         # -> Linear(in_features=784, out_features=10)
loss = F.cross_entropy(out, y)     # -> Tensor[] float32
```

This works for:
- Simple assignments (`x = ...`)
- For-loops (`for batch in loader`)
- Function parameters (`def forward(self, x)`)
- Tuple unpacking (`B, T, C = x.size()`)
- With-as (`with open(...) as f`)

When your code crashes, trickle switches to error mode — showing each variable's crash-time value on its assignment line, not stacked on the error line.

Typing `t.` when trickle knows `t` is a Tensor gives autocomplete for `shape`, `dtype`, `view`, `reshape`, `mean`, etc. Properties appear blue, methods yellow — just like when Pylance knows the type.

### What you see in the terminal

For AI agents and terminal workflows:

```bash
trickle hints train.py                     # types only
trickle hints --errors                     # crash-time values + error underline
trickle hints --errors --show types        # types only in error mode
trickle hints --errors --show values       # values only
trickle hints --errors --show both         # both (default)
trickle vars --tensors                     # table of all tensors
```

## How it works

Trickle rewrites your Python source via AST transformation before execution. After every variable assignment, it inserts a lightweight call that captures the type and a sample value, then writes to `.trickle/variables.jsonl`. The VSCode extension watches this file and renders inline hints.

- Only your code is traced — stdlib, site-packages, torch/numpy internals are skipped
- Same value at the same line is deduplicated — loops don't explode the data file
- Imported local modules are also traced via a `sys.meta_path` hook
- No code changes to your files. No decorators. No type annotations required.
