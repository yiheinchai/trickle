# AI Coding Agent: 10x Debugging with Runtime Observability

You're an AI coding agent (Claude Code, Cursor, Copilot, etc.) working on a codebase. Instead of guessing at runtime behavior or asking users to add console.log statements, use trickle to see exactly what happened at runtime — variable values, function signatures, database queries, errors with context, and performance hotspots.

## Setup (30 seconds)

```bash
npm install -g trickle-cli
trickle init              # creates CLAUDE.md, .claude/settings.json, config
trickle run node app.js   # or: trickle run python app.py
```

`trickle init` auto-creates `.claude/settings.json` with the MCP server config, so Claude Code can use all 26 tools immediately.

---

## The Agent On-Call Loop

The complete autonomous debugging workflow:

```
1. DETECT    →  get_last_run_summary    (status, errors, alerts, root causes)
2. UNDERSTAND →  explain_file           (functions, call graph, data flow, queries)
3. BASELINE  →  save_baseline           (save metrics before fixing)
4. FIX       →  agent edits code        (guided by root causes + heal plans)
5. VERIFY    →  refresh_runtime_data    (re-run the app)
              →  compare_with_baseline  ("Fix verified — 3 metrics improved")
```

Or for quick triage: `get_recommended_actions` tells you exactly what to do next.

---

## Use Case 1: Get a Complete Overview in One Call

```bash
trickle summary
```

Returns everything in one structured JSON:

```json
{
  "status": "warning",
  "counts": { "functions": 9, "queries": 25, "errors": 0, "logs": 4 },
  "rootCauses": [
    { "severity": "warning", "category": "n_plus_one",
      "description": "N+1: \"SELECT * FROM users WHERE id = ?\" repeated 15 times",
      "suggestedFix": "Replace with JOIN or batch query using IN clause" }
  ],
  "alerts": [...],
  "functions": { "signatures": [...] },
  "queries": { "nPlusOnePatterns": [...], "slowQueries": [...] },
  "healPlans": [{ "recommendation": "...", "confidence": "high" }]
}
```

One call replaces: `get_errors` + `get_alerts` + `get_database_queries` + `get_function_signatures` + `get_performance_profile` + `get_heal_plans`.

---

## Use Case 2: Understand Any File Instantly

```bash
trickle explain src/api.ts
```

Shows everything about a file via runtime data:

```
Functions:
  → GET /api/posts() -> Post[]                         (14.5ms)
  → POST /api/users(body: { name: string }) -> User    (3.2ms)

Data Flow:
  GET /api/posts: () → Post[]
    out: [{"id":1,"title":"Hello World","author":"Alice"}]
  POST /api/users: (body: { name: string }) → User
    in: [{"name":"Bob"}]
    out: {"id":2,"name":"Bob","email":"bob@example.com"}

Call Graph:
  Callers: server.handleRequest → api.GET /api/posts ×3
  Callees: api.GET /api/posts → db.getUser ×15 (N+1!)

Variables:
  L13 user: { id: number, name: string } = {"id":1,"name":"Alice"}
  L25 result: undefined = null   ← bug here!

Database Queries: 4 unique (SELECT * FROM posts, SELECT * FROM users WHERE id = ?, ...)
Alerts: N+1 pattern detected, suggestion: use JOIN
```

---

## Use Case 3: Debug Errors with Variable Context

```bash
trickle context --errors
```

Errors now include **variable values at the error location**:

```
TypeError: 'NoneType' object is not iterable
  at app.py:5 (get_user)

Variable context:
  L3 user_id: integer = 3
  L4 row: null               ← root cause: DB returned nothing
  L5 <return>: dict = {'id': 1, 'name': 'Alice'}  (from a previous successful call)
```

The agent sees `row = null` for `user_id = 3` — the database has no user 3, and the code doesn't handle None.

---

## Use Case 4: Performance Profiling

```bash
trickle flamegraph
```

Generates an interactive HTML flamegraph + text hotspot analysis:

