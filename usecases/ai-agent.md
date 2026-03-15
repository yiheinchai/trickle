# AI Coding Agent: Debug with Runtime Context Instead of console.log

You're an AI coding agent (Claude Code, Cursor, Copilot, etc.) debugging an application. Instead of asking the user to add console.log statements and re-run, use trickle's cached runtime data to understand what happened at runtime.

## Setup

When you encounter a project with `.trickle/` directory or `CLAUDE.md` mentioning trickle, the runtime data is already available.

If not set up yet:
```bash
npm install -g trickle-cli && npm install trickle-observe
trickle init     # sets up project + creates CLAUDE.md
trickle run node app.js   # captures runtime data
```

---

## Use Case 1: Understanding Variable Values Without Running Code

**Before trickle (traditional debugging):**
```
Agent: "I need to add a console.log to see what `user` contains at line 25"
User: *adds console.log, re-runs app, copies output*
Agent: "OK, now I can see the issue..."
```

**With trickle:**
```bash
trickle context src/api.ts:25
```

Output:
```
## Variables (runtime values)
### src/api.ts
- L13 `user`: `{ id: number, name: string, email: string }` = `{"id":1,"name":"Alice",...}`
- L18 `users`: `User[]` = `[{"id":1,...}, {"id":2,...}]`
- L19 `count`: `number` = `3`
- L25 `user`: `undefined` = `null`
```

The agent immediately sees that `user` is `undefined` at line 25 — the bug is a failed lookup.

---

## Use Case 2: Understanding Function Signatures

```bash
trickle context --function handleCreateUser
```

Output:
```
## Functions
- `api.handleCreateUser(body: { name: string, email: string }) -> { success: boolean, data: User }`
  Sample call: [{"name":"Alice","email":"alice@co.com"}] -> {"success":true,"data":{"id":1,...}}
```

The agent sees exact parameter types and sample inputs/outputs — no need to trace through the code.

---

## Use Case 3: Debugging Errors

```bash
trickle context --errors
```

Shows variable values near where errors occurred — like a local Sentry.

---

## Use Case 4: Cross-File Data Flow

```bash
trickle context --compact
```

Compact output showing all variables across all files — perfect for understanding how data flows through the application:

```
### src/db.ts
  L9 users: User[] = []
  L13 user: User = {"id":1,"name":"Alice",...}

### src/api.ts
  L13 user: User = {"id":1,"name":"Alice",...}
  L19 count: number = 3

### src/index.ts
  L4 r1: ApiResponse = {"success":true,"data":{"id":1,...}}
```

---

## Use Case 5: JSON Output for Programmatic Analysis

```bash
trickle context src/api.ts --json
```

Returns structured JSON that agents can parse:
```json
{
  "variables": [
    {"file": "src/api.ts", "line": 13, "name": "user", "type": "{ id: number, ... }", "value": {"id": 1, ...}},
    {"file": "src/api.ts", "line": 19, "name": "count", "type": "number", "value": 3}
  ],
  "functions": [
    {"name": "handleCreateUser", "module": "api", "params": [...], "returns": "..."}
  ]
}
```

---

## Agent Workflow

1. **Understand the code** → Agent runs `trickle explain <file>` to see functions, call graph, queries, variables, errors
2. **Run tests** → Agent runs `trickle test` to get structured pass/fail with runtime context at failure points
3. **Get full picture** → Agent calls `get_last_run_summary` for a comprehensive overview in one MCP call
4. **Identify root cause** → Agent sees runtime values, N+1 patterns, slow queries, errors with context
5. **Fix the code** → Agent applies changes based on runtime data
6. **Verify the fix** → Agent runs `trickle test` again to confirm pass/fail

This reduces debugging from multiple "add log → run → read output" cycles to structured, actionable data.

---

## Use Case 8: Understanding Unfamiliar Code

```bash
trickle explain src/api.ts
```

Shows everything about a file via runtime data:
- **Functions**: signatures with parameter/return types, timing, sample I/O
- **Call graph**: who calls this file's functions, what they call
- **Variables**: runtime values at each line
- **Queries**: database operations triggered by this code
- **Errors**: runtime errors with context
- **Alerts**: N+1 patterns, slow queries, performance issues

---

## Use Case 9: Smart Test Running

```bash
trickle test                    # auto-detect framework
trickle test "npm test"         # specific command
trickle test --json             # structured output for agents
```

Returns structured test results with runtime context at failure points:
- Per-test pass/fail with error messages
- Variable values near the failure
- Database queries that ran during the test
- Call trace showing execution flow
- Observability alerts (N+1 queries, etc.)

---

## Integration with CLAUDE.md

When `trickle init` is run, it creates a `CLAUDE.md` with instructions for agents:

```markdown
## Debugging with Runtime Data

This project uses **trickle** for runtime type observability.
Use cached runtime data instead of adding console.log/print statements:

    trickle context src/api.ts        # variable values for a file
    trickle context src/api.ts:42     # values near a specific line
    trickle context --compact          # minimal output
```

