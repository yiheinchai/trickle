/**
 * TypeScript app — no trickle imports.
 * Run with: node --import trickle/auto-esm test-ts-app.ts
 */
import { paginate, groupBy, retry } from './test-ts-lib.ts';

const users = [
  { name: 'Alice', role: 'admin', age: 30 },
  { name: 'Bob', role: 'user', age: 25 },
  { name: 'Charlie', role: 'admin', age: 35 },
  { name: 'Diana', role: 'user', age: 28 },
  { name: 'Eve', role: 'moderator', age: 32 },
];

const page = paginate(users, 1, 3);
console.log(`Page 1: ${page.data.length} of ${page.total} users`);

const groups = groupBy(users, 'role');
console.log(`Groups: ${Object.keys(groups).join(', ')}`);

const retried = await retry(
  async () => ({ status: 'ok', timestamp: Date.now() }),
  3,
  10,
);
console.log(`Retry result: ${retried.result.status} in ${retried.attempts} attempt(s)`);

console.log('Done!');
