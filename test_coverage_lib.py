"""Library for testing type coverage reporting.
Has 5 functions but the app only calls 3 of them.
"""


def add(a, b):
    return a + b


def subtract(a, b):
    return a - b


def multiply(a, b):
    return a * b


def divide(a, b):
    return a / b


def modulo(a, b):
    return a % b
