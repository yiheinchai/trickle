"""Plain app with NO trickle imports.
Instrumented externally: python -m trickle.auto_run test_zerocode_app.py
"""

from test_zerocode_lib import parse_csv, slugify, merge_config

csv_data = parse_csv("name,age,city\nAlice,30,NYC\nBob,25,LA", ",")
print(f"Parsed {csv_data['row_count']} rows")

slug = slugify("Hello World! This is a Test")
print(f"Slug: {slug['slug']}")

config = merge_config(
    {"host": "localhost", "port": 3000, "debug": False},
    {"port": 8080, "debug": True},
)
print(f"Config keys: {config['total_keys']}")

print("Done!")
