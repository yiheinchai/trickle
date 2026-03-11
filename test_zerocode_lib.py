"""Library functions — no trickle imports.
Instrumented externally via: python -m trickle.auto_run
"""


def parse_csv(text, delimiter=","):
    lines = text.strip().split("\n")
    headers = [h.strip() for h in lines[0].split(delimiter)]
    rows = []
    for line in lines[1:]:
        vals = [v.strip() for v in line.split(delimiter)]
        rows.append(dict(zip(headers, vals)))
    return {"headers": headers, "rows": rows, "row_count": len(rows)}


def slugify(text, separator="-"):
    import re
    slug = text.lower()
    slug = re.sub(r"[^a-z0-9]+", separator, slug)
    slug = slug.strip(separator)
    return {"original": text, "slug": slug, "length": len(text)}


def merge_config(defaults, overrides):
    merged = {**defaults}
    for key, val in overrides.items():
        if val is not None:
            merged[key] = val
    return {
        "config": merged,
        "overridden_keys": [k for k in overrides if overrides[k] is not None],
        "total_keys": len(merged),
    }
