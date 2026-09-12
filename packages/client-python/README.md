# trickle-observe

Runtime type annotations for Python — see tensor shapes, variable types, and crash-time values as you code.

```bash
pip install trickle-observe
```

## Jupyter

```python
%load_ext trickle
```

All cells after this are traced. The VSCode extension shows inline type hints after each cell runs.

## Scripts

```bash
npm install -g trickle-cli

trickle run python train.py     # run with tracing
trickle hints                   # view source with inline types
trickle hints --errors          # crash-time values + error underline
```

Or without the CLI:

```bash
python -m trickle train.py
```

Types are written to `.trickle/variables.jsonl` for VSCode inline hints.

## What Gets Traced

- **Tensor shapes** — PyTorch (shape, dtype, device), NumPy, pandas
- **All variable assignments** — simple, for-loops, function parameters, tuple unpacking, with-as
- **Imported modules** — your local modules are traced too, not just the entry file
- **Error snapshots** — all variables at crash time

Trickle rewrites your Python source via AST transformation before execution. After every variable assignment, it captures the type and a sample value. No code changes to your files.

## Related Packages

| Package | Description |
|---------|-------------|
| [trickle-cli](https://www.npmjs.com/package/trickle-cli) | CLI for `trickle run` and `trickle hints` |
| [trickle-vscode](https://marketplace.visualstudio.com/items?itemName=yiheinchai.trickle-vscode) | VSCode extension for inline type hints |

## License

Apache-2.0
