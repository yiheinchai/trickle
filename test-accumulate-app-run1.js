/**
 * First run: calls functions with a basic set of properties.
 * Used by test-accumulate-e2e.js to test type accumulation.
 */

function processOrder(order) {
  return {
    orderId: order.id,
    total: order.items.reduce((s, i) => s + i.price * i.qty, 0),
    itemCount: order.items.length,
    currency: "USD",
  };
}

function formatUser(user) {
  return {
    displayName: user.name,
    email: user.email,
    role: "member",
  };
}

// Run 1: basic shapes
const result1 = processOrder({
  id: 101,
  items: [{ name: "Widget", price: 9.99, qty: 2 }],
});
console.log("Order:", result1.orderId, result1.total);

const user1 = formatUser({ name: "Alice", email: "alice@example.com" });
console.log("User:", user1.displayName);

console.log("Run1 Done!");