```
Hotspots:
  █████████████████░░░  83.2%  1.24ms  app.listAllUserOrders
  ████░░░░░░░░░░░░░░░░  17.4%  0.26ms  app.getUserOrders
  ███░░░░░░░░░░░░░░░░░  10.7%  0.16ms  app.riskyOperation

Call tree:
  app.listAllUserOrders (1.24ms)
    app.getUserOrders (0.07ms)
    app.getUserOrders (0.05ms)    ← N+1 visible in tree!
    app.getUserOrders (0.05ms)
    app.getUserOrders (0.05ms)
    app.getUserOrders (0.04ms)
  app.riskyOperation (0.16ms) ✗ error
```

---

## Use Case 5: Smart Test Running

```bash
trickle test                    # auto-detect framework (jest, pytest, vitest, mocha)
trickle test "npm test" --json  # structured output for agents
```

Returns structured pass/fail with runtime context at failure points:

```json
{
  "summary": { "passed": 9, "failed": 1, "total": 10 },
  "failures": [{
    "test": "test_get_user_not_found",
    "error": { "message": "assert user is not None" },
    "runtimeContext": {
      "variablesNearFailure": [{ "name": "user_id", "value": 999, "type": "int" }],
      "queriesDuringTest": [{ "query": "SELECT * FROM users WHERE id = 999", "durationMs": 0.1 }]
    }
  }],
  "observability": {
    "functionsObserved": 10,
    "queriesCaptured": 69,
    "alerts": [{ "severity": "warning", "message": "N+1 pattern detected" }]
  }
}
```

---

## Use Case 6: Before/After Fix Verification

```bash
# 1. Save current state
trickle verify --baseline

# 2. Agent fixes the N+1 query (replaces loop with JOIN)

# 3. Re-run and compare
trickle run python app.py
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

## Use Case 7: Production Monitoring

```bash
trickle watch-alerts --webhook https://hooks.slack.com/services/... --interval 5
```

Continuous monitoring that outputs JSON events for new alerts:

```json
{"kind":"alert","timestamp":"2026-03-15T18:35:26Z","alerts":[
  {"severity":"critical","category":"n_plus_one","message":"SELECT * FROM users repeated 20 times"}
]}
```

Via MCP: `get_new_alerts` returns only NEW alerts since last check (deduplication built in).

---

## Use Case 8: Auto-Remediation

```bash
trickle heal --json
```

Each heal plan includes: detected issue, relevant context (queries, call trace, variable values), fix recommendation, and confidence level:

```json
{
  "alert": { "severity": "critical", "category": "n_plus_one" },
  "context": {
    "queries": [{"query": "SELECT * FROM users WHERE id = ?", "count": 15}],
    "callTrace": [{"function": "listAllUserOrders", "children": ["getUserOrders ×15"]}]
  },
  "recommendation": "Replace with JOIN: SELECT p.*, u.name FROM posts p JOIN users u ON p.user_id = u.id",
  "confidence": "high"
}
```

---

## Use Case 9: Runtime Types in Terminal (for AI Agents)

```bash
trickle hints file.py
```

Outputs the original source code with inline type annotations derived from runtime observations — no type stubs, no guessing. AI agents can read this directly to understand what every variable actually is at runtime.

**Basic usage — show inferred types inline:**

```bash
trickle hints app.py
```

```
# app.py (3 functions observed)

def get_user(user_id: int) -> dict:
    db: sqlite3.Connection = ...
    row: tuple | None = db.execute("SELECT ...", (user_id,)).fetchone()
    return {"id": row[0], "name": row[1]}
```

**Error mode — show crash-time values with underline markers:**

```bash
trickle hints --errors
```

```
# main.py — ERROR
# ValueError: could not convert string to float: 'ID' (line 20)
# Variables at crash time:

