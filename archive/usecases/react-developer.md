# React Developer: See Every Variable Value Inline While You Develop

When working on a React app, you need to understand what data flows through your components — props, state, computed values, API responses. Instead of sprinkling `console.log` everywhere, trickle shows you inline hints for every variable, right in your editor.

## Install

```bash
npm install trickle-observe
npm install -g trickle-cli       # for CLI commands (summary, explain, test, flamegraph)
```

Install the VSCode extension: search for "Trickle" in the marketplace, or:

```bash
code --install-extension yiheinchai.trickle-vscode
```

## Debugging Your React App

Beyond inline hints, trickle gives you full runtime observability:

```bash
trickle run node server.js       # capture backend data (Express/Next.js API routes)
trickle summary                   # errors, queries, N+1 patterns, root causes
trickle explain src/api.ts        # functions, call graph, data flow
trickle test                      # run jest/vitest with structured pass/fail
trickle flamegraph                # performance hotspots
```

## Setup (Vite)

Add the trickle plugin to your `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tricklePlugin } from 'trickle-observe/vite-plugin';

export default defineConfig({
  plugins: [
    react(),
    tricklePlugin(),
  ],
});
```

That's it. Start your dev server normally (`npm run dev`) and use your app.

## What You See

### Every variable, every file

Open any `.tsx` file in VSCode and you'll see inline hints showing the runtime value of every variable:

```tsx
function ProductCard({ product, onAdd }) {
  // You'll see inline hints like:
  const price = product.price * 1.1;          // price: 21.99
  const label = `${product.name} - $${price}`; // label: "Widget - $21.99"
  const inStock = product.quantity > 0;        // inStock: true
  const tags = product.tags.slice(0, 3);       // tags: ["sale", "new", "featured"]

  const discounted = useMemo(() => {
    const rate = product.discount ?? 0;        // rate: 0.15
    return price * (1 - rate);                 // (return): 18.69
  }, [price, product.discount]);
  // discounted: 18.69

  // ...
}
```

### Component render tracking

See how many times each component renders and which props changed:

```tsx
// App ×3 renders  props: { theme: "dark" }
function App({ theme }) {
  // ...
}

// UserCard ×12 renders  changed: [name: "Alice" → "Bob"]
function UserCard({ name, email }) {
  // ...
}
```

### useState tracking

See every state update — what value was set and how many times:

```tsx
const [count, setCount] = useState(0);
// count: 5  (updated 5×)

const [query, setQuery] = useState('');
// query: "react hooks"  (updated 3×)
```

### Hook tracking

See how many times useEffect/useMemo/useCallback fire:

```tsx
useEffect(() => {
  fetchData(userId);
}, [userId]);
// useEffect ×2 invocations

const filtered = useMemo(() => {
  return items.filter(i => i.active);
}, [items]);
// useMemo ×4 invocations  filtered: [{id: 1, ...}, {id: 2, ...}]
```

## Use Case 1: Debugging Data Flow

You're building a dashboard that fetches data from an API and passes it through several components. Instead of adding console.log at every step, just look at the inline hints:

```
App.tsx:        const data = await fetch(...)    // data: {users: [{...}, {...}], total: 42}
App.tsx:        const sorted = data.users.sort() // sorted: [{name: "Alice"}, {name: "Bob"}]
UserList.tsx:   const filtered = ...             // filtered: [{name: "Alice"}]
UserCard.tsx:   const initials = ...             // initials: "AL"
```

You can trace the data from API response → parent component → child component → computed value, all without leaving your editor.

## Use Case 2: Understanding Re-renders

Your app feels slow. The inline hints show you:

```
ProductList ×47 renders  changed: [products: [arr:100] → [arr:100]]
```

47 renders with the same products array? That means the parent is creating a new array reference on every render. You can see exactly which props changed and why.

## Use Case 3: Onboarding to an Existing Codebase

You just joined a team and need to understand a complex React app. Run it with trickle and click around — every file shows you what the real data looks like at runtime. No need to read docs or trace through code mentally.

## Setup (Next.js)

```javascript
// next.config.js
const { withTrickle } = require('trickle-observe/next-plugin');

module.exports = withTrickle({
  // ...your existing Next.js config
});
```

## Setup (React Native / Expo)

```javascript
// metro.config.js
const { trickleMetroTransformer } = require('trickle-observe/metro-transformer');

module.exports = {
  transformer: {
    babelTransformerPath: trickleMetroTransformer,
  },
};
```

## Quick Setup with CLI

Instead of manually editing config files, use `trickle init`:

```bash
npm install trickle-observe
npx trickle init
# → auto-detects Vite/Next.js/Remix, configures the plugin, and shows next steps
npm run dev
```

## Use Case 4: Live-Updating Values

Variables update in real-time as you interact with your app. Click a button and the inline hint for `count` changes from `0` to `1` to `2`:

```tsx
const [count, setCount] = useState(0);
// count: 2  ← updates live as you click!
```

This works because the tracer uses value-aware dedup — when a variable's value changes, the new value is immediately captured and the VSCode extension shows the latest.

## Use Case 5: JSX Expression Values

See what expressions inside JSX evaluate to, without leaving the template:

```tsx
return (
  <div>
    <h1>{title}</h1>           {/* title: "My App" */}
    <p>{user.email}</p>        {/* user.email: "alice@example.com" */}
    <span>({count})</span>     {/* count: 42 */}
    <p>{isAdmin ? 'Admin' : 'User'}</p>  {/* "Admin" */}
  </div>
);
```

Simple expressions (identifiers, property accesses, ternaries) are traced using the comma operator — the original JSX output is completely unchanged.

## Setup (Remix)

Remix v2 uses Vite, so the standard Vite plugin works:

```typescript
// vite.config.ts
import { tricklePlugin } from 'trickle-observe/vite-plugin';

export default defineConfig({
  plugins: [remix(), tricklePlugin()],
});
```

Remix loaders, actions, and components are all traced automatically.

## How It Works

1. The Vite/Next.js plugin transforms your source code at dev time, inserting lightweight tracing calls after every variable declaration, reassignment, for-loop, function parameter, catch clause, and JSX expression
2. When your React app runs in the browser:
   - **Vite**: values are sent via WebSocket (HMR channel) to the dev server
   - **Next.js**: values are sent via `fetch()` to an auto-started ingest server (port 4889)
3. The server writes the data to `.trickle/variables.jsonl`
4. The VSCode extension watches this file and updates inline hints in real-time

No runtime overhead in production — the plugin only runs in dev mode.
