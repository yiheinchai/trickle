# trickle-cli

Runtime type annotations for Python and JavaScript — see tensor shapes, variable types, and crash-time values as you code.

```bash
npm install -g trickle-cli
```

```bash
> trickle --help
Usage: trickle [options] [command]

Commands:
  init [options]              Set up trickle so you can see runtime types
  run [options] [command...]  Run a file or command with type observation
  vars [options]              Show captured variable types and sample values
  hints [options] [file]      Print source with inline runtime types
```

## Quick Start

```bash
pip install trickle-observe                         # Python runtime tracer
npm install -g trickle-cli                          # this package
code --install-extension yiheinchai.trickle-vscode  # VSCode inline hints
```

```bash
trickle run python train.py     # run with tracing
trickle hints                   # view source with inline types
```

Shorthand: `trickle train.py` is the same as `trickle run train.py`.

## Commands

### `trickle run`

Run any script with automatic variable tracing. Zero code changes needed.

```bash
trickle run python train.py
trickle run python -m pytest tests/
trickle run node app.js
trickle run app.ts
```

| Flag | Description |
|------|-------------|
| `--include <patterns>` | Only observe matching modules |
| `--exclude <patterns>` | Skip matching modules |
| `-w, --watch` | Watch and re-run on changes |

### `trickle hints`

Print source with inline type annotations — for the terminal, Jupyter, or AI agents.

```bash
trickle hints train.py                     # types for a file
trickle hints --errors                     # crash-time values + error underline
trickle hints --errors --show types        # types only
trickle hints --errors --show values       # values only
trickle hints --errors --show both         # both (default in error mode)
```

Example output:

```python
def forward(self, x: Tensor[128, 2] float32):
    x: Tensor[128, 256] float32 = self.relu(self.bn0(self.embed(x)))
    x: Tensor[128, 16, 16] float32 = x.view(x.size(0), 16, 16)
    x: Tensor[128, 32, 16] float32 = self.relu(self.bn1(self.conv1(x)))
```

Error mode:

```
# train.py — ERROR
# ValueError: could not convert string to float: 'ID' (line 20)
# Variables at crash time:
file_path: string = "demographics.txt"
patient_gait_data: string[] = ["ID\tStudy\tGroup\t..."]
    [float(d) for d in time.split('\t')] for time in patient_gait_data
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~  <- ValueError: could not convert string to float: 'ID'
```

### `trickle vars`

Table view of all captured variables.

```bash
trickle vars                     # all variables
trickle vars --tensors           # only tensors
trickle vars --file model.py     # filter by file
```

### `trickle init`

Install and set up trickle so you can see runtime types (Python or JavaScript).

```bash
trickle init
trickle init --python
```

## How It Works

Trickle rewrites your source before execution. After every variable assignment, it captures the type and a sample value, then writes to `.trickle/variables.jsonl`.

- Only your code is traced — stdlib, site-packages, torch/numpy internals are skipped
- No code changes. No decorators. No type annotations required
- The [VSCode extension](https://marketplace.visualstudio.com/items?itemName=yiheinchai.trickle-vscode) reads this file and renders inline hints

## Related Packages

| Package | Description |
|---------|-------------|
| [trickle-observe](https://pypi.org/project/trickle-observe/) | Python runtime tracer (`pip install trickle-observe`) |
| [trickle-vscode](https://marketplace.visualstudio.com/items?itemName=yiheinchai.trickle-vscode) | VSCode extension for inline type hints |

## License

Apache-2.0
