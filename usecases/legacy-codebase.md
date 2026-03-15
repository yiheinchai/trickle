# Legacy Codebase: Understand and Document an Unknown API

You've inherited a codebase with no documentation, no types, and no tests. You need to understand what the API does, what data shapes flow through it, and eventually add types. Trickle lets you discover all of this from runtime behavior without reading every line of code.

## Install

```bash
npm install -g trickle-cli
pip install trickle-observe    # for Python codebases
```

## Quick Start

```bash
# Run the existing server through trickle — no code changes needed:
trickle run node server.js       # or: trickle run python app.py

# Now use the app (click around, curl endpoints, run tests if they exist)

# Then understand what happened:
trickle summary                   # full overview: functions, queries, errors, root causes
trickle explain src/api.js        # understand a file: functions, call graph, data flow
trickle flamegraph                # where is time being spent?

# Generate documentation:
trickle docs -o API.md            # Markdown API docs from runtime data
trickle openapi -o openapi.json   # OpenAPI spec
```

For AI agents (Claude Code, etc.):
```bash
trickle init    # creates CLAUDE.md + .claude/settings.json with 26 MCP tools
```

Now the agent can use `explain_file`, `get_last_run_summary`, and `get_flamegraph` to understand the codebase autonomously.

## Use Case 1: Discover What Endpoints Exist

```bash
trickle functions
```

```
  ┌─────────────────────────────────────────────────────────┐
  │ Function               │ Module  │ Calls │ Last Seen     │
  ├─────────────────────────────────────────────────────────┤
  │ GET /api/users         │ app     │ 12    │ 2s ago        │
  │ GET /api/users/:id     │ app     │ 5     │ 4s ago        │
  │ POST /api/users        │ app     │ 3     │ 10s ago       │
  │ GET /api/orders        │ app     │ 8     │ 1s ago        │
  │ POST /api/orders       │ app     │ 2     │ 15s ago       │
  │ GET /api/products      │ app     │ 20    │ 1s ago        │
  │ PUT /api/orders/:id    │ app     │ 1     │ 30s ago       │
  └─────────────────────────────────────────────────────────┘
```

You now know every endpoint the API exposes and how frequently each is hit.

## Use Case 2: See the Actual Data Shape

```bash
trickle types "GET /api/users"
```

Shows the exact response shape with sample data:

```
  GET /api/users

  Response:
    { id: number; name: string; email: string; role: string; createdAt: string }[]

  Sample:
    [
      { "id": 1, "name": "Alice", "email": "alice@co.com", "role": "admin", "createdAt": "2024-01-15" },
      { "id": 2, "name": "Bob", "email": "bob@co.com", "role": "user", "createdAt": "2024-02-20" }
    ]
```

```bash
trickle types "POST /api/orders"
```

Shows both request body AND response:

```
  POST /api/orders

  Request body:
    { userId: number; items: { productId: number; quantity: number }[]; notes?: string }

  Response:
    { id: number; status: string; total: number; createdAt: string }
```

## Use Case 3: Compact API Overview

```bash
trickle overview
```

One-line summary for every endpoint:

```
  GET  /api/users          → { id, name, email, role, createdAt }[]
  GET  /api/users/:id      → { id, name, email, role, createdAt }
  POST /api/users           ← { name, email, role? } → { id, name, email, role, createdAt }
  GET  /api/orders          → { id, status, total, createdAt, user }[]
  POST /api/orders          ← { userId, items[], notes? } → { id, status, total, createdAt }
```

## Use Case 4: Search Across the Whole API

Where does `email` appear?

```bash
trickle search email
```

Shows every endpoint that has an `email` field in its request or response.

## Use Case 5: Generate Documentation

```bash
# Markdown
trickle docs -o docs/API.md

# Self-contained HTML (shareable)
trickle docs --html -o docs/api.html
```

Share the HTML file with your team. It contains every endpoint, request/response shapes, and sample data.

## Use Case 6: Generate an OpenAPI Spec

```bash
trickle openapi -o docs/openapi.json --title "Legacy API" --api-version "1.0.0"
```

Feed this into Swagger UI or Redoc for a browsable API explorer. Import into Postman for testing.

## Use Case 7: Generate TypeScript Types

Start adding type safety to the codebase:

```bash
# Type definitions
trickle codegen -o src/types.d.ts

# Typed API client
trickle codegen --client -o src/api-client.ts

# Zod schemas for validation
trickle codegen --zod -o src/schemas.ts
```

## Use Case 8: Generate Tests from Observed Behavior

Create a test suite from what the API actually does:

```bash
trickle test --generate -o tests/api.test.ts
```

This captures the current behavior as regression tests. Now you can refactor with confidence.

## Use Case 9: Proxy Mode (Can't Modify the Server at All)

If you truly can't touch the server process:

```bash
# Start proxy on port 4000, forwarding to the real server on 3000
trickle proxy --target http://localhost:3000 --port 4000
```

Point your browser/client at `localhost:4000`. Every request passes through to the real server, but trickle captures all the types.

## Use Case 10: Capture Specific Endpoints Manually

Don't want to run the whole app through trickle? Capture individual endpoints:

```bash
trickle capture GET http://localhost:3000/api/users
trickle capture POST http://localhost:3000/api/users \
  -d '{"name":"test","email":"test@test.com"}' \
  -H 'Authorization: Bearer token123'
```

## Use Case 11: Track Errors

```bash
# See all errors
trickle errors

# Errors in the last hour
trickle errors --since 1h

# Errors on a specific endpoint
trickle errors --function "POST /api/orders"

# Full stack trace and type context
trickle errors <error-id>
```

## Recommended Approach

1. **Day 1**: `trickle run npm start` → use the app → `trickle overview` to get the lay of the land
2. **Day 2**: `trickle docs --html -o docs/api.html` → share with team
3. **Day 3**: `trickle test --generate` → baseline regression tests
4. **Day 4**: `trickle codegen -o src/types.d.ts` → start adding type safety
5. **Ongoing**: `trickle check --save baseline.json` → catch regressions in CI
