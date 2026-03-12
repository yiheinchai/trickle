"""App that uses int and float params for testing type narrowing."""
import trickle.auto  # noqa: F401

from test_intfloat_lib import paginate, calculate_stats, mixed_types, UserService

# paginate: items=list, page=int, per_page=int
result = paginate(["a", "b", "c", "d", "e"], 1, 3)
print("paginate:", result["items"])

# calculate_stats: values=list[float/int], precision=int
stats = calculate_stats([1.5, 2.7, 3.2, 4.8], 2)
print("stats:", stats["mean"])

# mixed_types: name=str, age=int, score=float, active=bool
info = mixed_types("Alice", 30, 95.5, True)
print("mixed:", info["label"])

# Class methods
svc = UserService()
user = svc.get_user(42, True)
print("user:", user["name"])

users = svc.list_users(0, 10)
print("users:", users["total"])

print("Done!")
