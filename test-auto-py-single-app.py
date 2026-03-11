"""Single-file app that uses `import trickle.auto`.
ALL functions are in THIS file — no imports from other modules.
Used by test-auto-py-single-e2e.py to verify entry file observation.
"""

# This ONE LINE is all you need:
import trickle.auto  # noqa: F401


# --- Functions defined directly in the entry file ---

def calculate_discount(price, percentage):
    discount = price * (percentage / 100)
    return {
        "original": price,
        "discount": discount,
        "final": price - discount,
        "saved": f"${discount:.2f}",
    }


def format_invoice(items, customer):
    total = sum(item["price"] * item["qty"] for item in items)
    return {
        "customer": customer["name"],
        "line_items": len(items),
        "subtotal": total,
        "tax": total * 0.08,
        "total": total * 1.08,
        "currency": "USD",
    }


def validate_address(addr):
    return {
        "valid": bool(addr.get("street") and addr.get("city") and addr.get("zip")),
        "normalized": {
            "street": (addr.get("street") or "").strip(),
            "city": (addr.get("city") or "").strip(),
            "state": (addr.get("state") or "").upper(),
            "zip": str(addr.get("zip") or "").replace(" ", ""),
        },
    }


# Exercise the functions
disc = calculate_discount(99.99, 15)
print(f"Discount: {disc['saved']}")

invoice = format_invoice(
    [
        {"name": "Widget", "price": 25, "qty": 4},
        {"name": "Gadget", "price": 50, "qty": 1},
    ],
    {"name": "Alice Smith"},
)
print(f"Invoice total: {invoice['total']}")

addr = validate_address({
    "street": "123 Main St",
    "city": "Springfield",
    "state": "il",
    "zip": "62701",
})
print(f"Address valid: {addr['valid']}")

print("Done!")
