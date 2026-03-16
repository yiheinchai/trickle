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

## Use Case 2: Compiled TypeScript (tsc, esbuild, webpack)

```bash
# Pre-compiled TypeScript — just run the JS output with source maps
tsc --sourceMap && trickle run node dist/app.js

# esbuild
esbuild src/index.ts --bundle --sourcemap --outfile=dist/bundle.js
trickle run node dist/bundle.js

# webpack (with devtool: 'source-map')
npx webpack && trickle run node dist/bundle.js

# ts-node (also works)
trickle run ts-node --transpile-only app.ts
```

Trickle automatically detects `.map` files and maps line numbers back to your original `.ts` source — even for webpack bundles with multiple source files. Open the `.ts` file in VSCode and hints appear on the correct lines.

Works with: **tsc**, **esbuild**, **webpack**, **rollup**, **ts-node**, **tsx** — any tool that produces standard source maps.

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

## Use Case 3: Node.js Backend (Express, Fastify, Koa, Hono)

```bash
trickle run node server.js
```

Works with all major Node.js frameworks — no code changes needed:

**Express:**
```javascript
app.get('/api/users', async (req, res) => {
  const query = req.query;
  // → query: { page: string; limit: string; filter?: string }
  const users = await db.users.findMany({ where: buildFilter(query) });
  // → users: Array<{id: number; name: string; email: string; role: string}>
  res.json({ users, total: users.length });
});
```

**Fastify:**
```javascript
app.get('/api/users', async (request, reply) => {
  const users = await db.users.findMany();
  // → users: Array<{id: number; name: string; email: string}>
  return { users, total: users.length };
  // → { users: User[]; total: number }
});
```

**Koa (with @koa/router):**
```javascript
router.get('/api/users', async (ctx) => {
  const users = await db.users.findMany();
  // → users: Array<{id: number; name: string; email: string}>
  ctx.body = { users, total: users.length };
});
```

Or use explicit instrumentation in your code:
```javascript
import { instrument } from 'trickle';
instrument(app);  // Auto-detects Express, Fastify, or Koa
```

**Hono (edge/serverless):**
```javascript
app.get('/api/users', (c) => {
  const users = await db.users.findMany();
  // → users: Array<{id: number; name: string; email: string}>
  return c.json({ users, total: users.length });
});
```

Framework-specific imports are also available:
```javascript
import { instrumentHono } from 'trickle';       // Hono
import { instrumentFastify } from 'trickle';    // Fastify
import { instrumentKoa } from 'trickle';        // Koa
import { instrumentExpress } from 'trickle';    // Express
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

**React component render count hints:**

Trickle also tracks how many times each component re-renders and shows it as an inlay hint on the component definition line — zero instrumentation required:

```tsx
// src/components/UserCard.tsx
function UserCard({ userId }: { userId: number }) {  // 🔄 ×12 renders
  const [user, setUser] = useState(null);
  // → user: {id, name, email, role} | null
  ...
}

const Dashboard = () => {  // 🔄 ×3 renders
  return <div>...</div>;
};
```

Hover over the hint to see the component name and cumulative render count since the dev server started. Useful for spotting unnecessary re-renders without adding any `console.log` or profiler setup.

**Re-render cause detection:**

When a component re-renders, trickle shows *which prop changed* directly in the inlay hint — the most actionable performance insight for React developers:

```tsx
function UserCard({ userId, name, theme }) {  // 🔄 ×5 | userId: 1→2
  ...
}

const ProductRow = ({ price, inStock }) => {  // 🔄 ×3 | ↑inStock
  ...
};
```

- Primitives (number, string, boolean): shows `prop: old→new` (e.g. `count: 0→1`)
- Objects/arrays/functions: shows `↑propName` (changed but complex value)

Hover tooltip shows a full table of all changed props with before/after values. Instantly know why a component re-rendered — no React DevTools Profiler setup needed.

**React hook invocation tracking:**

Trickle also tracks how many times each hook's callback fires and shows it as an inlay hint on the hook call line — zero instrumentation required:

```tsx
// src/components/Dashboard.tsx
function Dashboard({ userId }) {
  useEffect(() => {         // ⚡ ran ×3
    fetchUser(userId);
  }, [userId]);

  const name = useMemo(() => {   // 💾 computed ×1
    return formatName(user);
  }, [user]);

  const handleClick = useCallback(() => {  // 🎯 called ×5
    doAction();
  }, []);
}
```

- `useEffect` → ⚡ ran ×N: each invocation means deps changed (or first mount)
- `useMemo` → 💾 computed ×N: each invocation is a cache miss (expensive recalculation)
- `useCallback` → 🎯 called ×N: each invocation means the memoized callback was actually invoked

Hover over the hint for a tooltip explaining what it means. Instantly spot hooks running more than expected — no React DevTools setup required.

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

## Use Case 8: Running Tests with Observability

### Option A: `trickle test` (recommended for quick insights)

```bash
trickle test                     # auto-detects jest, vitest, pytest, mocha
trickle test "npm test"          # specific command
trickle test "npx vitest run"   # vitest specifically
trickle test --json              # structured output for automation
```

Returns structured pass/fail with observability data:
```
Tests:  8 passed | 1 failed | 0 skipped | 9 total
Failures:
  ✗ test_app.test.js > should return user by id
    Expected 200 but got 404
    Queries: 3 captured
    Variables: 5 captured near failure
Observability:
  10 functions | 25 queries | 1 errors | 2 alerts
  ⚠ N+1 query pattern detected
```

### Option B: Vitest with inline type hints (IDE integration)

Add the trickle Vite plugin for inline variable hints in test files:

```typescript
// vitest.config.ts (or vite.config.ts)
import { defineConfig } from 'vitest/config';
import { tricklePlugin } from 'trickle-observe/vite-plugin';

export default defineConfig({
  plugins: [tricklePlugin()],
  test: { environment: 'node' },
});
```

```bash
npx vitest run
```

Now open test files in VSCode — inline type hints appear:

```typescript
describe('filterActiveUsers', () => {
  it('filters by role', () => {
    const result = filterActiveUsers(testUsers, 'admin');
    // → result: {filtered: User[], count: number, names: string[]}
    const adminCount = result.count;
    // → adminCount: 2
  });
});
```

### Option C: Run your app directly for full observability

For the richest data (database queries, call traces, errors with context):

```bash
trickle run node app.js     # run the app
# hit some endpoints, then check:
trickle summary             # full overview with root causes
trickle explain app.js      # understand the file
trickle flamegraph           # performance hotspots
```

This captures everything: functions, queries, variables, errors, logs, HTTP requests, memory profile.

> **Note**: Jest/Vitest worker processes use isolated module systems, so database query
> observation doesn't work inside test files. For full DB observability, use Option C.

---

## Tips

- **Reload hints**: If you re-run your code, type hints update automatically (VSCode watches the `.trickle/` folder)
- **Hover for details**: Hover over any type hint to see sample values and full type information
- **Arrow functions**: Variables inside arrow functions are traced too
- **Destructuring**: `const { a, b } = obj` traces both `a` and `b`
- **Framework routes**: Express, Fastify, and Koa route handler parameters and response shapes are captured automatically
