# trickle

Runtime type observability for JavaScript and Python. With minimal setup, trickle records the actual types flowing through your functions at runtime and brings them to compile time — so you get type information in your IDE without writing types yourself.

```bash
# Setup (one command)
trickle init

# Start your app — types appear in your IDE as requests flow through
trickle dev
```

---

## Table of Contents

- [Quick Start](#quick-start)
- [Dev Mode](#dev-mode)
- [Proxy Mode (Zero-Change)](#proxy-mode-zero-change)
- [Zero-Code Instrumentation](#zero-code-instrumentation)
- [One-Liner Instrumentation](#one-liner-instrumentation)
- [Manual Instrumentation](#manual-instrumentation)
- [Code Generation](#code-generation)
- [Mock Server](#mock-server)
- [Type Drift Report](#type-drift-report)
- [OpenAPI Spec Generation](#openapi-spec-generation)
- [React Query Hooks](#react-query-hooks)
- [Zod Schema Generation](#zod-schema-generation)
- [Express Handler Types](#express-handler-types)
- [API Test Generation](#api-test-generation)
- [Breaking Change Detection](#breaking-change-detection)
- [Web Dashboard](#web-dashboard)
- [CLI Reference](#cli-reference)
- [Python Support](#python-support)
- [Backend](#backend)
- [How It Works](#how-it-works)
- [Architecture](#architecture)

---

## Quick Start

### 1. Start the backend

```bash
cd packages/backend
npm install && npm run build && npm start
# [trickle] Backend listening on http://localhost:4888
```

### 2. Initialize your project

```bash
cd your-project
npx trickle init
```

This configures everything:
- Creates `.trickle/` with type placeholder files
- Updates `tsconfig.json` to include generated types
- Adds npm scripts (`trickle:start`, `trickle:dev`, `trickle:client`, `trickle:mock`)
- Updates `.gitignore`

### 3. Start developing

```bash
trickle dev
```

This single command starts your app with auto-instrumentation and watches for type changes. As requests flow through, `.trickle/types.d.ts` updates automatically and types appear in your IDE.

Or if you prefer separate terminals:

```bash
npm run trickle:start    # Terminal 1: app with instrumentation
npm run trickle:dev      # Terminal 2: type generation watch
```

### 4. Explore with the CLI

```bash
npx trickle functions            # List all instrumented functions
npx trickle errors               # See what's failing
npx trickle errors 1             # Inspect error with full type context
npx trickle types processOrder   # See captured runtime types
npx trickle diff                 # What types changed recently?
npx trickle check --against b.json  # CI: catch breaking changes
npx trickle openapi              # Generate OpenAPI 3.0 spec
npx trickle codegen --client     # Generate a typed API client
npx trickle codegen --handlers   # Generate typed Express handlers
npx trickle codegen --zod        # Generate Zod validation schemas
npx trickle codegen --react-query # Generate React Query hooks
npx trickle test --generate      # Generate API test files
npx trickle mock                 # Start a mock API server
npx trickle proxy -t http://localhost:3000  # Zero-change type capture
npx trickle dashboard            # Open web dashboard
npx trickle tail                 # Live stream of events
```

---

## Dev Mode

One command that starts your app with auto-instrumentation and live type generation:

```bash
# With explicit command
trickle dev "node app.js"

# Auto-detect from package.json scripts.start
trickle dev

# Also generate typed API client
trickle dev --client

# Custom output path
trickle dev --out .trickle/types.d.ts
```

What it does:
1. Reads your start command from `package.json` (or use an explicit command)
2. Injects `-r trickle/register` for zero-code instrumentation
3. Starts your app with color-coded `[app]` output prefix
4. Polls for new type observations every 3 seconds
5. Writes updated types to `.trickle/types.d.ts` automatically
6. Optionally generates a typed API client with `--client`

The `[types]` prefix shows when type files are updated:

```
  trickle dev
  ──────────────────────────────────────────────────
  App command:  node app.js
  Backend:      http://localhost:4888
  Types output: .trickle/types.d.ts
  ──────────────────────────────────────────────────

[app] Server listening on port 3000
[types] Updated .trickle/types.d.ts (4 types)
[app] GET /api/users 200 12ms
[types] Updated .trickle/types.d.ts (8 types)
```

### Testing it

```bash
# Terminal 1: Start backend
cd packages/backend && npm start

# Terminal 2: Run trickle dev
cd your-project
trickle dev "node app.js"

# Terminal 3: Make requests
curl http://localhost:3000/api/users
# → Types appear in your IDE!
```

Or run the dedicated E2E test:

```bash
node test-dev-e2e.js
```

---

## Proxy Mode (Zero-Change)

The absolute easiest way to use trickle — **no code changes to your backend at all**. Not even a flag. Just run a proxy:

```bash
trickle proxy --target http://localhost:3000
```

This starts a transparent reverse proxy on port 4000 that:
1. Forwards all requests to your backend
2. Captures request/response JSON shapes
3. Sends type observations to the trickle backend
4. Works with **any** backend language or framework

Point your frontend (or curl) at `http://localhost:4000` instead of `http://localhost:3000`. Types appear automatically.

### Features

- **Any backend**: Works with Node.js, Python, Go, Java, Ruby, Rust — anything that speaks HTTP + JSON
- **Path normalization**: `/api/users/123` is automatically normalized to `/api/users/:id`
- **Smart filtering**: Static assets (`.js`, `.css`, `.png`, etc.) are ignored
- **Request body capture**: POST/PUT/PATCH request bodies are typed
- **Query params**: URL query parameters are captured
- **Zero overhead to backend**: The proxy adds no latency to the backend itself

```
Frontend ──→ trickle proxy (:4000) ──→ Your backend (:3000)
                    │
                    └──→ trickle backend (:4888)
                              ↓
                         types.d.ts
```

### Use cases

- **Third-party APIs**: Capture types from APIs you don't control
- **Microservices**: Type-capture a service without modifying its code
- **Legacy apps**: Add type observability to apps you can't easily instrument
- **Any language**: Your backend doesn't need to be Node.js or Python

### Testing it

```bash
# Run the dedicated E2E test (starts its own backend):
node test-proxy-e2e.js
```

---

## Zero-Code Instrumentation

The easiest way to use trickle — no code changes at all. Just add a flag to your start command.

### Node.js

```bash
node -r trickle/register app.js
```

This patches `require('express')` so every Express app created is automatically instrumented. All route handlers are wrapped to capture request/response types.

### Python

```bash
python -m trickle app.py
```

This installs import hooks that patch Flask and FastAPI constructors. Any app created after import is automatically instrumented.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TRICKLE_BACKEND_URL` | Backend URL | `http://localhost:4888` |
| `TRICKLE_ENABLED` | Set to `0` or `false` to disable | `true` |
| `TRICKLE_DEBUG` | Set to `1` for debug logging | `false` |
| `TRICKLE_ENV` | Override detected environment name | auto-detected |

### Testing it

```bash
# Terminal 1: Start backend
cd packages/backend && npm start

# Terminal 2: Start your Express app with zero-code instrumentation
TRICKLE_DEBUG=1 node -r trickle/register your-app.js

# Terminal 3: Make requests and watch types appear
curl http://localhost:3000/api/users
npx trickle functions    # See captured routes
npx trickle codegen      # See generated types
```

---

## One-Liner Instrumentation

If you prefer explicit instrumentation, add one line to your app:

### Express

```javascript
const express = require('express');
const { instrument, configure } = require('trickle');

const app = express();
app.use(express.json());

instrument(app);  // ← one line

app.get('/api/users', (req, res) => { ... });
app.post('/api/orders', (req, res) => { ... });
```

`instrument(app)` must be called **before** defining routes. It patches `app.get`, `app.post`, etc. to wrap every handler.

### FastAPI

```python
from fastapi import FastAPI
from trickle import instrument

app = FastAPI()
instrument(app)  # ← one line

@app.get("/api/users")
async def get_users(): ...
```

### Flask

```python
from flask import Flask
from trickle import instrument

app = Flask(__name__)
instrument(app)  # ← one line

@app.route("/api/users")
def get_users(): ...
```

### Django

```python
from trickle import instrument_django
from myapp.urls import urlpatterns

instrument_django(urlpatterns)
```

### Testing it

```bash
# Terminal 1: Start backend
cd packages/backend && npm start

# Terminal 2: Run the Express E2E test
node test-express-e2e.js

# Terminal 3: See the captured types
npx trickle functions
npx trickle codegen
```

---

## Manual Instrumentation

For non-framework code (utility functions, Lambda handlers, etc.), wrap individual functions:

### JavaScript

```javascript
const { trickle, configure } = require('trickle');

configure({ backendUrl: 'http://localhost:4888' });

const processOrder = trickle(function processOrder(order) {
  const total = order.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  return { orderId: order.id, total, status: 'processed' };
});

processOrder({ id: 'ORD-123', items: [{ price: 29.99, quantity: 2 }] });
```

### Python

```python
from trickle import trickle, configure

configure(backend_url='http://localhost:4888')

@trickle
def process_order(order):
    total = sum(i['price'] * i['quantity'] for i in order['items'])
    return {'order_id': order['id'], 'total': total, 'status': 'processed'}
```

### AWS Lambda

```javascript
const { trickleHandler } = require('trickle');

exports.handler = trickleHandler(async (event, context) => {
  const order = JSON.parse(event.body);
  return { statusCode: 200, body: JSON.stringify(await processOrder(order)) };
});
```

### Testing it

```bash
# Terminal 1: Start backend
cd packages/backend && npm start

# Terminal 2: Run the basic E2E test
node test-e2e.js

# Terminal 3: Explore
npx trickle functions
npx trickle types processOrder
npx trickle errors
```

---

## Code Generation

Generate TypeScript/Python type definitions from runtime observations.

### TypeScript types

```bash
# Generate to stdout
npx trickle codegen

# Write to file
npx trickle codegen --out .trickle/types.d.ts

# Watch mode — auto-regenerate on new observations
npx trickle codegen --watch --out .trickle/types.d.ts

# Filter by environment
npx trickle codegen --env prod
```

Output example:

```typescript
export interface GetApiUsersOutput {
  users: GetApiUsersOutputUsers[];
  total: number;
}

export interface PostApiOrdersInput {
  customer: string;
  items: PostApiOrdersInputItems[];
}

export declare function getApiUsers(): GetApiUsersOutput;
export declare function postApiOrders(input: PostApiOrdersInput): PostApiOrdersOutput;
```

### Python type stubs

```bash
npx trickle codegen --python --out .trickle/types.pyi
```

### Typed API client

Generate a fully-typed `fetch`-based API client from observed routes:

```bash
npx trickle codegen --client --out .trickle/api-client.ts
```

Output example:

```typescript
export function createTrickleClient(baseUrl: string) {
  return {
    getApiUsers: (): Promise<GetApiUsersOutput> =>
      request<GetApiUsersOutput>("GET", "/api/users", undefined),

    getApiUsersId: (id: string): Promise<GetApiUsersIdOutput> =>
      request<GetApiUsersIdOutput>("GET", `/api/users/${id}`, undefined),

    postApiOrders: (input: PostApiOrdersInput): Promise<PostApiOrdersOutput> =>
      request<PostApiOrdersOutput>("POST", "/api/orders", input),
  };
}

export type TrickleClient = ReturnType<typeof createTrickleClient>;
```

Usage:

```typescript
import { createTrickleClient } from './.trickle/api-client';

const api = createTrickleClient('http://localhost:3000');
const users = await api.getApiUsers();          // fully typed!
const order = await api.postApiOrders({         // input autocomplete!
  customer: 'Alice',
  items: [{ name: 'Widget', price: 29.99, quantity: 2 }],
});
```

### Testing codegen

```bash
# Terminal 1: Start backend
cd packages/backend && npm start

# Terminal 2: Run the Express E2E test to populate types
node test-express-e2e.js

# Terminal 3: Generate and validate
npx trickle codegen --out /tmp/types.d.ts
npx tsc --noEmit --strict /tmp/types.d.ts    # Should pass

npx trickle codegen --client --out /tmp/client.ts
npx tsc --noEmit --strict /tmp/client.ts      # Should pass

npx trickle codegen --python --out /tmp/types.pyi
python3 -c "import ast; ast.parse(open('/tmp/types.pyi').read())"  # Should pass
```

Or run the dedicated E2E test:

```bash
node test-client-e2e.js
```

---

## Mock Server

Start an instant mock API server from runtime-observed types and sample data:

```bash
npx trickle mock
npx trickle mock --port 8080
npx trickle mock --no-cors
```

Output:

```
  Trickle Mock Server

  Routes (from runtime observations):
    GET     /api/products        (sample from 2m ago)
    GET     /api/products/:id    (sample from 2m ago)
    POST    /api/cart/add        (sample from 1m ago)
    DELETE  /api/cart/:cartId    (sample from 1m ago)

  Listening on http://localhost:3000
  CORS enabled (Access-Control-Allow-Origin: *)
```

Features:
- Serves all observed routes with real sample data
- **Path parameter substitution** — `/api/products/42` returns `id: 42`
- CORS enabled by default for frontend development
- Colored request logging
- 404 with helpful error for unknown routes

### Testing the mock server

```bash
# Terminal 1: Start backend
cd packages/backend && npm start

# Terminal 2: Populate types (run any E2E test)
node test-express-e2e.js

# Terminal 3: Start mock server
npx trickle mock --port 3000

# Terminal 4: Query the mock
curl http://localhost:3000/api/users
curl http://localhost:3000/api/users/42
curl -X POST http://localhost:3000/api/orders -H 'Content-Type: application/json' -d '{"customer":"Alice"}'
```

Or run the dedicated E2E test:

```bash
node test-mock-e2e.js
```

---

## Type Drift Report

See what types changed across all your functions at a glance. Useful for catching breaking API changes, comparing environments, or auditing type evolution.

### What changed recently?

```bash
npx trickle diff                    # All type changes
npx trickle diff --since 1h         # Changes in the last hour
npx trickle diff --since 2d         # Changes in the last 2 days
npx trickle diff --env production   # Only production changes
```

Output:

```
  Type drift: changes in the last 1h
  ──────────────────────────────────────────────────
  2 functions with type changes

  GET /api/products (express)
    from:  development   2m ago
    to:    development   30s ago

    + added   return.products[].rating: number
    + added   return.products[].inStock: boolean
    + added   return.hasMore: boolean
    ~ changed return.products[].name -> return.products[].title: string
    - removed return.products[].name: string

  GET /api/users (express)
    from:  development   5m ago
    to:    development   30s ago

    + added   return.users[].roles: string[]
    + added   return.users[].verified: boolean
```

### Compare environments

```bash
npx trickle diff --env1 staging --env2 production
```

Shows what's different between staging and production — useful before deploying.

### Testing it

```bash
# Run the dedicated E2E test (starts its own backend):
node test-diff-e2e.js

# Or manually:
# Terminal 1: Start backend
cd packages/backend && npm start

# Terminal 2: Populate types
node test-express-e2e.js

# Terminal 3: See drift
npx trickle diff
npx trickle diff --since 1h
```

---

## OpenAPI Spec Generation

Generate an industry-standard OpenAPI 3.0 specification from your runtime-observed API types — with zero manual spec writing.

```bash
# Output to stdout
npx trickle openapi

# Write to file
npx trickle openapi --out openapi.json

# Customize metadata
npx trickle openapi --title "My API" --api-version "2.0.0" --server "https://api.example.com"
```

The generated spec includes:
- All observed API routes as OpenAPI paths
- Request body schemas for POST/PUT/PATCH endpoints
- Response schemas from runtime observations
- Path parameters with `{param}` syntax
- Auto-generated tags from URL structure (e.g., `/api/users` → tag "users")
- Component schemas for reusable type definitions
- All `$ref` references resolve correctly

### Use cases

- **Swagger UI**: Drop the spec into Swagger UI for instant API documentation
- **Client SDKs**: Use OpenAPI Generator to create clients in any language (Go, Java, Rust, etc.)
- **API validation**: Use the spec with express-openapi-validator to validate requests
- **Testing**: Import into Postman, Insomnia, or any OpenAPI-compatible tool
- **CI/CD**: Compare specs between versions to detect breaking changes

### Testing it

```bash
# Run the dedicated E2E test (starts its own backend):
node test-openapi-e2e.js

# Or manually:
# Terminal 1: Start backend
cd packages/backend && npm start

# Terminal 2: Populate types
node test-express-e2e.js

# Terminal 3: Generate spec
npx trickle openapi --out openapi.json
cat openapi.json | jq '.paths | keys'
```

---

## React Query Hooks

Generate fully-typed [TanStack React Query](https://tanstack.com/query) hooks from runtime-observed routes — `useQuery` for GET endpoints, `useMutation` for POST/PUT/DELETE, with automatic cache invalidation and query keys.

```bash
# Generate to stdout
npx trickle codegen --react-query

# Write to file
npx trickle codegen --react-query --out .trickle/hooks.ts
```

Output example:

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { UseQueryOptions, UseMutationOptions } from "@tanstack/react-query";

export interface GetApiUsersResponse {
  users: GetApiUsersResponseUsers[];
  total: number;
}

export interface PostApiUsersInput {
  name: string;
  email: string;
}

// Query key factory for cache management
export const queryKeys = {
  users: {
    all: ["users"] as const,
    list: () => ["users", "list"] as const,
    detail: (id: string) => ["users", id] as const,
  },
  products: {
    all: ["products"] as const,
    list: () => ["products", "list"] as const,
  },
} as const;

/** GET /api/users */
export function useGetApiUsers(options?: ...) {
  return useQuery({
    queryKey: queryKeys.users.list(),
    queryFn: () => _fetch<GetApiUsersResponse>("GET", "/api/users"),
    ...options,
  });
}

/** GET /api/users/:id */
export function useGetApiUsersId(id: string, options?: ...) {
  return useQuery({
    queryKey: queryKeys.users.detail(id),
    queryFn: () => _fetch<GetApiUsersIdResponse>("GET", `/api/users/${id}`),
    ...options,
  });
}

/** POST /api/users */
export function usePostApiUsers(options?: ...) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: PostApiUsersInput) =>
      _fetch<PostApiUsersResponse>("POST", "/api/users", vars),
    onSuccess: (...args) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
      options?.onSuccess?.(...args);
    },
    ...options,
  });
}
```

### Usage in a React component

```tsx
import { configureTrickleHooks, useGetApiUsers, usePostApiUsers } from './.trickle/hooks';

// Once at app startup
configureTrickleHooks('http://localhost:3000');

function UserList() {
  const { data, isLoading, error } = useGetApiUsers();  // fully typed!
  const createUser = usePostApiUsers();

  if (isLoading) return <div>Loading...</div>;

  return (
    <div>
      {data.users.map(user => (     // user is typed: { id, name, email }
        <div key={user.id}>{user.name}</div>
      ))}
      <button onClick={() => createUser.mutate({
        name: 'New User',           // autocomplete for input fields!
        email: 'new@example.com',
      })}>
        Add User
      </button>
    </div>
  );
}
```

### Features

- **GET routes → `useQuery`** with typed responses and query key factory
- **POST/PUT/DELETE → `useMutation`** with typed inputs and auto cache invalidation
- **Query keys** organized by resource for easy `invalidateQueries` calls
- **Path params** automatically become hook arguments (`useGetApiUsersId(id)`)
- **`configureTrickleHooks(baseUrl)`** for one-time setup

### Testing it

```bash
# Run the dedicated E2E test (starts its own backend):
node test-react-query-e2e.js
```

---

## Zod Schema Generation

Generate [Zod](https://zod.dev) validation schemas from runtime-observed types — giving you both runtime validation and compile-time types via `z.infer<>`.

```bash
# Generate to stdout
npx trickle codegen --zod

# Write to file
npx trickle codegen --zod --out .trickle/schemas.ts
```

Output example:

```typescript
import { z } from "zod";

/** GET /api/users — response */
export const getApiUsersResponseSchema = z.object({
  users: z.array(z.object({
    id: z.number(),
    name: z.string(),
    email: z.string(),
    active: z.boolean(),
  })),
  total: z.number(),
});
export type GetApiUsersResponse = z.infer<typeof getApiUsersResponseSchema>;

/** POST /api/users — request body */
export const postApiUsersRequestSchema = z.object({
  name: z.string(),
  email: z.string(),
});
export type PostApiUsersRequest = z.infer<typeof postApiUsersRequestSchema>;

/** POST /api/users — response */
export const postApiUsersResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  created: z.boolean(),
});
export type PostApiUsersResponse = z.infer<typeof postApiUsersResponseSchema>;
```

### Use cases

- **API input validation**: Validate request bodies before processing
- **Type-safe parsing**: Use `schema.parse(data)` for runtime-checked types
- **Form validation**: Use with React Hook Form, Formik, or any form library
- **Config parsing**: Validate environment variables or config files
- **Type inference**: Use `z.infer<typeof schema>` instead of manually writing types

### Usage

```typescript
import { postApiUsersRequestSchema, PostApiUsersRequest } from './.trickle/schemas';

// Runtime validation
app.post('/api/users', (req, res) => {
  const result = postApiUsersRequestSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ errors: result.error.issues });
  }
  const { name, email } = result.data;  // fully typed!
  // ...
});
```

### Testing it

```bash
# Run the dedicated E2E test (starts its own backend):
node test-zod-e2e.js
```

---

## Express Handler Types

Generate fully-typed Express handler type aliases from runtime-observed routes — so your route handlers have typed `req.body`, `req.params`, `req.query`, and `res.json()` without writing any types.

```bash
# Generate to stdout
npx trickle codegen --handlers

# Write to file
npx trickle codegen --handlers --out .trickle/handlers.d.ts
```

Output example:

```typescript
import { Request, Response, NextFunction } from "express";

export interface GetApiUsersResBody {
  users: GetApiUsersResBodyUsers[];
  total: number;
}

export interface PostApiUsersReqBody {
  name: string;
  email: string;
}

export interface GetApiUsersIdParams {
  id: string;
}

/** GET /api/users */
export type GetApiUsersHandler = (
  req: Request<Record<string, string>, GetApiUsersResBody, unknown, qs.ParsedQs>,
  res: Response<GetApiUsersResBody>,
  next: NextFunction
) => void;

/** POST /api/users */
export type PostApiUsersHandler = (
  req: Request<Record<string, string>, PostApiUsersResBody, PostApiUsersReqBody, qs.ParsedQs>,
  res: Response<PostApiUsersResBody>,
  next: NextFunction
) => void;

/** GET /api/users/:id */
export type GetApiUsersIdHandler = (
  req: Request<GetApiUsersIdParams, GetApiUsersIdResBody, unknown, qs.ParsedQs>,
  res: Response<GetApiUsersIdResBody>,
  next: NextFunction
) => void;
```

Usage in your Express app:

```typescript
import { GetApiUsersHandler, PostApiUsersHandler } from './.trickle/handlers';

app.get('/api/users', ((req, res) => {
  // req.query is typed, res.json() expects the right shape
  res.json({ users: [...], total: 10 });
}) as GetApiUsersHandler);

app.post('/api/users', ((req, res) => {
  // req.body is typed — { name: string, email: string }
  const { name, email } = req.body;  // autocomplete!
  res.json({ id: 3, name, email, created: true });
}) as PostApiUsersHandler);
```

### Testing it

```bash
# Run the dedicated E2E test (starts its own backend):
node test-handlers-e2e.js
```

---

## API Test Generation

Generate ready-to-run API test files from runtime-observed routes and real sample data. No more writing boilerplate fetch calls and assertions manually.

```bash
# Generate to stdout (vitest)
npx trickle test --generate

# Write to file
npx trickle test --generate --out tests/api.test.ts

# Use Jest instead of Vitest
npx trickle test --generate --framework jest --out tests/api.test.ts

# Custom base URL
npx trickle test --generate --base-url http://localhost:8080
```

Output example:

```typescript
import { describe, it, expect } from "vitest";

const BASE_URL = process.env.TEST_API_URL || "http://localhost:3000";

describe("/api/users", () => {
  it("GET /api/users — returns expected shape", async () => {
    const res = await fetch(`${BASE_URL}/api/users`, {
      method: "GET",
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users.length).toBeGreaterThan(0);
    expect(typeof body.users[0].id).toBe("number");
    expect(typeof body.users[0].name).toBe("string");
    expect(typeof body.users[0].email).toBe("string");
    expect(typeof body.total).toBe("number");
  });

  it("POST /api/users — returns expected shape", async () => {
    const res = await fetch(`${BASE_URL}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        "name": "Charlie",
        "email": "charlie@test.com"
      }),
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(typeof body.id).toBe("number");
    expect(typeof body.name).toBe("string");
    expect(typeof body.created).toBe("boolean");
  });
});
```

### What makes this useful

- **Real sample data**: Request bodies come from actual runtime observations, not made-up values
- **Shape assertions**: Tests verify the structure of responses (field existence and types), not exact values
- **Grouped by resource**: Tests are organized into `describe` blocks by API resource
- **Framework support**: Works with Vitest (default) or Jest
- **CI-ready**: Set `TEST_API_URL` env var to point to any environment

### Testing it

```bash
# Run the dedicated E2E test (starts its own backend):
node test-test-gen-e2e.js
```

---

## Breaking Change Detection

Catch breaking API changes before they reach production. Save a baseline of your API types and compare against it — with CI-friendly exit codes.

### Save a baseline

```bash
# After deploying to production, save current types
trickle check --save baseline.json
```

### Check for breaking changes

```bash
# In CI, before deploying
trickle check --against baseline.json
# Exit code 0 = compatible, exit code 1 = breaking changes
```

### What counts as breaking vs non-breaking

| Change | Classification | Why |
|--------|---------------|-----|
| Response field removed | **Breaking** | Clients may depend on it |
| Response field type changed | **Breaking** | Clients expect the old type |
| Route/function removed | **Breaking** | Clients call it |
| New required request field | **Breaking** | Existing callers don't send it |
| Response field added | Non-breaking | Clients ignore unknown fields |
| Request field removed | Non-breaking | Server no longer requires it |
| New route added | Non-breaking | Doesn't affect existing clients |

### Example output

```
  trickle check
  Baseline: baseline.json (2024-01-15T10:30:00Z)
  Current: 5 functions observed
  ──────────────────────────────────────────────────

  2 BREAKING CHANGES

  GET /api/users
    ✗ response.users[].email — Field removed from response
    ✗ response.users[].name — Type changed from string to number

  1 non-breaking change

  GET /api/users
    + response.users[].role — Field added to response

  FAIL — 2 breaking changes detected
```

### CI/CD integration

```yaml
# GitHub Actions example
- name: Check for breaking API changes
  run: |
    npx trickle check --against baseline.json
```

```bash
# Shell script
if npx trickle check --against baseline.json; then
  echo "API compatible — safe to deploy"
else
  echo "Breaking changes detected — review before deploying"
  exit 1
fi
```

### Testing it

```bash
# Run the dedicated E2E test (starts its own backend):
node test-check-e2e.js
```

---

## Web Dashboard

A live web UI for exploring your observed API types visually. Opens in your browser with one command.

```bash
npx trickle dashboard
```

Or visit `http://localhost:4888/dashboard` directly while the backend is running.

### Features

- **Route overview**: All observed routes with HTTP method badges and last-seen timestamps
- **Type tree viewer**: Click any route to expand and see its response type, request body, path params, and query params rendered as a syntax-highlighted type tree
- **Sample data**: View actual sample responses captured at runtime
- **Live updates**: SSE connection to the backend — new type observations appear automatically with a notification banner
- **Search**: Filter routes by path, method, or any text
- **Method tabs**: Quick filter by HTTP method (GET, POST, PUT, DELETE)
- **Stats bar**: At-a-glance counts of total functions, API routes, and methods
- **Dark theme**: Clean dark UI designed for developer comfort
- **Zero dependencies**: Self-contained HTML page served by the backend — no React, no build step

### Testing it

```bash
# Run the dedicated E2E test (starts its own backend):
node test-dashboard-e2e.js
```

---

## CLI Reference

### `trickle dev [command]`

All-in-one development command — app + instrumentation + type generation.

```bash
trickle dev "node app.js"       # Explicit command
trickle dev                     # Auto-detect from package.json
trickle dev --client            # Also generate typed API client
trickle dev --out types.d.ts    # Custom output path
```

| Flag | Description |
|------|-------------|
| `-o, --out <path>` | Types output path (default: `.trickle/types.d.ts`) |
| `--client` | Also generate typed API client (`.trickle/api-client.ts`) |
| `--python` | Generate Python type stubs instead of TypeScript |

### `trickle init`

Set up trickle in your project.

```bash
npx trickle init
npx trickle init --dir /path/to/project
npx trickle init --python
```

| Flag | Description |
|------|-------------|
| `--dir <path>` | Project directory (defaults to cwd) |
| `--python` | Set up for a Python project |

What it does:
- Creates `.trickle/` with `types.d.ts` and `api-client.ts` placeholders
- Updates `tsconfig.json` to include `.trickle` in `include`
- Adds npm scripts: `trickle:dev`, `trickle:start`, `trickle:client`, `trickle:mock`
- Updates `.gitignore`
- Idempotent — safe to run multiple times

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
| `--env <env>` | Filter by environment |
| `--lang <lang>` | Filter by language (js, python) |
| `--search <query>` | Search by function name |

### `trickle types <function-name>`

Show captured runtime types for a function.

```bash
npx trickle types processOrder
npx trickle types "GET /api/users"
npx trickle types processOrder --diff
npx trickle types processOrder --diff --env1 prod --env2 staging
```

| Flag | Description |
|------|-------------|
| `--env <env>` | Filter snapshots by environment |
| `--diff` | Show diff between latest two snapshots |
| `--env1 <env>` | First environment for cross-env diff |
| `--env2 <env>` | Second environment for cross-env diff |

### `trickle errors [id]`

List errors or inspect a specific error with full type context.

```bash
npx trickle errors
npx trickle errors --since 2h
npx trickle errors --function processOrder
npx trickle errors 42    # Inspect error #42
```

| Flag | Description |
|------|-------------|
| `--env <env>` | Filter by environment |
| `--since <timeframe>` | Time filter: `30s`, `5m`, `2h`, `3d` |
| `--function <name>` | Filter by function name |
| `--limit <n>` | Max results |

### `trickle codegen [function-name]`

Generate type definitions from runtime observations.

```bash
npx trickle codegen                                    # TypeScript to stdout
npx trickle codegen --out .trickle/types.d.ts          # Write to file
npx trickle codegen --python --out .trickle/types.pyi  # Python stubs
npx trickle codegen --client --out .trickle/client.ts  # Typed API client
npx trickle codegen --handlers --out .trickle/handlers.d.ts  # Express handler types
npx trickle codegen --zod --out .trickle/schemas.ts          # Zod validation schemas
npx trickle codegen --react-query --out .trickle/hooks.ts    # React Query hooks
npx trickle codegen --watch --out .trickle/types.d.ts  # Watch mode
npx trickle codegen --env prod                         # Filter by env
```

| Flag | Description |
|------|-------------|
| `-o, --out <path>` | Write to file instead of stdout |
| `--env <env>` | Filter by environment |
| `--python` | Generate Python TypedDict stubs |
| `--client` | Generate typed fetch-based API client |
| `--handlers` | Generate typed Express handler types |
| `--zod` | Generate Zod validation schemas with inferred types |
| `--watch` | Re-generate when new types are observed |

### `trickle diff`

Show type drift across all functions — what changed and where.

```bash
npx trickle diff                                    # All type changes
npx trickle diff --since 1h                         # Changes in the last hour
npx trickle diff --env production                   # Filter by environment
npx trickle diff --env1 staging --env2 production   # Cross-env comparison
```

| Flag | Description |
|------|-------------|
| `--since <timeframe>` | Time filter: `30s`, `5m`, `2h`, `3d`, `1w` |
| `--env <env>` | Filter by environment |
| `--env1 <env>` | First environment for cross-env comparison |
| `--env2 <env>` | Second environment for cross-env comparison |

### `trickle check`

Detect breaking API changes by comparing against a saved baseline.

```bash
trickle check --save baseline.json               # Save current types
trickle check --against baseline.json             # Check for breaking changes
trickle check --against baseline.json --env prod  # Filter by environment
```

| Flag | Description |
|------|-------------|
| `--save <file>` | Save current types as a baseline snapshot |
| `--against <file>` | Check current types against baseline (exit 1 on breaking) |
| `--env <env>` | Filter by environment |

### `trickle openapi`

Generate an OpenAPI 3.0 spec from runtime-observed routes.

```bash
npx trickle openapi                                          # Output to stdout
npx trickle openapi --out openapi.json                       # Write to file
npx trickle openapi --title "My API" --api-version "2.0.0"   # Custom metadata
npx trickle openapi --server "https://api.example.com"       # Add server URL
npx trickle openapi --env production                         # Filter by env
```

| Flag | Description |
|------|-------------|
| `-o, --out <path>` | Write spec to a file (JSON) |
| `--env <env>` | Filter by environment |
| `--title <title>` | API title (default: "API") |
| `--api-version <version>` | API version (default: "1.0.0") |
| `--server <url>` | Server URL to include in the spec |

### `trickle test --generate`

Generate API test files from runtime-observed routes and sample data.

```bash
npx trickle test --generate                                    # Vitest to stdout
npx trickle test --generate --out tests/api.test.ts            # Write to file
npx trickle test --generate --framework jest                   # Use Jest
npx trickle test --generate --base-url http://localhost:8080   # Custom base URL
```

| Flag | Description |
|------|-------------|
| `--generate` | Generate test file (required) |
| `-o, --out <path>` | Write tests to a file |
| `--framework <name>` | Test framework: `vitest` or `jest` (default: vitest) |
| `--base-url <url>` | Base URL for requests (default: `http://localhost:3000`) |

### `trickle mock`

Start a mock API server from observed runtime types.

```bash
npx trickle mock
npx trickle mock --port 8080
npx trickle mock --no-cors
```

| Flag | Description |
|------|-------------|
| `-p, --port <port>` | Port to listen on (default: 3000) |
| `--no-cors` | Disable CORS headers |

### `trickle proxy`

Transparent reverse proxy that captures API types without any backend code changes.

```bash
npx trickle proxy --target http://localhost:3000              # Proxy on :4000
npx trickle proxy --target http://localhost:3000 --port 8080  # Custom proxy port
```

| Flag | Description |
|------|-------------|
| `-t, --target <url>` | Target server URL (required) |
| `-p, --port <port>` | Proxy server port (default: 4000) |

### `trickle dashboard`

Open the web dashboard to explore observed types visually.

```bash
npx trickle dashboard
```

Opens `http://localhost:4888/dashboard` in your default browser.

### `trickle tail`

Live stream of events.

```bash
npx trickle tail
npx trickle tail --filter processOrder
```

| Flag | Description |
|------|-------------|
| `--filter <pattern>` | Only show events matching function name |

---

## Python Support

### Installation

```bash
pip install -e packages/client-python
```

### Zero-code instrumentation

```bash
python -m trickle app.py
```

Automatically patches Flask and FastAPI constructors via import hooks.

### One-liner instrumentation

```python
from trickle import instrument
instrument(app)  # Auto-detects FastAPI, Flask, or Django
```

Or use framework-specific functions:

```python
from trickle import instrument_fastapi, instrument_flask, instrument_django

instrument_fastapi(app)
instrument_flask(app)
instrument_django(urlpatterns)
```

### Decorator

```python
from trickle import trickle

@trickle
def process_order(order):
    ...

@trickle
async def fetch_user(user_id):
    ...
```

### Testing Python

```bash
# Terminal 1: Start backend
cd packages/backend && npm start

# Terminal 2: Run Python E2E test
PYTHONPATH=packages/client-python/src python3 test-e2e.py

# Terminal 3: Explore
npx trickle functions --lang python
npx trickle codegen --python
```

---

## Backend

### Running

```bash
cd packages/backend
npm install && npm run build && npm start
# [trickle] Backend listening on http://localhost:4888
```

SQLite database: `~/.trickle/trickle.db` (WAL mode, created automatically).

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ingest/` | Ingest a single type observation |
| `POST` | `/api/ingest/batch` | Batch ingest multiple observations |
| `GET` | `/api/functions` | List functions |
| `GET` | `/api/functions/:id` | Get function with latest snapshots per env |
| `GET` | `/api/types/:functionId` | List type snapshots |
| `GET` | `/api/types/:functionId/diff` | Diff snapshots between envs or time |
| `GET` | `/api/errors` | List errors |
| `GET` | `/api/errors/:id` | Get error with type context |
| `GET` | `/api/codegen` | Generate type definitions |
| `GET` | `/api/diff` | Cross-function type drift report |
| `GET` | `/api/mock-config` | Get mock server configuration |
| `GET` | `/api/tail` | SSE stream of real-time events |
| `GET` | `/api/health` | Health check |

### Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `4888` |
| `TRICKLE_BACKEND_URL` | CLI backend URL | `http://localhost:4888` |

The CLI reads backend URL from (in order):
1. `TRICKLE_BACKEND_URL` env var
2. `~/.trickle/config.json` (`{ "backendUrl": "..." }`)
3. Default: `http://localhost:4888`

---

## How It Works

### The type-cache system

When an instrumented function is called:

1. Input arguments are wrapped in transparent Proxy objects (JS) or attribute trackers (Python)
2. The function executes normally — trickle never interferes with behavior
3. After execution, trickle infers a TypeNode representation of inputs and outputs
4. The type signature is hashed (SHA-256, 16 hex chars)
5. If the hash matches the cache, nothing is sent (zero network overhead)
6. If the hash is new, the type signature + one sample of data is sent to the backend
7. If the function threw an error, types are **always** captured regardless of cache

An application handling 1,000,000 requests/sec generates network traffic only when type signatures change — which is almost never in steady state.

### Smart caching

- **Types, not data.** Stores type shapes, not raw data. One sample per signature.
- **Hash-based dedup.** Client-side in-memory cache + server-side database dedup.
- **5-minute heartbeat.** Re-sends to keep `last_seen_at` fresh.
- **Errors always capture.** Full type context on every error for debugging.

### Type system

Both JS and Python produce the same TypeNode representation:

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

---

## Architecture

```
┌──────────────────┐     POST /api/ingest/batch     ┌─────────────────────┐
│   JS Client      │ ─────────────────────────────> │                     │
│   (trickle npm)  │                                │   Backend           │
├──────────────────┤                                │   (Express + SQLite)│
│  -r register     │  auto-patches require()        │                     │
└──────────────────┘                                │   Port 4888         │
                                                    │   ~/.trickle/db     │
┌──────────────────┐     POST /api/ingest/batch     │                     │
│  Python Client   │ ─────────────────────────────> │                     │
│  (trickle pip)   │                                │                     │
├──────────────────┤                                │                     │
│  -m trickle      │  auto-patches imports          │                     │
└──────────────────┘                                └─────────┬───────────┘
                                                              │
┌──────────────────┐     REST + SSE                          │
│   CLI            │ <──────────────────────────────────────>│
│   (npx trickle)  │                                         │
├──────────────────┤                                         │
│  dev             │  all-in-one app + instrumentation + types│
│  init            │  project setup                          │
│  codegen         │  TypeScript/Python/client/hooks/zod gen  │
│  mock            │  mock API server from observed types    │
│  diff            │  cross-function type drift report       │
│  proxy           │  zero-change type capture via proxy      │
│  dashboard       │  live web UI for exploring types         │
│  test            │  generate API tests from observations   │
│  check           │  breaking change detection (CI-ready)   │
│  openapi         │  generate OpenAPI 3.0 spec              │
│  functions       │  list observed functions                │
│  types           │  inspect runtime types                  │
│  errors          │  debug errors with type context         │
│  tail            │  live event stream                      │
└──────────────────┘
```

### Monorepo structure

```
trickle/
├── packages/
│   ├── backend/            # Express API + SQLite storage
│   │   └── src/
│   │       ├── db/         # Connection, migrations, queries
│   │       ├── routes/     # ingest, functions, types, errors, tail, codegen, mock, diff
│   │       └── services/   # SSE broker, type differ, type generator
│   │
│   ├── client-js/          # JavaScript instrumentation library
│   │   ├── register.js     # Entry point for node -r trickle/register
│   │   └── src/
│   │       ├── index.ts        # Public API: configure, trickle, instrument, flush
│   │       ├── register.ts     # Auto-instrumentation via Module._load
│   │       ├── express.ts      # Express monkey-patching
│   │       ├── wrap.ts         # Core function wrapping
│   │       ├── proxy-tracker.ts # Deep property access tracking
│   │       ├── type-inference.ts
│   │       ├── type-hash.ts
│   │       ├── cache.ts
│   │       ├── transport.ts    # Batched HTTP with retry
│   │       └── env-detect.ts
│   │
│   ├── client-python/      # Python instrumentation library
│   │   └── src/trickle/
│   │       ├── __init__.py     # Public API
│   │       ├── __main__.py     # python -m trickle runner
│   │       ├── _auto.py        # Auto-instrumentation import hooks
│   │       ├── instrument.py   # FastAPI/Flask/Django instrumentation
│   │       ├── decorator.py    # @trickle decorator
│   │       ├── attr_tracker.py
│   │       ├── type_inference.py
│   │       ├── type_hash.py
│   │       ├── cache.py
│   │       ├── transport.py
│   │       └── env_detect.py
│   │
│   └── cli/                # Developer CLI tool
│       └── src/
│           ├── index.ts        # Commander setup
│           ├── commands/       # dev, init, functions, types, errors, codegen, mock, diff, check, openapi, test-gen, tail
│           ├── formatters/     # Type and diff formatting
│           └── ui/             # Badges, helpers
│
├── test-e2e.js             # Basic JS client test
├── test-e2e.py             # Basic Python client test
├── test-express-e2e.js     # Express auto-instrumentation test
├── test-client-e2e.js      # Typed API client generation test
├── test-register-e2e.js    # Zero-code register hook test
├── test-register-app.js    # Plain Express app (no trickle code) for register test
├── test-mock-e2e.js        # Mock server test
├── test-init-e2e.js        # trickle init test
├── test-diff-e2e.js        # Type drift report test
├── test-openapi-e2e.js     # OpenAPI spec generation test
├── test-check-e2e.js       # Breaking change detection test
├── test-proxy-e2e.js       # Transparent proxy type capture test
├── test-dashboard-e2e.js   # Web dashboard test
├── test-test-gen-e2e.js    # API test generation test
├── test-react-query-e2e.js # React Query hook generation test
├── test-zod-e2e.js         # Zod schema generation test
├── test-handlers-e2e.js    # Express handler type generation test
├── test-dev-e2e.js         # Dev mode (all-in-one) test
├── package.json            # npm workspace root
└── tsconfig.base.json      # Shared TypeScript config
```

### Dependencies

| Package | Dependencies |
|---------|-------------|
| Backend | express, better-sqlite3, cors |
| JS Client | zero runtime dependencies |
| Python Client | requests |
| CLI | chalk, cli-table3, commander |

---

## E2E Tests

Run all E2E tests to verify everything works:

```bash
# Build everything first
npm run build

# Start backend (required for all tests)
cd packages/backend && npm start

# In another terminal, run tests:
node test-e2e.js             # Basic JS instrumentation
node test-express-e2e.js     # Express auto-instrumentation
node test-client-e2e.js      # Typed API client generation
node test-mock-e2e.js        # Mock server
node test-init-e2e.js        # trickle init (creates temp project)
node test-diff-e2e.js        # Type drift report
node test-openapi-e2e.js     # OpenAPI spec generation
node test-check-e2e.js       # Breaking change detection
node test-proxy-e2e.js       # Transparent proxy type capture
node test-dashboard-e2e.js   # Web dashboard
node test-test-gen-e2e.js    # API test generation
node test-react-query-e2e.js # React Query hook generation
node test-zod-e2e.js         # Zod schema generation
node test-handlers-e2e.js    # Express handler type generation
node test-dev-e2e.js         # Dev mode (all-in-one)

# Self-contained tests (start their own backend):
node test-register-e2e.js    # Zero-code register hook

# Python test:
PYTHONPATH=packages/client-python/src python3 test-e2e.py
```

---

## License

MIT
