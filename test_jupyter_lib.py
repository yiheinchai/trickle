"""Library with functions for testing Jupyter/IPython observation."""


def analyze_data(values):
    total = sum(values)
    mean = total / len(values) if values else 0
    return {"total": total, "mean": mean, "count": len(values)}


def format_report(title, data):
    return {
        "title": title,
        "summary": f"{title}: {data['count']} items, mean={data['mean']:.2f}",
        "data": data,
    }


class DataProcessor:
    def normalize(self, values, scale=1.0):
        max_val = max(values) if values else 1
        return {"normalized": [v / max_val * scale for v in values], "scale": scale}

    def describe(self, values):
        return {
            "min": min(values),
            "max": max(values),
            "range": max(values) - min(values),
        }
