# trickle

Runtime type observability for JavaScript and Python applications. A drop-in replacement for CloudWatch and Datadog that captures the actual types and data flowing through your functions at runtime — then lets you explore them through a CLI.

Instead of logs, trickle gives you a type-cache system: it records the input types, output types, and accessed properties of every instrumented function as real traffic flows through. When something breaks, you see exactly what types were in play at the point of failure, alongside a sample of the actual data.

```
$ npx trickle errors 1

  ━━━ Error Detail ━━━

   TypeError    prod

  Cannot read property 'email' of undefined
  2m ago (2026-03-10 14:32:01)

  ── Stack Trace ──

    TypeError: Cannot read property 'email' of undefined
        at processOrder (/app/src/orders.js:45:22)
        ...

  ── Type Context at Point of Failure ──

  Function: processOrder
  Module:   orders

  Input types:
    [{
      id: string,
      customer: null,        ← customer was null, not an object
      items: { price: number, quantity: number }[]
    }]

  Sample data:
    [{ "id": "ORD-99821", "customer": null, "items": [...] }]

  ── Expected Types (Happy Path) ──

  Expected input types:
    [{
      id: string,
      customer: { name: string, email: string },
      items: { price: number, quantity: number }[]
    }]
```

---

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [JavaScript Client](#javascript-client)
- [Python Client](#python-client)
- [CLI Reference](#cli-reference)
- [Backend](#backend)
- [Smart Caching](#smart-caching)
- [Type System](#type-system)
- [Environment Detection](#environment-detection)
- [Architecture](#architecture)

---

## Quick Start

### 1. Start the backend

```bash
cd packages/backend
npm install && npm run build
npm start
# [trickle] Backend listening on http://localhost:4888
```

### 2. Instrument your code

**JavaScript:**

```javascript
const { trickle, configure } = require('trickle');

// Optional: configure if backend isn't on localhost:4888
configure({ backendUrl: 'http://localhost:4888' });

// Wrap any function
const processOrder = trickle(function processOrder(order) {
  const total = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return { orderId: order.id, total, status: 'processed' };
});

// Use it normally — trickle is transparent
processOrder({ id: 'ORD-123', items: [{ price: 29.99, quantity: 2 }] });
```

**Python:**

```python
from trickle import trickle, configure

configure(backend_url='http://localhost:4888')

@trickle
def process_order(order):
    total = sum(item['price'] * item['quantity'] for item in order['items'])
    return {'order_id': order['id'], 'total': total, 'status': 'processed'}

process_order({'id': 'ORD-123', 'items': [{'price': 29.99, 'quantity': 2}]})
```

### 3. Deploy and trigger your application

Types are captured automatically as real traffic flows through. Happy path types are cached; errors always capture the full type context.

### 4. Explore with the CLI

```bash
npx trickle functions           # List all instrumented functions
npx trickle errors              # See what's failing
npx trickle errors 1            # Inspect full type state of error #1
npx trickle types processOrder  # See captured runtime types
npx trickle tail                # Live stream of events
```

---

## How It Works

### Two modes of use

**Sad path (debugging errors):** When your deployed code errors, select any error entry via CLI and inspect the types and values of every input and accessed property in the function at the point of failure. Compare against the expected happy-path types to instantly see what went wrong.

**Happy path (development):** Query the cached types for any function to know the real runtime types, so you can write code faster without guessing. Filter by environment (staging/prod/local) and timeframe.

### The type-cache system

When an instrumented function is called:

1. Input arguments are wrapped in transparent Proxy objects (JS) or attribute trackers (Python) that record which properties are accessed
2. The function executes normally — trickle never interferes with behavior
3. After execution, trickle infers the TypeNode representation of inputs and outputs
4. The type signature is hashed (SHA-256, 16 hex chars)
5. If the hash matches the cached hash, nothing is sent (zero network overhead)
6. If the hash is new, the type signature + one sample of actual data is sent to the backend
7. If the function threw an error, types are **always** captured regardless of cache

This means an application handling 1,000,000 requests/sec generates network traffic only when type signatures change — which is almost never in steady state.

---

## JavaScript Client

### Installation

```bash
npm install trickle
```

### API

#### `configure(opts)`

Set global configuration. Call before wrapping functions.

```javascript
const { configure } = require('trickle');

configure({
  backendUrl: 'http://localhost:4888', // Backend URL (default)
  batchIntervalMs: 2000,              // Flush interval in ms (default: 2000)
  maxBatchSize: 50,                   // Max payloads per batch (default: 50)
  enabled: true,                      // Enable/disable instrumentation (default: true)
  debug: false,                       // Log transport activity (default: false)
  environment: undefined,             // Override auto-detected env
});
```

#### `trickle(fn, opts?)`

Wrap a function to capture runtime types. Returns a function with identical behavior.

```javascript
const { trickle } = require('trickle');

// Basic usage
const myFn = trickle(function myFn(x, y) { return x + y; });

// With explicit name (for anonymous functions)
const handler = trickle('processWebhook', (event) => { ... });

// With options
const myFn = trickle(myFunction, {
  name: 'customName',     // Override function name
  module: 'api.orders',   // Override module (auto-inferred from call stack)
  sampleRate: 0.1,        // Only capture 10% of calls
  maxDepth: 3,            // Limit type inference depth (default: 5)
});
```

#### `trickleHandler(handler, opts?)`

Specialized wrapper for AWS Lambda handlers. Automatically flushes the transport after each invocation, since Lambda may freeze the process between calls.

```javascript
const { trickleHandler } = require('trickle');

exports.handler = trickleHandler(async (event, context) => {
  const order = JSON.parse(event.body);
  const result = await processOrder(order);
  return { statusCode: 200, body: JSON.stringify(result) };
});
```

#### `flush()`

Manually flush all queued payloads. Automatically called on process exit.

```javascript
const { flush } = require('trickle');
await flush();
```

### Proxy-based property tracking

When you wrap a function with `trickle()`, input arguments that are objects or arrays are wrapped in transparent ES6 Proxies before being passed to your function. These proxies record which properties your function actually accesses.

```javascript
const processOrder = trickle(function processOrder(order) {
  // trickle tracks that order.customer.name and order.items are accessed
  const name = order.customer.name;
  const total = order.items.reduce((s, i) => s + i.price, 0);
  return { name, total };
});
```

The proxies are fully transparent:
- `typeof`, `instanceof`, `Array.isArray()` all work correctly
- `JSON.stringify`, spread operator, `Object.keys` all work
- `===` comparisons work
- Iterator protocols work
- No observable difference from the original values

### What the JS client handles

| Type | Inference |
|------|-----------|
| `string`, `number`, `boolean`, `null`, `undefined` | Primitive types |
| `BigInt`, `Symbol` | Primitive types |
| Plain objects | Recursive property inference |
| Arrays | Element type unification (samples first 20) |
| `Map`, `Set` | Key/value or element types |
| `Date`, `RegExp`, `Error` | Object with type marker |
| `Buffer`, `TypedArray` | Primitive buffer type |
| Promises | Promise with resolved type |
| Functions | Function with arity |
| Circular references | Detected, marked as `unknown` |

---

## Python Client

### Installation

```bash
pip install trickle
```

(Requires `requests` package)

### API

#### `configure(**kwargs)`

```python
from trickle import configure

configure(
    backend_url='http://localhost:4888',  # Default
    batch_interval=2.0,                   # Seconds between flushes
    enabled=True,                         # Enable/disable
    max_batch_size=100,                   # Max payloads per batch
    max_retries=3,                        # Retry attempts
)
```

#### `@trickle` decorator

```python
from trickle import trickle

# Basic usage
@trickle
def process_order(order):
    return {'total': sum(i['price'] for i in order['items'])}

# With options
@trickle(name='custom_name', module='orders.api')
def process_order(order):
    ...

# Async support
@trickle
async def fetch_user(user_id):
    return await db.get_user(user_id)
```

### Attribute tracking

Python uses tracker subclasses instead of Proxies:

- **TrackedDict** — subclass of `dict`, intercepts `__getitem__` and `.get()`
- **TrackedList** — subclass of `list`, intercepts index access and iteration
- **TrackedObject** — wraps arbitrary objects, intercepts `__getattr__`

`isinstance` checks still pass (a TrackedDict is still a dict).

### What the Python client handles

| Type | Inference |
|------|-----------|
| `str`, `int`, `float`, `bool`, `None` | Primitive types |
| `bytes`, `bytearray` | Bytes primitive |
| `datetime`, `date`, `time` | Temporal primitives |
| `Enum` | String primitive |
| `dict` | Object with property types |
| `list` | Array with unified element type |
| `tuple` | Tuple type (named tuples → object) |
| `set`, `frozenset` | Set with element type |
| `dataclass` | Object with field types |
| Pydantic models (v1 & v2) | Object with field types |
| Callables | Function type |
| Circular references | Detected via `id()` set |

### Framework examples

**FastAPI:**

```python
from fastapi import FastAPI
from trickle import trickle

app = FastAPI()

@app.post("/orders")
@trickle
async def create_order(order: OrderSchema):
    result = await process_order(order.dict())
    return {"status": "ok", "data": result}
```

**Django:**

```python
from trickle import trickle

@trickle
def my_view(request):
    data = json.loads(request.body)
    return JsonResponse(process(data))
```

**AWS Lambda (Python):**

```python
from trickle import trickle

@trickle
def handler(event, context):
    body = json.loads(event['body'])
    return {'statusCode': 200, 'body': json.dumps(process(body))}
```

---

## CLI Reference

The CLI queries the trickle backend and displays results with colors, tables, and tree views.

### `trickle functions`

List all instrumented functions.

```bash
npx trickle functions
npx trickle functions --env prod
npx trickle functions --lang python
npx trickle functions --search processOrder
```

| Flag | Description |
|------|-------------|
| `--env <env>` | Filter by environment (prod, staging, lambda, etc.) |
| `--lang <lang>` | Filter by language (js, python) |
| `--search <query>` | Search by function name or module |

Output:

```
┌──────────────────┬──────────┬──────────┬─────────────┬───────────┐
│ Name             │ Module   │ Language │ Environment │ Last Seen │
├──────────────────┼──────────┼──────────┼─────────────┼───────────┤
│ processOrder     │ orders   │  js      │  lambda     │ 2m ago    │
│ validatePayment  │ payments │  js      │  lambda     │ 5m ago    │
│ process_order    │ api      │  python  │  fastapi    │ 1h ago    │
└──────────────────┴──────────┴──────────┴─────────────┴───────────┘
```

### `trickle errors [id]`

**List mode** — show all errors:

```bash
npx trickle errors
npx trickle errors --env prod
npx trickle errors --since 2h
npx trickle errors --since 3d
npx trickle errors --function processOrder
npx trickle errors --limit 10
```

| Flag | Description |
|------|-------------|
| `--env <env>` | Filter by environment |
| `--since <timeframe>` | Time filter: `30s`, `5m`, `2h`, `3d`, `1w` |
| `--function <name>` | Filter by function name |
| `--limit <n>` | Max results |

Output:

```
┌────────┬──────────────────────┬──────────────────┬──────────────────────────┬──────┬──────────┐
│ ID     │ Function             │ Error Type       │ Message                  │ Env  │ Time     │
├────────┼──────────────────────┼──────────────────┼──────────────────────────┼──────┼──────────┤
│ 42     │ processOrder         │  TypeError       │ Cannot read property…    │ prod │ 2m ago   │
│ 41     │ validatePayment      │  Error           │ Card number is required  │ prod │ 5m ago   │
└────────┴──────────────────────┴──────────────────┴──────────────────────────┴──────┴──────────┘
```

**Detail mode** — inspect a specific error:

```bash
npx trickle errors 42
```

Shows:
- Error type, message, environment, timestamp
- Full stack trace
- **Type context at point of failure:** the exact input types, return type, and a sample of the actual data
- **Expected types (happy path):** the most recent successful type snapshot for comparison

This is the core debugging workflow — you immediately see what types were present when the error occurred vs. what they should have been.

### `trickle types <function-name>`

Show captured runtime types for a function.

```bash
npx trickle types processOrder
npx trickle types processOrder --env prod
npx trickle types processOrder --diff
npx trickle types processOrder --diff --env1 prod --env2 staging
```

| Flag | Description |
|------|-------------|
| `--env <env>` | Filter snapshots by environment |
| `--diff` | Show diff between latest two snapshots |
| `--env1 <env>` | First environment for cross-env diff |
| `--env2 <env>` | Second environment for cross-env diff |

Output (normal mode):

```
  processOrder (orders)
  ──────────────────────────────────────────────────

   prod   2m ago

  args: [{
      id: string,
      customer: { name: string, email: string },
      items: { price: number, quantity: number }[]
    }]
  returns: {
      orderId: string,
      total: number,
      tax: number,
      status: string
    }

  sample input:
    [{ "id": "ORD-123", "customer": { "name": "Alice", ... }, "items": [...] }]
  sample output:
    { "orderId": "ORD-123", "total": 109.97, "tax": 10.99, "status": "processed" }
```

Output (diff mode):

```
  Type diff for processOrder
  ──────────────────────────────────────────────────

  from:  staging   3d ago
  to:    prod      2m ago

  + args.0.customer.phone     string
  ~ args.0.items[].quantity   string → number
  - return.discount           number
```

### `trickle tail`

Live stream of events as they happen (like `tail -f`).

```bash
npx trickle tail
npx trickle tail --filter processOrder
```

| Flag | Description |
|------|-------------|
| `--filter <pattern>` | Only show events matching function name |

Output:

```
  Listening for events... (Ctrl+C to stop)

  14:32:01  [ERROR]     processOrder — TypeError: Cannot read property 'email'
  14:32:05  [NEW_TYPE]  getUser — new type signature observed
  14:32:08  [ERROR]     validatePayment — Card number is required
```

---

## Backend

The backend is a Node.js Express server with SQLite storage.

### Running

```bash
cd packages/backend
npm install
npm run build
npm start
```

The backend listens on port **4888** by default (configurable via `PORT` env var). The SQLite database is created at `~/.trickle/trickle.db`.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ingest/` | Ingest a single type observation |
| `POST` | `/api/ingest/batch` | Batch ingest multiple observations |
| `GET` | `/api/functions` | List functions (query: `q`, `env`, `language`, `limit`, `offset`) |
| `GET` | `/api/functions/:id` | Get function with latest type snapshots per env |
| `GET` | `/api/types/:functionId` | List type snapshots (query: `env`, `limit`) |
| `GET` | `/api/types/:functionId/diff` | Diff snapshots (query: `from`/`to` IDs or `fromEnv`/`toEnv`) |
| `GET` | `/api/errors` | List errors (query: `functionName`, `env`, `since`, `limit`, `offset`) |
| `GET` | `/api/errors/:id` | Get error with full type context and happy-path snapshot |
| `GET` | `/api/tail` | SSE stream of real-time events (query: `filter`) |

### Database schema

Three tables:
- **functions** — every distinct function being observed (unique on name + module + language)
- **type_snapshots** — immutable log of every type signature observed (unique on function + hash + env)
- **errors** — every error captured, with full type context and sample data

SQLite uses WAL mode for concurrent reads and writes.

---

## Smart Caching

The caching strategy is designed to handle high-throughput applications (millions of requests/sec) without generating excessive data:

### What gets cached

- **Types, not data.** trickle stores type signatures (the shapes), not the raw data. For each unique type signature, one sample of actual data is stored.
- **Hash-based deduplication.** Type signatures are hashed. If the hash hasn't changed, nothing is sent. This is checked both client-side (in-memory) and server-side (database lookup).
- **Heartbeat re-sends.** Even when types haven't changed, the client re-sends every 5 minutes to keep `last_seen_at` fresh.

### Error capture rules

- **Errors always capture types** — even if the types match the happy path, because you need the type context to debug.
- **Error types are compared against existing error types**, not happy path types. If a new error has the same type signature as an existing error, only the error metadata is stored (no duplicate type data).
- **One sample per error** — actual data is stored with each error for debugging.

### Overhead in steady state

For an application handling 1M req/sec where types don't change:
- **Client:** one SHA-256 hash + one Map lookup per call (~microseconds)
- **Network:** zero (hash matches cache, no HTTP call)
- **Backend:** zero (no incoming requests)

When types change (e.g., a new field appears in an API response), one HTTP call is made per unique new signature.

---

## Type System

Both JS and Python clients produce the same TypeNode representation, enabling cross-language type comparison.

```
TypeNode =
  | { kind: "primitive", name: "string" | "number" | "boolean" | "null" | ... }
  | { kind: "object",    properties: { [key]: TypeNode } }
  | { kind: "array",     element: TypeNode }
  | { kind: "tuple",     elements: TypeNode[] }
  | { kind: "union",     members: TypeNode[] }
  | { kind: "function",  params: TypeNode[], returnType: TypeNode }
  | { kind: "promise",   resolved: TypeNode }
  | { kind: "map",       key: TypeNode, value: TypeNode }
  | { kind: "set",       element: TypeNode }
  | { kind: "unknown" }
```

Type hashing is deterministic — object keys are sorted alphabetically, union members are deduplicated and sorted. The same runtime shape always produces the same hash regardless of insertion order.

---

## Environment Detection

trickle automatically detects the runtime environment from environment variables and framework imports:

### JavaScript

| Environment Variable | Detected As |
|---------------------|-------------|
| `AWS_LAMBDA_FUNCTION_NAME` | `lambda` |
| `VERCEL` | `vercel` |
| `RAILWAY_ENVIRONMENT` | `railway` |
| `K_SERVICE` | `cloud-run` |
| `AZURE_FUNCTIONS_ENVIRONMENT` | `azure-functions` |
| `GOOGLE_CLOUD_PROJECT` | `gcp` |
| `ECS_CONTAINER_METADATA_URI` | `ecs` |
| `FLY_APP_NAME` | `fly` |
| `RENDER_SERVICE_ID` | `render` |
| `HEROKU_APP_NAME` / `DYNO` | `heroku` |
| _(none)_ | `node` |

### Python

| Detection Method | Detected As |
|-----------------|-------------|
| `AWS_LAMBDA_FUNCTION_NAME` env var | `lambda` |
| `FUNCTION_TARGET` / `GOOGLE_CLOUD_PROJECT` | `gcp-functions` |
| `AZURE_FUNCTIONS_ENVIRONMENT` | `azure-functions` |
| `import fastapi` succeeds | `fastapi` |
| `import django` succeeds | `django` |
| `import flask` succeeds | `flask` |
| _(none)_ | `python` |

Override with `configure({ environment: 'custom' })` (JS) or `configure(environment='custom')` (Python — pass through to transport if needed).

---

## Architecture

```
┌──────────────────┐       POST /api/ingest/batch       ┌─────────────────────┐
│   JS Client      │ ──────────────────────────────────> │                     │
│   (trickle npm)  │                                     │   Backend           │
└──────────────────┘                                     │   (Express + SQLite)│
                                                         │                     │
┌──────────────────┐       POST /api/ingest/batch       │   Port 4888         │
│  Python Client   │ ──────────────────────────────────> │   ~/.trickle/       │
│  (trickle pip)   │                                     │     trickle.db      │
└──────────────────┘                                     │                     │
                                                         │   GET /api/*        │
┌──────────────────┐       REST + SSE                   │   GET /api/tail     │
│   CLI            │ <────────────────────────────────> │                     │
│   (npx trickle)  │                                     └─────────────────────┘
└──────────────────┘
```

### Monorepo structure

```
trickle/
├── packages/
│   ├── backend/           # Express API + SQLite storage
│   │   └── src/
│   │       ├── db/        # Connection, migrations, queries
│   │       ├── routes/    # Ingest, functions, types, errors, tail
│   │       └── services/  # SSE broker, type differ
│   │
│   ├── client-js/         # JavaScript instrumentation library
│   │   └── src/
│   │       ├── index.ts          # Public API
│   │       ├── wrap.ts           # Core wrapping logic
│   │       ├── proxy-tracker.ts  # Deep property access tracking
│   │       ├── type-inference.ts # Runtime type inference
│   │       ├── type-hash.ts      # Canonical hashing
│   │       ├── cache.ts          # Client-side dedup
│   │       └── transport.ts      # Batched HTTP
│   │
│   ├── client-python/     # Python instrumentation library
│   │   └── src/trickle/
│   │       ├── decorator.py      # @trickle decorator
│   │       ├── attr_tracker.py   # Property access tracking
│   │       ├── type_inference.py # Runtime type inference
│   │       ├── type_hash.py      # Canonical hashing
│   │       ├── cache.py          # Client-side dedup
│   │       └── transport.py      # Batched HTTP (background thread)
│   │
│   └── cli/               # Developer CLI tool
│       └── src/
│           ├── commands/   # functions, errors, types, tail
│           ├── formatters/ # Type and diff formatting
│           └── ui/         # Badges, helpers
│
├── package.json           # npm workspace root
└── tsconfig.base.json     # Shared TypeScript config
```

### Dependencies

**Backend:** express, better-sqlite3, cors

**JS Client:** zero runtime dependencies (uses Node.js built-in `crypto` and `fetch`)

**Python Client:** requests

**CLI:** chalk, cli-table3, commander

---

## Configuration

### Backend URL

The CLI reads the backend URL from (in order):

1. `TRICKLE_BACKEND_URL` environment variable
2. `~/.trickle/config.json` (`{ "backendUrl": "..." }`)
3. Default: `http://localhost:4888`

### Backend port

Set via `PORT` environment variable (default: `4888`).

### Disabling in tests

**JavaScript:**
```javascript
configure({ enabled: false });
```

**Python:**
```python
configure(enabled=False)
```

When disabled, `trickle()` / `@trickle` returns the original function unwrapped (JS) or the decorator becomes a no-op pass-through (Python). Zero overhead.

---

## License

MIT
