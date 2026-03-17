# AI Agent

You're an AI agent working on code. You write correct code but fail on data you haven't seen — file formats, tensor shapes, API responses, edge cases in datasets. Trickle gives you runtime context in the terminal.

## Workflow

```bash
trickle run python app.py            # run the code
trickle hints app.py                 # see types for every variable
trickle hints --errors               # if it crashed, see exactly why
```

## Normal Mode

`trickle hints` outputs source with inline type annotations:

```python
data_dir: PosixPath = Path("../data/gaitpdb/1.0.0")
excluded_files: unknown[] = []
data_file_paths: string[] = [p for p in os.listdir(data_dir) if '.txt' in p]
tensor_list: Tensor[] = []

for file_path: string in data_file_paths:
    with open(data_dir / file_path, 'r') as data:
        patient_gait_data: string[] = data.readlines()
        parsed_data: number[][] = [[float(d) for d in time.split('\t')] for time in patient_gait_data]
        tensor_data: Tensor(shape=[12119, 19], dtype=torch.float32) = torch.tensor(parsed_data)
```

Now you know what every variable holds without running a debugger.

## Error Mode

`trickle hints --errors` shows crash-time values with an error underline:

```
# main.py — ERROR
# ValueError: could not convert string to float: 'ID' (line 20)
# Variables at crash time:
file_path: string = "demographics.txt"
patient_gait_data: string[] = ["ID\tStudy\tGroup\t..."]
    [float(d) for d in time.split('\t')] for time in patient_gait_data
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~  <- ValueError: could not convert string to float: 'ID'
```

You can immediately see: `file_path` is `"demographics.txt"` (a metadata file with headers), and `patient_gait_data` contains `"ID\tStudy\t..."` (strings, not numbers). Fix: exclude `demographics.txt`.

## Display Options

```bash
trickle hints --errors --show types        # types only (e.g., string, Tensor[32, 784])
trickle hints --errors --show values       # values only (e.g., "demographics.txt")
trickle hints --errors --show both         # both (default in error mode)
```

## Debugging Loop

1. Run `trickle run python app.py`
2. If it succeeds: `trickle hints app.py` to understand the data flow
3. If it crashes: `trickle hints --errors` to see what went wrong
4. Fix the code based on the runtime context
5. Repeat
