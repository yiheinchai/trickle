# Data Scientist / Analyst: See Your DataFrames Without Printing

You're wrangling data in Jupyter — merging DataFrames, filtering Series, reshaping columns. Instead of `print(df.shape)` and `df.head()` after every operation, trickle shows you the shape, dtypes, memory, and null counts inline.

## Install

```bash
pip install trickle-observe
```

Then install the VSCode extension: search "trickle" in Extensions (Cmd+Shift+X), publisher `yiheinchai`.

## Use Case 1: Jupyter Notebook

**Cell 1:**
```python
%load_ext trickle
```

**Cell 2:**
```python
import pandas as pd

df = pd.read_csv("sales.csv")
# → DataFrame(10000 rows x 12 cols, 1.2 MB)

revenue = df["revenue"]
# → Series(10000, float64, "revenue")

filtered = df[df["region"] == "US"]
# → DataFrame(3200 rows x 12 cols, 389.1 KB)

grouped = df.groupby("region")["revenue"].mean()
# → Series(5, float64)
```

Every DataFrame and Series shows its dimensions, dtypes, and memory usage inline — no `print()` needed.

**Cell 3 — groupby and aggregation:**
```python
grouped = df.groupby("region")
# → DataFrameGroupBy(by=region, 5 groups, size=1800-2200)

agg = grouped["revenue"].mean()
# → Series(5, float64, "revenue", min=45000, max=62000, mean=53500)

pivot = df.pivot_table(values="revenue", index="region", columns="quarter")
# → DataFrame(5 rows x 4 cols, 399 B)
```

GroupBy objects show the number of groups and size range. Aggregation results display as Series with stats.

**Cell 4 — data cleaning:**
```python
df["price"] = df["price"].fillna(0)
# → Series(10000, float64, "price")

df = df.dropna(subset=["customer_id"])
# → DataFrame(9850 rows x 12 cols, 1.1 MB, 3 nulls)

df["date"] = pd.to_datetime(df["date"])
# → Series(9850, datetime64[ns], "date")
```

You can see null counts drop as you clean, and memory change as you convert types.

## What Gets Traced

| Data type | What you see inline |
|---|---|
| **DataFrame** | rows x cols, memory, null count |
| **Series (numeric)** | length, dtype, name, min/max/mean |
| **Series (categorical)** | length, dtype, name, unique count |
| **Series (with nulls)** | null count shown |
| **Tensors** | shape, dtype, device, memory |
| **GroupBy** | keys, ngroups, group size range |
| **Index / RangeIndex** | length, range, dtype |
| **MultiIndex** | length, level names, nlevels |
| **DatetimeIndex** | length, date range, frequency |
| **NumPy arrays** | shape, dtype, memory |

## Use Case 2: Python Scripts

No code changes needed:

```bash
trickle run python etl_pipeline.py
```

Or add one import:

```python
import trickle.auto

df = pd.read_csv("data.csv")       # DataFrame traced automatically
result = df.groupby("category").agg({"value": ["mean", "sum"]})
# Every intermediate DataFrame is captured
```

After running, `.pyi` stubs are generated with full type signatures. Your IDE knows the types of every variable.

## Use Case 3: Exploring Unfamiliar Datasets

When you inherit a dataset or pipeline and need to understand the data:

```python
%load_ext trickle

# Load and immediately see structure
df = pd.read_csv("mystery_data.csv")
# → DataFrame(50000 rows x 45 cols, 18.2 MB, 1205 nulls)

# Check individual columns
for col in df.columns[:5]:
    s = df[col]
    # Each iteration shows: Series(50000, dtype, "col_name", nulls/stats)
```

No need for `df.info()` or `df.describe()` — the type hints tell you what you're working with at a glance.

## Quick Start

```python
# In Jupyter
%load_ext trickle
import pandas as pd
df = pd.read_csv("your_data.csv")  # types appear automatically
```

```bash
# From CLI
trickle run python your_script.py
```
