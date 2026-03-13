# JavaScript / TypeScript Developer: Inline Type Hints Without console.log

You're writing JavaScript or TypeScript code and constantly adding `console.log(typeof x)`, `console.log(result)`, or temporary debug prints to understand what your data looks like at runtime. Trickle eliminates all of that — run your code once and get inline type hints directly in your editor.

## Install

```bash
npm install -g trickle-cli
npm install trickle-observe
```

Then install the VSCode extension: search **"trickle"** in Extensions (Cmd+Shift+X), publisher `yiheinchai`.

---

## Use Case 1: Any JavaScript File

One command. No code changes.

```bash
trickle run node app.js
```

**Before (with console.log debugging):**
```javascript
const users = fetchUsers();
console.log('users type:', typeof users, users.length);  // → users type: object 42

const filtered = users.filter(u => u.active);
console.log('filtered:', filtered.length);  // → filtered: 31

const grouped = groupByDepartment(filtered);
console.log('grouped keys:', Object.keys(grouped));  // → grouped keys: ['eng', 'sales', 'hr']
```

**After (with trickle):**
```javascript
const users = fetchUsers();       // → users: User[]
const filtered = users.filter(u => u.active);  // → filtered: User[]
const grouped = groupByDepartment(filtered);    // → grouped: { eng: User[]; sales: User[]; hr: User[] }
```

Open `app.js` in VSCode — type hints appear automatically after every variable assignment. No `console.log` needed.

---

## Use Case 2: TypeScript File (with ts-node)

```bash
trickle run ts-node --transpile-only app.ts
```

TypeScript with full type annotations? Trickle reads your original `.ts` source and maps observations back to the correct lines — even through type stripping.

```typescript
interface Order {
  id: number;
  items: Array<{product: string; qty: number; price: number}>;
  status: 'pending' | 'shipped' | 'delivered';
}

function processOrders(orders: Order[]) {
  const pending: Order[] = orders.filter(o => o.status === 'pending');
  // → pending: Order[] (3 items)

  const totalValue: number = pending.reduce(
    (sum, o) => sum + o.items.reduce((s, i) => s + i.qty * i.price, 0), 0
  );
  // → totalValue: 1247.5

  const productMap = new Map<string, number>();
  // → productMap: Map<string, number>

  return { pending, totalValue };
}
```

---

## Use Case 3: Node.js / Express Backend

```bash
trickle run node server.js
```

Your Express route handlers get typed automatically — no code changes:

```javascript
app.get('/api/users', async (req, res) => {
  const query = req.query;
  // → query: { page: string; limit: string; filter?: string }

  const users = await db.users.findMany({ where: buildFilter(query) });
  // → users: Array<{id: number; name: string; email: string; role: string}>

  const total = await db.users.count();
  // → total: 284

  res.json({ users, total, page: Number(query.page) });
  // → { users: User[]; total: 284; page: number }
});
```

---

## Use Case 4: React Components (.jsx / .tsx files)

Trickle traces variables inside React component functions directly in `.jsx`/`.tsx` files. Add the trickle Vite plugin to your project — inline type hints appear in all components automatically.

**Setup (Vite + React):**
```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tricklePlugin } from 'trickle-observe/vite-plugin';

export default defineConfig({
  plugins: [react(), tricklePlugin()],
});
```

**Your component:**
```tsx
// src/components/UserCard.tsx
import { useState, useEffect } from 'react';

export function UserCard({ userId }: { userId: number }) {
  const [user, setUser] = useState(null);
  // → user: null (then updates to: {id, name, email, +2})

  const displayName = user ? `${user.firstName} ${user.lastName}` : 'Loading...';
  // → displayName: "John Doe"

  const initials = displayName.split(' ').map(n => n[0]).join('');
  // → initials: "JD"

  return <div>{displayName}</div>;
}
```

Inline hints appear for every `const`/`let` declaration and destructured variable — including `useState` results, computed values, and mapped arrays.

**Via ESM loader (for scripts and tests without Vite):**
```bash
# Run a .jsx file with trickle tracing
node --import trickle-observe/auto-esm component-utils.jsx
```

This works for any `.jsx`/`.tsx` file — trickle strips JSX automatically (via esbuild if available), instruments the variable declarations, and writes hints to `.trickle/variables.jsonl`.

---

## Use Case 4b: React / Next.js (via Node.js script)

For React state and data processing logic:

```bash
trickle run node scripts/process-data.js
```

```javascript
// scripts/process-data.js
const rawData = require('./data/users.json');
// → rawData: Array<{id: number; name: string; ...}>

const normalized = rawData.map(user => ({
  ...user,
  displayName: `${user.firstName} ${user.lastName}`,
  initials: `${user.firstName[0]}${user.lastName[0]}`,
}));
// → normalized: Array<{id: number; ...; displayName: string; initials: string}>

const byRole = normalized.reduce((acc, user) => {
  acc[user.role] = acc[user.role] || [];
  acc[user.role].push(user);
  return acc;
}, {});
// → byRole: { admin: User[]; member: User[]; viewer: User[] }
```

