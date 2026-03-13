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

## Use Case 4: React / Next.js (via Node.js script)

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

## Use Case 5: Understand Unfamiliar Code

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

## Quick Start

```bash
# Install
npm install -g trickle-cli

# Run any JS file
trickle run node app.js

# Run TypeScript
trickle run ts-node --transpile-only app.ts

# Open the file in VSCode — type hints appear inline
```

---

## Tips

- **Reload hints**: If you re-run your code, type hints update automatically (VSCode watches the `.trickle/` folder)
- **Hover for details**: Hover over any type hint to see sample values and full type information
- **Arrow functions**: Variables inside arrow functions are traced too
- **Destructuring**: `const { a, b } = obj` traces both `a` and `b`
- **Express routes**: Route handler parameters and response shapes are captured automatically
