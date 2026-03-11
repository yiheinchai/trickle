/**
 * Second run: calls the SAME functions with ADDITIONAL properties.
 * Used by test-accumulate-e2e.js to test type accumulation.
 *
 * processOrder now receives a `coupon` field and `priority` field.
 * formatUser now receives an `avatar` field and `verified` field.
 */

function processOrder(order) {
  let total = order.items.reduce((s, i) => s + i.price * i.qty, 0);
  if (order.coupon) total *= 0.9;
  return {
    orderId: order.id,
    total,
    itemCount: order.items.length,
    currency: "USD",
    discounted: Boolean(order.coupon),
  };
}

function formatUser(user) {
  return {
    displayName: user.name,
    email: user.email,
    role: user.isAdmin ? "admin" : "member",
    avatarUrl: user.avatar || null,
  };
}

// Run 2: extended shapes
const result2 = processOrder({
  id: 202,
  items: [
    { name: "Gadget", price: 24.99, qty: 1 },
    { name: "Doohickey", price: 14.99, qty: 3 },
  ],
  coupon: "SAVE10",
  priority: "express",
});
console.log("Order:", result2.orderId, result2.total, "discounted:", result2.discounted);

const user2 = formatUser({
  name: "Bob",
  email: "bob@example.com",
  avatar: "https://example.com/bob.png",
  isAdmin: true,
});
console.log("User:", user2.displayName, "role:", user2.role);

console.log("Run2 Done!");