---

## Use Case 5: Multi-file ESM Data Pipeline

A modern data analytics script spanning multiple ESM modules:

```bash
trickle run node analytics.mjs
```

```javascript
// analytics.mjs
import { users, projects } from './data.mjs';

const activeUsers = users.filter(u => u.active);
// → activeUsers: {id, name, email, +4}[]   (compact: 7 keys, hover for full type)

const byDepartment = activeUsers.reduce((acc, user) => {
  const dept = user.dept;
  // → dept: "eng"
  if (!acc[dept]) acc[dept] = [];
  acc[dept].push(user);
  return acc;
}, {});
// → byDepartment: {eng, data}   (shows discovered keys from runtime)

const deptStats = Object.entries(byDepartment).map(([dept, members]) => {
  const salaries = members.map(m => m.salary);
  // → salaries: number[]
  const avgSalary = salaries.reduce((sum, s) => sum + s, 0) / salaries.length;
  // → avgSalary: 133333.3333
  return { dept, headcount: members.length, avgSalary };
});
// → deptStats: {dept, headcount, avgSalary}[]
```

Both `analytics.mjs` and `data.mjs` get traced in a single run. Open either file in VSCode to see types inline.

---

## Use Case 6: Understand Unfamiliar Code

Inherited a JS codebase with no types? Run it through trickle:

```bash
trickle run node legacy-app.js
```

Open any file in VSCode — every variable and function return gets a type hint based on what the code actually produces at runtime. You can understand the data flow without reading every line.

---

## What Gets Traced

| Data type | What you see inline |
|---|---|
| **number** | Actual value: `84.5`, `42` |
| **string** | Actual value: `"hello"` (up to 40 chars) |
| **boolean** | `true` or `false` |
| **Array** | Element type: `string[]`, `User[]`, `number[]` |
| **Object** | Property types: `{id: number; name: string}` |
| **Map/Set** | `Map<string, number>`, `Set<string>` |
| **Promise** | `Promise<User[]>` |
| **null/undefined** | `null`, `undefined` |
| **Function** | `(x: number, y: number) => number` |

---

## Use Case 6: Modern ESM / .mjs Files

For modern JavaScript using ES modules (`.mjs`, `import`/`export` syntax):

```bash
trickle run node app.mjs
```

```javascript
// app.mjs
import { fetchUsers } from './api.mjs';

const users = await fetchUsers();
// → users: Array<{id: number; name: string; email: string}>

const active = users.filter(u => u.active);
// → active: Array<{id: number; name: string; email: string}>

const byDept = active.reduce((acc, u) => {
  acc[u.dept] = (acc[u.dept] || []).concat(u);
  return acc;
}, {});
// → byDept: {eng: Array<...>; sales: Array<...>}
```

ESM modules (including files using `import`/`export`) are now fully traced — both exported functions and all variable declarations.

---

## Quick Start

```bash
# Install
npm install -g trickle-cli

# Run any JS file (CJS)
trickle run node app.js

# Run modern ESM file
trickle run node app.mjs

# Run TypeScript
trickle run ts-node --transpile-only app.ts

# Open the file in VSCode — type hints appear inline
```

---

## Use Case 8: Vitest Integration — See Types While Writing Tests

Add trickle to your Vitest setup to get inline type hints in both your source files and your test files as you run them.

**Setup:**
```bash
npm install trickle-observe
```

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';  // if using React
import { tricklePlugin } from 'trickle-observe/vite-plugin';

export default defineConfig({
  plugins: [react(), tricklePlugin()],
  test: {
    environment: 'jsdom',  // or 'node'
  },
});
```

**Run your tests:**
```bash
npx vitest run
# or: npx vitest --watch
```

Now open any source file or test file in VSCode — inline type hints appear for every variable in both:

```typescript
// utils.test.ts
describe('filterActiveUsers', () => {
  it('filters by role', () => {
    const result = filterActiveUsers(testUsers, 'admin');
    // → result: {filtered: User[], count: number, names: string[]}

    const adminCount = result.count;
    // → adminCount: 2

    const adminNames = result.names;
    // → adminNames: ["Alice", "Charlie"]
  });
});
```

Trickle transforms both the source module AND the test file — so you see the types flowing from your implementation into your assertions. Useful when:
- Debugging what shape a function actually returns (vs what you expected)
- Understanding what a complex transformation produces mid-way
- Spotting when a type changes between test runs (type hash changes → new hint)

---

## Tips

- **Reload hints**: If you re-run your code, type hints update automatically (VSCode watches the `.trickle/` folder)
- **Hover for details**: Hover over any type hint to see sample values and full type information
- **Arrow functions**: Variables inside arrow functions are traced too
- **Destructuring**: `const { a, b } = obj` traces both `a` and `b`
- **Express routes**: Route handler parameters and response shapes are captured automatically
