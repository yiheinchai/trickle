/**
 * Helper module with BOTH exported and non-exported functions.
 * Deep observation should capture ALL of these, not just the exports.
 */

// This internal helper is NOT exported — previously invisible to trickle
function formatName(first, last) {
  return `${first} ${last}`.trim();
}

// This internal helper is NOT exported
function clampAge(age) {
  if (age < 0) return 0;
  if (age > 150) return 150;
  return age;
}

// Exported function — always visible
function createUser(data) {
  return {
    name: formatName(data.firstName, data.lastName),
    age: clampAge(data.age),
    email: data.email.toLowerCase(),
    createdAt: new Date().toISOString(),
  };
}

// Exported function that uses internal helpers
function processUsers(users) {
  return users.map(u => createUser(u));
}

module.exports = { createUser, processUsers };
