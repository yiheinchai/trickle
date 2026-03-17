# Full-Stack Developer: End-to-End Type Safety from Runtime

You own both the backend and frontend. Instead of manually keeping types in sync across the stack, trickle observes your running API and generates types, clients, and validators that stay in sync automatically.

## Install

```bash
npm install trickle-observe        # JS client library
npm install -g trickle-cli         # CLI tools
pip install trickle-observe        # if you have Python services too
```

## Quick Start

### One-time project setup

```bash
cd your-project
trickle init
```

This creates `.trickle/` directory, `CLAUDE.md` (AI agent instructions), `.claude/settings.json` (MCP config), updates `tsconfig.json`, adds npm scripts, and updates `.gitignore`.

### Debug and understand your code

```bash
trickle run node src/server.js   # capture runtime data (zero code changes)
trickle summary                   # errors, queries, N+1 patterns, root causes
trickle explain src/routes.js     # functions, call graph, data flow, variables
trickle test                      # run jest/vitest/mocha with observability
trickle flamegraph                # performance hotspots
```

### Auto-generate types

```bash
trickle dev
```

This starts your app with auto-instrumentation and watches for type changes. As you hit endpoints, types appear in `.trickle/types.d.ts` and your IDE picks them up.

## Use Case 1: Zero-Config Type Generation

Run your Express/Fastify/Koa server through trickle:

```bash
trickle run node src/server.js --stubs src/
```

As requests flow through, trickle generates `.d.ts` sidecar files next to your source files. Your IDE immediately has types for every function.

For a Python backend:
```bash
trickle run python src/server.py
```

Same thing — `.pyi` stub files appear alongside your source.

## Use Case 2: Typed API Client for Your Frontend

After your backend has handled some requests:

```bash
# Typed fetch client
trickle codegen --client -o frontend/src/api/client.ts

# Or React Query hooks
trickle codegen --react-query -o frontend/src/api/hooks.ts
```

The generated client types match exactly what your backend actually returns — not what you think it returns.

## Use Case 3: Request Validation

Generate Zod schemas from observed types:

```bash
trickle codegen --zod -o src/validators.ts
```

Use them in your route handlers:

```typescript
import { PostApiUsersRequestSchema } from './validators';

app.post('/api/users', (req, res) => {
  const body = PostApiUsersRequestSchema.parse(req.body);
  // `body` is fully typed and validated
});
```

Or generate Express middleware directly:

```bash
trickle codegen --middleware -o src/middleware.ts
```

## Use Case 4: OpenAPI Spec Without Writing YAML

```bash
trickle openapi -o docs/openapi.json --title "My API" --api-version "2.0.0"
```

Feed this into Swagger UI, Redoc, or any OpenAPI-compatible tool. Generated from actual runtime data, not manually maintained.

## Use Case 5: Mock Server for Frontend Development

Working on the frontend while the backend is changing?

```bash
trickle mock --port 3000
```

Serves realistic mock responses based on real data trickle captured. Your frontend doesn't know the difference.

## Use Case 6: Explicit Instrumentation

For more control, instrument specific parts of your app:

```javascript
import { trickleExpress } from 'trickle-observe/express';
import { observe } from 'trickle-observe';

const app = express();
trickleExpress(app);  // observe all routes

// Also observe your service layer
const userService = observe(require('./services/user'), { module: 'userService' });
```

Now `trickle types userService.createUser` shows you the exact input/output types of your service functions, not just the HTTP layer.

## Use Case 7: Monorepo with Multiple Services

```
my-monorepo/
├── services/
│   ├── api/          ← Node.js Express
│   ├── auth/         ← Python FastAPI
│   └── payments/     ← Node.js
├── frontend/
│   └── src/
│       └── api/      ← generated clients go here
```

Run each service through trickle:

```bash
# Terminal 1
cd services/api && trickle run node src/index.js

# Terminal 2
cd services/auth && trickle run uvicorn app:app

# Terminal 3
cd services/payments && trickle run node src/index.js
```

Generate clients for the frontend:

```bash
cd services/api && trickle codegen --client -o ../../frontend/src/api/api-client.ts
cd services/auth && trickle codegen --client -o ../../frontend/src/api/auth-client.ts
```

## Use Case 8: CI — Detect Breaking Changes

Save a baseline after your API is stable:

```bash
trickle check --save api-baseline.json
```

In CI, compare against it:

```bash
# Run your test suite (which hits API endpoints)
trickle run npm test

# Check for breaking changes
trickle check --against api-baseline.json
```

Exit code 1 if a response field was removed or changed type. See what changed:

```bash
trickle diff --since 1d
```

## Use Case 9: Generate Tests

```bash
trickle test --generate -o tests/api.test.ts --framework vitest
```

Generates test files that hit every observed endpoint and verify response shapes match what trickle captured.

## Use Case 10: API Documentation

```bash
# Markdown
trickle docs -o docs/API.md

# Self-contained HTML
trickle docs --html -o docs/api.html
```

## Recommended npm Scripts

After `trickle init`, you'll have:

```json
{
  "scripts": {
    "dev": "trickle dev",
    "trickle:client": "trickle codegen --client -o src/api-client.ts",
    "trickle:mock": "trickle mock --port 3000",
    "trickle:types": "trickle codegen -o src/types.d.ts",
    "trickle:check": "trickle check --against baseline.json"
  }
}
```

## Workflow

```
npm run dev
  ↓
Hit endpoints (browser, tests, curl)
  ↓
Types auto-generated in .trickle/
  ↓
npm run trickle:client  → typed API client for frontend
npm run trickle:check   → CI catches breaking changes
npm run trickle:mock    → frontend works offline
```
