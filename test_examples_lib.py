"""Library for testing runtime examples in generated Python stubs."""


def calculate_discount(price, percentage):
    discount = price * (percentage / 100)
    return {
        "original": price,
        "discount": discount,
        "final": price - discount,
    }


def format_address(street, city, zip_code):
    return {
        "line1": street,
        "line2": f"{city}, {zip_code}",
        "full": f"{street}, {city}, {zip_code}",
    }


def sum_array(items):
    return {
        "items": items,
        "total": sum(items),
        "count": len(items),
    }
