# Frontend Developer: Get Typed API Clients Without Waiting for Docs

Your backend team ships endpoints faster than they write docs. Instead of guessing response shapes or reading backend source code, trickle generates a fully typed API client from real traffic — always in sync with what the backend actually returns.

## Install

```bash
npm install trickle-observe
npm install -g trickle-cli
```

## Quick Start

### Option A: Backend is already using trickle

If the backend developer runs their server with `trickle run` or has `trickleExpress(app)` set up, types are already being captured. Just generate your client:

```bash
trickle codegen --client -o src/api-client.ts
```

Use it immediately:

```typescript
import { api } from './api-client';

const users = await api.getApiUsers();
// TypeScript knows this is { id: number; name: string; email: string }[]

const user = await api.postApiUsers({ name: 'Alice', email: 'a@b.com' });
// TypeScript knows the request body shape AND the response shape
```

### Option B: Backend doesn't use trickle — use the proxy

No backend changes needed. Run a transparent proxy between your frontend and the backend:

```bash
trickle proxy --target http://localhost:3000 --port 4000
```

Point your frontend's API base URL at `http://localhost:4000`. Use the app normally — click around, submit forms. Trickle silently captures every request/response type.

Then generate your client:

```bash
trickle codegen --client -o src/api-client.ts
```

## Use Case 1: Typed API Client

```bash
trickle codegen --client -o src/api/client.ts
```

This gives you a typed fetch wrapper for every observed endpoint:

```typescript
// Generated — fully typed, zero manual work
export const api = {
  getApiUsers: async (): Promise<GetApiUsersResponse[]> => { ... },
  getApiUsersById: async (id: string): Promise<GetApiUsersResponse> => { ... },
  postApiUsers: async (body: PostApiUsersRequest): Promise<PostApiUsersResponse> => { ... },
  deleteApiUsersById: async (id: string): Promise<void> => { ... },
};
```

## Use Case 2: React Query Hooks

```bash
trickle codegen --react-query -o src/api/hooks.ts
```

Generates typed TanStack React Query hooks:

```typescript
import { useGetApiUsers, usePostApiUsers } from './api/hooks';

function UserList() {
  const { data: users, isLoading } = useGetApiUsers();
  // `users` is typed as GetApiUsersResponse[] | undefined

  const mutation = usePostApiUsers();
  // mutation.mutate() expects PostApiUsersRequest
}
```

## Use Case 3: SWR Hooks

```bash
trickle codegen --swr -o src/api/hooks.ts
```

Same idea, for SWR:

```typescript
import { useGetApiUsers } from './api/hooks';

function UserList() {
  const { data, error } = useGetApiUsers();
  // `data` is typed as GetApiUsersResponse[]
}
```

## Use Case 4: Axios Client

```bash
trickle codegen --axios -o src/api/client.ts
```

If your project uses Axios instead of fetch.

## Use Case 5: Mock Server for Offline Development

Backend is down or not built yet? Trickle can serve mock responses using real sample data it captured:

```bash
trickle mock --port 3000
```

Your frontend works as normal — every observed endpoint returns realistic sample data with correct types. No more `{ "todo": "implement this" }` stubs.

## Use Case 6: Mock Service Worker (MSW)

For testing with MSW:

```bash
trickle codegen --msw -o src/mocks/handlers.ts
```

Generates MSW handlers with realistic sample data:

```typescript
import { handlers } from './mocks/handlers';
import { setupServer } from 'msw/node';

const server = setupServer(...handlers);
```

## Use Case 7: Explore the API

Don't know what endpoints exist? Explore from the terminal:

```bash
# List all endpoints
trickle functions

# See the type signature and sample data for an endpoint
trickle types "GET /api/users"

# Compact overview of all routes
trickle overview

# Search by field name
trickle search "email"
```

## Use Case 8: Watch Mode — Types Update as You Work

```bash
trickle watch
```

Leave this running. Every time the backend handles a new request shape, your type files regenerate automatically. Your IDE picks up the changes immediately — no manual step.

## Use Case 9: Generate JSON Schema

Need JSON Schema for form validation or other tools?

```bash
trickle codegen --json-schema -o src/schemas.json
```

## Workflow Summary

```
Backend running (with or without trickle proxy)
  ↓
Send real requests (curl, browser, tests)
  ↓
trickle captures request + response types
  ↓
trickle codegen --client -o src/api.ts
  ↓
Import and use — fully typed, always in sync
```
