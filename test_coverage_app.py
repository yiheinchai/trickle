"""App that only calls 3 of 5 functions in test_coverage_lib."""
import trickle.auto  # noqa: F401

from test_coverage_lib import add, subtract, multiply

# Only call 3 of 5 functions
print("add:", add(10, 5))
print("subtract:", subtract(10, 5))
print("multiply:", multiply(10, 5))

# divide and modulo are NOT called — should show as untyped

print("Done!")
