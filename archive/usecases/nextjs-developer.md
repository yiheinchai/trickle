# Next.js Developer

## Who they are

Full-stack engineers building web apps with Next.js App Router or Pages Router. They work with both Server Components and Client Components, and need visibility into both sides.

## Quick Start: Debugging Next.js

```bash
npm install trickle-observe
npm install -g trickle-cli

# Run your Next.js app with observability
trickle run next dev

# After hitting some pages:
trickle summary                  # errors, queries, root causes
trickle explain src/app/page.tsx # understand a file's runtime behavior
trickle test                     # run jest/vitest with structured pass/fail
trickle flamegraph               # performance hotspots
```

## Pain points without trickle

- Can't easily tell how many times a Client Component re-renders or why
- useState bugs in complex forms/modals require `console.log` in setter callbacks
- useEffect dependencies are hard to audit — hooks fire unexpectedly
- Server Components are black boxes — no visibility into what data they produce

## How trickle helps

### Setup (2 lines in next.config.js)

```javascript
// next.config.js
const { withTrickle } = require('trickle-observe/next-plugin');

const nextConfig = {
  reactStrictMode: true,
  // ... your existing config
};

module.exports = withTrickle(nextConfig);
```

Then just run `next dev` as usual — no extra process needed:
```bash
npx next dev
```

The trickle ingest server starts automatically alongside Next.js. Variable data from both server and client components flows to `.trickle/variables.jsonl`, and the VSCode extension displays inline hints.

### What gets tracked

**Client Components** (`'use client'`):
- Every variable value (const, let, destructured, reassignments, for-loop vars, catch vars, function params)
- Render counts + props every time the component re-renders
- Every `useState` setter call with the new value
- `useEffect`, `useMemo`, `useCallback` execution counts
- Data flows from browser via fetch to the auto-started ingest server (port 4889)

**Server Components** (no directive):
- Every variable value captured during SSR
- Render counts (how many times SSR/SSG renders this component per request)
- Props passed in (useful for checking what data is being threaded through)

### Example inline hints in VSCode

```tsx
// cart/cart-context.tsx
'use client';
export function CartProvider({ children }: { children: React.ReactNode }) {   // 📊 rendered ×3
  const [cart, setCart] = useState<Cart>([]);        // 📊 cart ×2 → [{id:1}]
  useEffect(() => { syncToLocalStorage(cart); }, [cart]);  // 📊 ran ×2  12ms
  ...
}

// product/product-description.tsx (Server Component)
export function ProductDescription({ product }: Props) {   // 📊 rendered ×1
  return <div>{product.description}</div>;
}
```

### Real device / production preview (via ngrok)

```bash
npx ngrok http 4888
TRICKLE_BACKEND_URL=https://your-ngrok-url npm run dev
```

## Supported component patterns

All common Next.js patterns are instrumented automatically:

```tsx
export default function Page() { ... }              // ✓ default page export
export function Navbar({ user }) { ... }            // ✓ named export
const Card: React.FC<Props> = ({ title }) => { ... } // ✓ React.FC typed
const Card = React.memo(({ data }) => { ... })      // ✓ React.memo wrapped
const Card = React.forwardRef<Ref, Props>(...)      // ✓ forwardRef
const Layout = ({ children }: Props) => (<div/>)   // ✓ concise arrow body (=> (...))
```

The concise arrow body pattern (`=> (...)`) is very common in Next.js for presentational and layout components. Previously these were invisible to trickle — they are now fully tracked.

## Customer journey

1. **Debugging a re-render storm** — a Client Component flickers. Add `withTrickle` to `next.config.js`, refresh the page, and VSCode shows `rendered ×47` inline. Now they know it's a problem.
2. **Tracking useState update source** — which event triggers a state change? The inline hint shows `isOpen ×3 → true` and the count tells them it's being set 3 times when it should be once.
3. **Server Component audit** — checking that expensive Server Components only render once per request, not per child component mount.

## Key differentiator

Works transparently for both Client and Server Components with zero code changes — just wrap `next.config.js`. No Babel config opt-out needed (uses webpack loader directly).
