"""
Entry file with functions defined directly in the script.
Trickle should capture ALL of these via AST transformation.
"""


def validate_email(email):
    """Check if an email address looks valid."""
    if not email or "@" not in email:
        return {"valid": False, "reason": "missing @"}
    parts = email.split("@")
    if len(parts) != 2 or not parts[1]:
        return {"valid": False, "reason": "invalid format"}
    return {"valid": True, "reason": None}


def format_user(name, email, role="user"):
    """Format a user dict from components."""
    return {
        "displayName": name.strip().title(),
        "email": email.lower(),
        "role": role,
        "initials": "".join(w[0].upper() for w in name.split() if w),
    }


def summarize_users(users):
    """Produce a summary from a list of user dicts."""
    if not users:
        return {"total": 0, "roles": {}, "domains": []}
    roles = {}
    domains = set()
    for u in users:
        r = u.get("role", "unknown")
        roles[r] = roles.get(r, 0) + 1
        email = u.get("email", "")
        if "@" in email:
            domains.add(email.split("@")[1])
    return {
        "total": len(users),
        "roles": roles,
        "domains": sorted(domains),
    }


def process_batch(items):
    """Process a batch of items — validates, formats, and summarizes."""
    results = []
    for item in items:
        check = validate_email(item.get("email", ""))
        if check["valid"]:
            formatted = format_user(
                item.get("name", "Unknown"),
                item["email"],
                item.get("role", "user"),
            )
            results.append(formatted)
    return summarize_users(results)


# Run the main logic
users = [
    {"name": "Alice Smith", "email": "alice@example.com", "role": "admin"},
    {"name": "Bob Jones", "email": "bob@test.org", "role": "user"},
    {"name": "Carol White", "email": "carol@example.com", "role": "user"},
    {"name": "Bad Email", "email": "nope", "role": "user"},
]

print("Validating emails...")
for u in users:
    result = validate_email(u["email"])
    print(f"  {u['email']}: {result}")

print("\nFormatting users...")
for u in users:
    formatted = format_user(u["name"], u["email"], u.get("role", "user"))
    print(f"  {formatted['displayName']} ({formatted['initials']})")

print("\nProcessing batch...")
summary = process_batch(users)
print(f"  Total valid: {summary['total']}")
print(f"  Roles: {summary['roles']}")
print(f"  Domains: {summary['domains']}")

print("\nDone!")
