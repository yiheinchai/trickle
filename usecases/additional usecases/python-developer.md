# Python Developer

Run your Python code, see every variable's type and value inline — in VSCode or in the terminal. No decorators. No type annotations.

## Install

```bash
pip install trickle-observe
npm install -g trickle-cli
code --install-extension yiheinchai.trickle-vscode
```

## Scripts

```bash
trickle run python app.py
trickle hints app.py
trickle vars
```

`trickle hints` prints the source with runtime types inline. `trickle hints --errors` shows crash-time values.

## Jupyter

```python
%load_ext trickle
```

Types appear inline in VSCode after each cell runs.

## VSCode

The extension reads `.trickle/variables.jsonl` and shows:

- Inline type hints after assignments
- Hover with full type, shape, and sample value
- Error mode: crash-time values on each variable's assignment line