AI agents that read `CLAUDE.md` (like Claude Code) will automatically know to use `trickle context` instead of adding debug prints.

---

## MCP Server Integration

For the deepest integration, add trickle as an MCP server so Claude can query runtime data directly as tools:

```json
{
  "mcpServers": {
    "trickle": {
      "command": "npx",
      "args": ["trickle-cli", "mcp-server"]
    }
  }
}
```

**21 MCP tools available:**

| Tool | What it does |
|---|---|
| `get_last_run_summary` | **Start here** — comprehensive post-run summary with status, errors, queries, signatures, alerts, logs, memory, and fix recommendations. Replaces 5-10 individual tool calls. |
| `get_alerts` | Detected anomalies with fix suggestions |
| `get_heal_plans` | Remediation plans with context for auto-fixing |
| `get_runtime_context` | Variable values + function types for a file |
| `get_annotated_source` | Source code with inline runtime values |
| `get_function_signatures` | All function signatures with execution timing |
| `get_call_trace` | Execution flow — which function called which |
| `get_errors` | Crash context with nearby variable values |
| `get_database_queries` | SQL, Redis, MongoDB queries with timing + row counts |
| `get_distributed_traces` | Cross-service request flow with trace IDs |
| `get_logs` | Structured log entries from logging frameworks |
| `get_websocket_events` | WebSocket/socket.io messages |
| `get_performance_profile` | Memory usage (RSS + heap) snapshots |
| `get_doctor` | Overall health check with status and data counts |
| `get_environment` | Runtime, platform, and framework detection |
| `get_console_output` | Captured console.log/error/warn output |
| `get_http_requests` | HTTP fetch calls with status + latency |
| `explain_file` | Understand a file via runtime data — functions, call graph, queries, variables, errors |
| `run_tests` | Run tests with observability — structured pass/fail with runtime context at failures |
| `check_data_freshness` | Check if runtime data exists and how old it is |
| `refresh_runtime_data` | Re-run the app to capture fresh data (returns summary) |

---

## Use Case 6: Debugging Slow Database Queries

```bash
trickle context --queries
```

Shows all database operations with timing — agents can immediately spot N+1 queries or slow operations:

```
  sqlite3   2.79ms  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)
  sqlite3   0.06ms  INSERT INTO users VALUES ('Alice', 'alice@test.com')
  sqlite3  45.20ms  SELECT * FROM users WHERE email LIKE '%test%'  ← slow!
  redis     0.12ms  GET session:user123
  pymongo   3.40ms  db.orders.find({"user_id": "123"})
```

**Supported databases (auto-detected, zero config):**
- SQL: PostgreSQL (pg/psycopg2), MySQL (mysql2/pymysql), SQLite (better-sqlite3/sqlite3)
- Redis: ioredis (JS), redis-py (Python)
- MongoDB: mongoose (JS), pymongo (Python)

---

## Use Case 7: Auto-Remediation Loop

The full detect → heal → verify pipeline for autonomous bug fixing:

```bash
# 1. Capture runtime data
trickle run python app.py

# 2. Save baseline metrics
trickle verify --baseline

# 3. Get fix plans with context
trickle heal --json
```

Each heal plan includes the alert, relevant context (queries, call trace, variable values), a fix recommendation, and confidence level. The agent reads the plan, applies the fix, then verifies:

```bash
# 4. After agent applies fix, re-run
trickle run python app.py

# 5. Compare metrics
trickle verify
```

Output:
```
  Alerts                    2 →      0   ↓ 2
  N+1 Queries               1 →      0   ↓ 1
  Max Function (ms)    1843.2 →   12.3   ↓ 1830.9
  ✓ Fix verified — 3 metric(s) improved, 0 regressed
```

---

## Complete Data Available to Agents

After one run with trickle, agents have access to:

| Data | File | Description |
|---|---|---|
| Variable values | `variables.jsonl` | Every variable's type and sample value |
| Function types | `observations.jsonl` | Signatures, params, return types, execution timing (ms) |
| Call trace | `calltrace.jsonl` | Execution flow with parent-child relationships |
| Database queries | `queries.jsonl` | SQL/Redis/MongoDB operations with timing + row counts |
| Distributed traces | `traces.jsonl` | Cross-service request flow with trace IDs |
| HTTP requests | `observations.jsonl` | fetch() calls with URL, status, latency, response type |
| WebSocket events | `websocket.jsonl` | ws/socket.io messages with data previews |
| Memory profile | `profile.jsonl` | RSS + heap snapshots at start/end |
| Console output | `console.jsonl` | All console.log/error/warn output |
| Error context | `errors.jsonl` | Crash info with nearby variable values |
| Alerts | `alerts.jsonl` | Detected anomalies with severity + fix suggestions |
| Heal plans | `heal.jsonl` | Remediation plans with context for agent auto-fix |
