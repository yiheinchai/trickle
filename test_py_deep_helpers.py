"""
Helper module imported by test-py-deep-app2.py.
Has exported and non-exported (private) functions.
"""


def create_user(name, email, role="user"):
    """Exported: create a user dict."""
    return {
        "name": _format_name(name),
        "email": email.lower(),
        "role": role,
        "id": _generate_id(name, email),
    }


def process_users(users):
    """Exported: process a list of raw user dicts."""
    return [create_user(u["name"], u["email"], u.get("role", "user")) for u in users]


def _format_name(name):
    """Non-exported: internal helper."""
    return name.strip().title()


def _generate_id(name, email):
    """Non-exported: internal helper."""
    return hash(f"{name}:{email}") % 10000
