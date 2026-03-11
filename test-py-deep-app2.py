"""
Entry file that also imports from a helper module.
Tests that BOTH entry file functions AND imported module functions are captured.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from test_py_deep_helpers import create_user, process_users


def validate_and_create(name, email):
    """Entry file function that uses imported helpers."""
    if not email or "@" not in email:
        return None
    return create_user(name, email)


# Run
users_data = [
    {"name": "Alice Smith", "email": "alice@example.com"},
    {"name": "Bob Jones", "email": "bob@test.org"},
]

result = validate_and_create("Test User", "test@example.com")
print(f"Created: {result}")

processed = process_users(users_data)
print(f"Processed: {len(processed)} users")

print("Done!")
