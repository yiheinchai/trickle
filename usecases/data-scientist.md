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
| **Sklearn models** | type, hyperparams, fitted status, features/classes |
| **Sklearn Pipeline** | step names, fitted status |
| **NumPy arrays** | shape, dtype, memory |
| **HF Dataset** | rows, columns, features (types), split, format |
| **HF DatasetDict** | splits with row counts, columns |

## Use Case 2: Python Scripts

Add one import at the top of your script:

```python
import trickle.auto

df = pd.read_csv("data.csv")       # → DataFrame(10000 rows x 12 cols, 1.2 MB)
X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)
# → X_train: DataFrame(8000 rows x 6 cols), y_test: Series(2000, int64)

rf = RandomForestClassifier(n_estimators=100, max_depth=5)
rf.fit(X_train, y_train)           # → RandomForestClassifier(...) [fitted, 6 features, 2 classes]

acc = accuracy_score(y_test, rf.predict(X_test))
# → acc: 0.9900
```

All variables are traced automatically — DataFrames, Series, sklearn models (including fitted status after `.fit()`), accuracy scores, and more. Open the file in VSCode and inline hints appear everywhere.

Or from the CLI without any code changes:

```bash
trickle run python etl_pipeline.py
```

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

## Use Case 4: Scikit-learn Model Training

```python
%load_ext trickle
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline

model = RandomForestClassifier(n_estimators=100, max_depth=5)
# → RandomForestClassifier(n_estimators=100, max_depth=5, criterion=gini)

model.fit(X_train, y_train)
# → RandomForestClassifier(n_estimators=100, max_depth=5, criterion=gini) [5 features, 2 classes]

pipe = Pipeline([('scaler', StandardScaler()), ('clf', model)])
pipe.fit(X_train, y_train)
# → Pipeline(scaler → clf) [5 features, 2 classes]
```

Models show their key hyperparameters at a glance, and after fitting you see the number of features and classes. Pipelines show the step flow with `→` arrows.

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
