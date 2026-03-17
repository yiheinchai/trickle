# Backend API Developer: Auto-Generate Types from Your Running API

You're building an Express, FastAPI, Flask, or Django API. Instead of manually writing TypeScript interfaces or OpenAPI specs, trickle observes your running API and generates accurate types from real traffic.

## Install

```bash
npm install trickle-observe   # JS client
npm install -g trickle-cli    # CLI tools
```

For Python APIs:
```bash
pip install trickle-observe
```

## Quick Start (30 seconds)

### Node.js / Express

No code changes needed. Just prefix your start command:

```bash
trickle run node app.js
```

Or for TypeScript:
```bash
trickle run tsx src/server.ts
```

Hit a few endpoints (`curl http://localhost:3000/api/users`), then check:

```bash
trickle functions
```

```
  ┌─────────────────────────────────────────────────────────┐
  │ Function            │ Module     │ Calls │ Last Seen     │
  ├─────────────────────────────────────────────────────────┤
  │ GET /api/users      │ app        │ 3     │ 2s ago        │
  │ POST /api/users     │ app        │ 1     │ 5s ago        │
  │ GET /api/users/:id  │ app        │ 2     │ 3s ago        │
  └─────────────────────────────────────────────────────────┘
```

### Python / FastAPI

```bash
trickle run uvicorn app:app --reload
```

### Python / Flask

```bash
trickle run python app.py
```

### Python / Django

```bash
trickle run python manage.py runserver
```

All work the same — trickle auto-detects the framework and instruments it.

## Use Case 0: Inline Variable Hints (No console.log Needed)

When you run `trickle run node app.js`, every variable in your route handlers shows its runtime value inline in VSCode:

```javascript
app.get('/api/users', (req, res) => {
  const query = req.query.q || '';           // query: ""
  const filtered = users.filter(u => ...);   // filtered: [{id: 1, name: "Alice", ...}]
  const count = filtered.length;             // count: 2
  res.json({ users: filtered, count });
});

app.post('/api/users', (req, res) => {
  const { name, email } = req.body;          // name: "Alice", email: "alice@test.com"
  const id = nextId++;                       // id: 1
  const user = { id, name, email, ... };     // user: {id: 1, name: "Alice", ...}
  users.push(user);
  res.status(201).json(user);
});

app.delete('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id);        // id: 2
  const idx = users.findIndex(u => ...);     // idx: 1
  const deleted = users.splice(idx, 1)[0];   // deleted: {id: 2, name: "Bob", ...}
  res.json({ deleted });
});
```

Values update live as requests come in — `count` changes from `2` to `1` after a delete. Middleware variables (`token`, `isAuthed`) are also traced.

## Use Case 1: Generate TypeScript Types

After sending some requests through your API:

```bash
trickle codegen
```

Output:
```typescript
export interface GetApiUsersResponse {
  id: number;
  name: string;
  email: string;
  createdAt: string;
}

export interface PostApiUsersRequest {
  name: string;
  email: string;
}

export interface PostApiUsersResponse {
  id: number;
  name: string;
  email: string;
  createdAt: string;
}
```

Save to a file:
```bash
trickle codegen -o src/types/api.d.ts
```

## Use Case 2: Generate a Typed API Client

```bash
trickle codegen --client -o src/api-client.ts
```

This generates a fully typed fetch-based client:

```typescript
import { api } from './api-client';

const users = await api.getApiUsers();        // typed as GetApiUsersResponse[]
const user = await api.postApiUsers({ name: 'Alice', email: 'a@b.com' });
                                                // typed as PostApiUsersResponse
```

## Use Case 3: Generate an OpenAPI Spec

```bash
trickle openapi -o openapi.json --title "My API" --api-version "1.0.0"
```

This creates a valid OpenAPI 3.0 spec from observed routes — no manual YAML writing.

## Use Case 4: Auto-Generate During Development

Run your server with live type generation:

```bash
trickle dev
```

Or use watch mode:
```bash
trickle run node app.js --stubs src/
```

Types regenerate automatically as new requests flow through. Your IDE picks up `.d.ts` files immediately.

## Use Case 5: Explicit Instrumentation

If you prefer explicit control over what's observed:

**Express:**
```javascript
import { trickleExpress } from 'trickle-observe/express';

const app = express();
trickleExpress(app);  // call BEFORE defining routes

app.get('/api/users', (req, res) => { ... });
```