data_dir: PosixPath = "../data/gaitpdb/1.0.0" = Path(...)
file_path: string = "demographics.txt"
    [float(d) for d in time.split("\t")] for time in patient_gait_data
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~  <- ValueError: could not convert string to float: 'ID'
```

The `~~~` underline points directly at the expression that raised. The agent sees exactly which value caused the crash without reading logs or adding print statements.

**Configurable display — types, values, or both:**

```bash
trickle hints app.py --show types    # only type annotations
trickle hints app.py --show values   # only runtime values
trickle hints app.py --show both     # types + values (default)
```

**Typical agent workflow:**

```bash
# 1. Run the program with trickle instrumentation
trickle run python app.py

# 2. If it crashes, inspect errors with inline context
trickle hints --errors

# 3. If it succeeds, inspect any file for runtime types
trickle hints app.py
```

This replaces the pattern of reading error logs, grepping for variable names, and manually correlating stack traces to source lines. One command gives the agent a fully annotated view of the source at the moment of failure.

---

## MCP Server Integration

`trickle init` auto-creates `.claude/settings.json`:

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

**26 MCP tools available:**

| Tool | What it does |
|---|---|
| **`get_recommended_actions`** | **Start here** — analyzes state, tells you which tools to call and in what order |
| **`get_last_run_summary`** | Complete overview: status, errors, queries, signatures, root causes, fix recommendations |
| **`explain_file`** | Understand a file: functions, call graph, data flow with sample I/O, queries, variables |
| **`run_tests`** | Smart test runner: structured pass/fail with runtime context at failures |
| **`get_flamegraph`** | Performance hotspots sorted by time with call tree |
| `get_errors` | Errors with variable values at the error location |
| `get_alerts` | Detected anomalies (N+1 queries, slow functions, memory) with fix suggestions |
| `get_heal_plans` | Auto-fix recommendations with context and confidence level |
| `get_runtime_context` | Variable values + function types for a specific file |
| `get_annotated_source` | Source code with inline runtime values as comments |
| `get_function_signatures` | All function signatures with parameter types and timing |
| `get_call_trace` | Call tree with parent-child relationships and timing |
| `get_database_queries` | SQL, Redis, MongoDB queries with timing + row counts |
| `get_distributed_traces` | Cross-service request flow with trace IDs |
| `get_logs` | Structured log entries from logging frameworks |
| `get_websocket_events` | WebSocket/socket.io messages |
| `get_performance_profile` | Memory usage (RSS + heap) snapshots |
| `get_doctor` | Health check with root causes and recommended next actions |
| `get_environment` | Runtime, platform, and framework detection |
| `get_console_output` | Captured console.log/error/warn output |
| `get_http_requests` | HTTP fetch calls with status + latency |
| `get_flamegraph` | Performance flamegraph with hotspot analysis |
| `get_new_alerts` | Only NEW alerts since last check (polling-based monitoring) |
| `save_baseline` | Save current metrics before making changes |
| `compare_with_baseline` | Compare metrics against baseline (fix verification) |
| `check_data_freshness` | Check if runtime data exists and how old it is |
| `refresh_runtime_data` | Re-run the app and return comprehensive summary |

---

## What trickle Captures (automatically, zero config)

| Data | Description |
|---|---|
| **Functions** | Signatures, params, return types, execution timing, sample I/O |
| **Variables** | Types + runtime values at each line (including tensor shapes for ML) |
| **Database queries** | SQL text, duration, row count — pg, mysql2, sqlite3, Prisma, SQLAlchemy, Django ORM, Knex, Sequelize, TypeORM, Drizzle |
| **Errors** | Stack trace + variable values at the error location |
| **Logs** | winston, pino, bunyan (JS); logging, loguru, structlog (Python) |
| **HTTP requests** | fetch/requests calls with URL, status, latency, response type |
| **Call traces** | Execution flow with parent-child relationships + timing |
| **WebSocket** | ws, socket.io connections and messages |
| **Memory** | RSS + heap snapshots at start/end |
| **Distributed traces** | Cross-service request flow with trace IDs |

**Supported frameworks**: Express, FastAPI, Flask, Django, Next.js, React, Vue, Svelte
**Languages**: JavaScript, TypeScript, Python
**Test frameworks**: Jest, Vitest, Pytest, Mocha
