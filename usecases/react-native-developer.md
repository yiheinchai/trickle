# React Native Developer

## Who they are

Mobile engineers building iOS/Android apps with React Native (Expo or bare RN). Debugging is harder than web: no browser DevTools, device/simulator gap, Metro bundler (not Vite).

## Quick Start

```bash
npm install trickle-observe
npm install -g trickle-cli
code --install-extension yiheinchai.trickle-vscode
```

For backend debugging (API routes, database queries):
```bash
trickle run node server.js       # if your RN app has a backend
trickle summary                   # errors, queries, N+1 patterns
trickle test                      # run jest tests with observability
```

## Pain points without trickle

- Can't use browser DevTools — have to rely on `console.log` and Flipper
- No inline type hints showing what state values actually are at runtime
- useState bugs are hard to trace — "why did this re-render 12 times?"
- useEffect firing unexpectedly is invisible until something breaks

## How trickle helps

### Setup (2 lines in metro.config.js)

```javascript
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
// or: const { getDefaultConfig } = require('@react-native/metro-config');

const config = getDefaultConfig(__dirname);
config.transformer.babelTransformerPath = require.resolve('trickle-observe/metro-transformer');
module.exports = config;
```

Then start your trickle backend:
```bash
npx trickle dev
```

And for real device (replace with your machine's LAN IP):
```bash
TRICKLE_BACKEND_URL=http://192.168.1.5:4888 npx expo start
```

### What gets tracked automatically

Every `.tsx`/`.jsx` file in your RN app gets instrumented at build time:

**Component renders** — how many times each screen/component renders, with props:
```
📊 HomeScreen rendered ×3  props: { userId: "abc123" }
```

**useState changes** — every setter call, with the new value:
```
📊 count ×5 → 42
📊 isLoading ×2 → false
```

**Hook executions** — when useEffect/useMemo/useCallback fire:
```
📊 useEffect ×3  duration: 145ms
```

### What the developer sees in VSCode

Open any component file and see inline hints alongside the code, updated live as the app runs:

```tsx
function CheckoutScreen({ orderId }) {          // 📊 rendered ×2
  const [items, setItems] = useState([]);       // 📊 items ×3 → [{id:1},{id:2}]
  const [loading, setLoading] = useState(true); // 📊 loading ×2 → false

  useEffect(() => {                             // 📊 ran ×1  145ms
    fetchItems(orderId).then(setItems);
  }, [orderId]);
  ...
}
```

### Works with `export default function` (common RN pattern)

trickle instruments both patterns:

```tsx
// Named export (web style)
export function ProductCard({ product }) { ... }

// Default export (common React Native screen style)
export default function ProductScreen() { ... }
```

### CLI helpers

```bash
# Get step-by-step setup guide
trickle rn setup

# Find your machine's IP for real-device setup
trickle rn ip
# → LAN IP: 192.168.1.5
# → TRICKLE_BACKEND_URL=http://192.168.1.5:4888 npx expo start
```

## Customer journey

1. **Frustrated** by having to add/remove `console.log` to debug state changes on device
2. **Discovers trickle** — adds 2 lines to `metro.config.js`
3. **Starts the app** — trickle Metro transformer instruments all components at build time
4. **Opens a screen file in VSCode** — sees render counts and state values inline
5. **Spots a bug** — `useEffect` is firing 8 times instead of 1, visible in the inlay hint
6. **Fixes it** — no logging cleanup needed, hints disappear when the bug is gone

## Key differentiator vs Flipper / React DevTools

- **No separate tool window** — observations appear inline in the source file you're editing
- **Zero cleanup** — no `console.log` to remove before committing
- **Works offline** — local backend mode writes to `.trickle/` without network
- **Build-time instrumentation** — no runtime overhead for uninstrumented code paths
