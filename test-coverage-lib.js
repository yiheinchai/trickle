/**
 * Library for testing type coverage reporting.
 * Has 5 functions but the app only calls 3 of them.
 */

function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

function divide(a, b) {
  return a / b;
}

function modulo(a, b) {
  return a % b;
}

module.exports = { add, subtract, multiply, divide, modulo };
