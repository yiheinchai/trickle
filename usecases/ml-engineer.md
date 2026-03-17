# ML Engineer

You're building models, debugging shape mismatches, iterating in notebooks. Trickle shows tensor shapes inline — no print statements.

## Jupyter Notebook

```python
# Cell 1
%load_ext trickle

# Cell 2
import torch
import torch.nn as nn

model = nn.Linear(784, 10)
x = torch.randn(32, 784)       # -> Tensor[32, 784] float32
output = model(x)               # -> Tensor[32, 10] float32
```

Every variable gets its type inline after you run the cell. Shapes update when you re-run.

## Training Scripts

```bash
trickle run python train.py
trickle hints train.py
```

See every tensor shape in the terminal:

```python
def forward(self, x: Tensor[128, 2] float32):
    x: Tensor[128, 256] float32 = self.relu(self.bn0(self.embed(x)))
    x: Tensor[128, 16, 16] float32 = x.view(x.size(0), 16, 16)
    x: Tensor[128, 32, 16] float32 = self.relu(self.bn1(self.conv1(x)))
    x: Tensor[128, 64, 16] float32 = self.gelu(self.ln2(self.conv2(x)))
    x: Tensor[128, 128, 16] float32 = self.relu(self.bn3(self.conv3(x)))
    x: Tensor[128, 64, 7] float32 = self.gelu(self.bn4(self.conv4(x)))
    x: Tensor[128, 32, 3] float32 = self.relu(self.ln5(self.conv5(x)))
    x: Tensor[128, 96] float32 = x.flatten(1)
    x: Tensor[128, 64] float32 = self.gelu(self.ln6(self.fc1(x)))
```

## Error Debugging

When your code crashes, `trickle hints --errors` shows what every variable held at crash time:

```bash
trickle run python data_loader.py
trickle hints --errors
```

```
# data_loader.py — ERROR
# ValueError: could not convert string to float: 'ID' (line 20)
# Variables at crash time:
file_path: string = "demographics.txt"
patient_gait_data: string[] = ["ID\tStudy\tGroup\t..."]
    [float(d) for d in time.split('\t')] for time in patient_gait_data
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~  <- ValueError: could not convert string to float: 'ID'
```

## Autocomplete

When trickle knows `t` is a Tensor, typing `t.` gives completions for `shape`, `dtype`, `view`, `reshape`, `mean`, `permute`, etc. Properties are highlighted blue, methods yellow.

## What gets traced

- Tensor shapes, dtypes, devices, memory
- Simple assignments, for-loops, function parameters, tuple unpacking
- Gradient norms (via backward hook)
- Optimizer state, learning rate schedules
- Only your code — torch/numpy internals are skipped
