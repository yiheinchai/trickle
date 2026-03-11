/**
 * Entry file with functions defined directly (not in a module).
 * Deep observation should capture these — previously invisible to trickle.
 */
const helpers = require('./test-deep-helpers');

// Functions defined in the ENTRY FILE — previously invisible
function validateEmail(email) {
  const parts = email.split('@');
  return {
    valid: parts.length === 2 && parts[1].includes('.'),
    local: parts[0],
    domain: parts[1] || '',
  };
}

function summarizeUsers(users) {
  const totalAge = users.reduce((sum, u) => sum + u.age, 0);
  return {
    count: users.length,
    averageAge: totalAge / users.length,
    names: users.map(u => u.name),
  };
}

// Use everything
const emailCheck = validateEmail('alice@example.com');
console.log('email:', emailCheck);

const users = helpers.processUsers([
  { firstName: 'Alice', lastName: 'Smith', age: 30, email: 'ALICE@EXAMPLE.COM' },
  { firstName: 'Bob', lastName: 'Jones', age: 25, email: 'BOB@EXAMPLE.COM' },
]);
console.log('users:', users.length);

const summary = summarizeUsers(users);
console.log('summary:', summary);

console.log('Done!');