**FastAPI:**
```python
from trickle import instrument

app = FastAPI()
instrument(app)

@app.get("/api/users")
async def get_users(): ...
```

**Flask:**
```python
from trickle import instrument

app = Flask(__name__)
instrument(app)

@app.route("/api/users")
def get_users(): ...
```

## Use Case 6: Observe Any Function (Not Just Routes)

```javascript
import { observe, observeFn } from 'trickle-observe';

// Wrap all exports from a module
const db = observe(require('./db'), { module: 'database' });

// Wrap a single function
const processOrder = observeFn(rawProcessOrder, { name: 'processOrder' });
```

```python
from trickle import observe, observe_fn

import db
observed_db = observe(db)

@observe_fn
def process_order(order_id, items): ...
```

Then inspect:
```bash
trickle types processOrder
```

## Use Case 7: CI — Catch Breaking API Changes

Save a type baseline:
```bash
trickle check --save baseline.json
```

In CI, compare against it:
```bash
trickle check --against baseline.json
# Exit code 1 if breaking changes detected
```

## Use Case 8: Proxy Mode (No Code Changes at All)

Don't want to touch the backend code? Run a transparent proxy:

```bash
trickle proxy --target http://localhost:3000 --port 4000
```

Point your frontend at `http://localhost:4000`. All requests pass through to the real backend, but trickle observes the types. Works with any backend in any language.

## More Code Generation Formats

```bash
trickle codegen --zod              # Zod validation schemas
trickle codegen --pydantic         # Pydantic BaseModel classes
trickle codegen --json-schema      # JSON Schema definitions
trickle codegen --react-query      # TanStack React Query hooks
trickle codegen --swr              # SWR data-fetching hooks
trickle codegen --msw              # Mock Service Worker handlers
trickle codegen --graphql          # GraphQL SDL schema
trickle codegen --trpc             # tRPC router definitions
trickle codegen --axios            # Typed Axios client
trickle codegen --class-validator  # NestJS class-validator DTOs
trickle codegen --handlers         # Typed Express handler types
```

## Use Case 9: Debugging with Runtime Data (No console.log)

```bash
trickle run node app.js          # capture runtime data
trickle summary                   # errors, queries, alerts, root causes
trickle explain src/routes.js     # functions, call graph, data flow, queries
trickle flamegraph                # where is time being spent?
```

`trickle explain` shows everything about a file:
```
Functions:
  → GET /api/posts() -> Post[]  (14.5ms)
  → POST /api/users(body: { name: string }) -> User  (3.2ms)

Data Flow:
  GET /api/posts: () → Post[]
    out: [{"id":1,"title":"Hello World"}]

Queries: SELECT * FROM posts, SELECT * FROM users WHERE id = ?
Alerts: N+1 query pattern detected (SELECT * FROM users WHERE id = ? ×15)
```

## Use Case 10: Running Tests with Observability

```bash
# Auto-detects jest, vitest, mocha
trickle test

# Or specify:
trickle test "npx vitest run"
trickle test "npx jest --testPathPattern=api"
trickle test "python -m pytest tests/"
```

Returns structured results:
```
Tests:  8 passed | 1 failed | 0 skipped
Observability: 10 functions | 25 queries | N+1 pattern detected
```

For **vitest** specifically, you can also add the trickle Vite plugin for inline type hints:
```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { tricklePlugin } from 'trickle-observe/vite-plugin';

export default defineConfig({
  plugins: [tricklePlugin()],
});
```

Then run `npx vitest run` — inline hints appear in test files and source files.

## Use Case 11: Fix Verification (Before/After)

```bash
trickle verify --baseline          # save current metrics
# ... fix the N+1 query ...
trickle run node app.js            # re-run
trickle verify                     # compare
```

```
  N+1 Queries    1 →  0  ↓ 1
  Alerts         2 →  0  ↓ 2
  ✓ Fix verified — 2 metric(s) improved
```

## Project Setup

One-time setup for a project:

```bash
trickle init
```

This:
- Creates `.trickle/` directory
- Creates `CLAUDE.md` with agent debugging instructions
- Creates `.claude/settings.json` with MCP server config
- Updates `tsconfig.json` to include trickle types
- Adds npm scripts (`trickle:dev`, `trickle:client`, `trickle:mock`)
- Updates `.gitignore`
