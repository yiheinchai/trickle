"""App that exercises test_examples_lib functions for type observation."""
import trickle.auto  # noqa: F401

from test_examples_lib import calculate_discount, format_address, sum_array

d = calculate_discount(99.99, 15)
print("discount:", d["final"])

a = format_address("123 Main St", "Springfield", "62704")
print("address:", a["full"])

s = sum_array([10, 20, 30, 40, 50])
print("sum:", s["total"])

print("Done!")
