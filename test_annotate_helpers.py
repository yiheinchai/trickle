"""Helper module for annotate e2e test — Python functions without type annotations."""


def parse_config(raw):
    return {
        "host": raw.get("host", "localhost"),
        "port": raw.get("port", 3000),
        "debug": raw.get("debug", False),
    }


def process_items(items):
    return [{"id": item["id"], "name": item["name"].upper(), "processed": True} for item in items]


def calculate_total(prices, tax_rate):
    subtotal = sum(prices)
    return {"subtotal": subtotal, "tax": subtotal * tax_rate, "total": subtotal * (1 + tax_rate)}
