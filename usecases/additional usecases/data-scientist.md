# Data Scientist / Analyst: See Your DataFrames Without Printing

You're wrangling data in Jupyter — merging DataFrames, filtering Series, reshaping columns. Instead of `print(df.shape)` and `df.head()` after every operation, trickle shows you the shape, dtypes, memory, and null counts inline.

## Install

```bash
pip install trickle-observe
npm install -g trickle-cli
code --install-extension yiheinchai.trickle-vscode
```

## Jupyter Notebook

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

## Scripts

```bash
trickle run python etl_pipeline.py
trickle hints etl_pipeline.py
```

## Exploring Unfamiliar Datasets

```python
%load_ext trickle

df = pd.read_csv("mystery_data.csv")
# → DataFrame(50000 rows x 45 cols, 18.2 MB, 1205 nulls)

for col in df.columns[:5]:
    s = df[col]
    # Each iteration shows: Series(50000, dtype, "col_name", nulls/stats)
```
