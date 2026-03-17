# Observability Platform: Replace Datadog with Agent-Powered Debugging

You're running a production application and need full observability — but Datadog costs $23/host/month and the dashboards take hours to set up. Trickle gives you the same visibility with zero configuration, plus AI agents that automatically detect and fix issues.

## Install

```bash
npm install -g trickle-cli
pip install trickle-observe    # for Python apps
npm install trickle-observe    # for Node.js apps
```

## Quick Start

```bash
# One command captures everything
trickle run python app.py
# or
trickle run node server.js
```

That's it. No code changes, no config files, no dashboard setup. Trickle auto-patches your database drivers, HTTP clients, and WebSocket connections.

---

## What Gets Captured (Automatically)

| Data Type | What | Drivers Auto-Patched |
|-----------|------|---------------------|
| Variables | Every variable assignment with type + value | — |
| Functions | Signatures, params, return types, execution time | — |
| Call Trace | Which function called which, parent-child flow | — |
| DB Queries | SQL text, timing, row counts, columns | pg, mysql2, sqlite3, psycopg2, pymysql, redis, pymongo, **Prisma**, **SQLAlchemy**, **Django ORM**, Knex, Drizzle, **Sequelize**, **TypeORM** |
| HTTP Requests | URL, method, status, latency, response shape | requests, httpx, fetch |
| WebSocket | Messages sent/received, connect/close events | ws, socket.io |
| Console Output | All stdout/stderr with timestamps | — |
| Structured Logs | Level, message, metadata from loggers | winston, pino, bunyan (JS); logging, loguru, structlog (Python) |
| Errors | Stack trace + variable values at crash site | — |
| Memory | RSS + heap snapshots at start/end | — |
| Distributed Traces | Cross-service request flow via trace IDs | X-Trickle-Trace-Id headers |

## Use Case 1: Detect N+1 Queries

```bash
trickle run python app.py
trickle monitor
```

Output:
```
  trickle monitor
  ──────────────────────────────────────────────────
  1 critical issue(s)
    ✗ N+1 query pattern: "SELECT * FROM users WHERE id = ?" executed 10 times
      → Use a JOIN or batch query instead
  1 warning(s)
    ⚠ Slow function: get_dashboard took 234ms
      → Profile get_dashboard — check database calls inside
  ──────────────────────────────────────────────────
```

No manual query profiling needed. Trickle detects the pattern automatically.

## Use Case 2: Auto-Fix with AI Agent

```bash
# 1. Save baseline
trickle verify --baseline

# 2. Get fix plan
trickle heal --json
```

The heal plan includes the detected issue, relevant queries, call trace, and a specific fix recommendation:

```json
{
  "alert": { "severity": "critical", "category": "n_plus_one" },
  "context": {
    "queries": [5 matching queries],
    "callTrace": [execution flow showing the loop]
  },
  "recommendation": "Replace the N+1 pattern with a batch query using IN clause",
  "confidence": "high"
}
```

Your AI agent reads this, applies the fix, then verifies:

```bash
# 3. After fix, re-run and compare
trickle run python app.py
trickle verify
```

```
  N+1 Queries        1 →      0   ↓ 1
  Max Function (ms)  234 →    12   ↓ 222
  ✓ Fix verified — 2 metric(s) improved
```

## Use Case 3: Webhook Alerts (Like PagerDuty)

```bash
trickle monitor --webhook https://hooks.slack.com/services/... --watch
```

Sends Slack alerts whenever new issues are detected. The `--watch` flag continuously monitors for changes.

## Use Case 4: Local Dashboard (Like Datadog UI)

```bash
trickle dashboard-local
```

Opens a dark-themed HTML dashboard at `http://localhost:4321` showing:
- Alert summary cards (critical/warning/ok)
- Function timing table (sorted by duration)
- Database query table (sorted by duration)
- Memory profile (RSS/heap at start/end)
- Error list with stack traces

Also serves a JSON API at `/api/data` for custom integrations.

## Use Case 5: APM Metrics (Like Datadog APM)

```bash
trickle run python app.py
trickle metrics
```

Output:
```
  Summary
    Functions: 14  |  Calls: 15  |  Queries: 40
    Errors: 1 (6.7%)  |  Logs: 5  |  Traces: 14
    Memory: 18MB → 247MB (+228MB)

  Function Latency
    Function                Calls   p50      p95      p99    Errors
    list_orders                 1   23.6ms   23.6ms   23.6ms   0
    create_product              4   17.4ms   17.4ms   17.4ms   0
    get_product                 2    7.0ms    7.0ms    7.0ms   1

  Query Performance
    Query                           Calls   p50     p95     Total
    INSERT INTO products ...            4   0.3ms   0.5ms   1.4ms
    SELECT products.id ...             12   0.1ms   0.1ms   1.0ms
```

Also available as: `trickle metrics --json` (agent consumption) or `trickle metrics --html` (browser dashboard).

## Use Case 6: Custom Alerting Rules

```bash
# Create a rules file with default thresholds
trickle rules init
# → Creates .trickle/rules.json

# Customize thresholds
# Edit .trickle/rules.json:
#   - Lower N+1 threshold to 3 (default: 5)
#   - Set slow query critical at 200ms (default: 500ms)
#   - Enable SELECT * detection
#   - Enable total query count limit

# Monitor respects your custom rules
trickle monitor
#   ✗ N+1 query pattern detected (threshold: 3)
#   ⚠ 40 queries executed (limit: 20)
#   ⚠ SELECT * detection: 2 queries match

# View active rules
trickle rules list
```

Available rule categories: `slow_query`, `n_plus_one`, `slow_function`, `memory`, `error`, `deep_call_stack`, `query_count`, `query_pattern` (regex).

## Use Case 6: Production Deployment

```bash
# Low overhead: sample 1% of calls, disable variable tracing
TRICKLE_PRODUCTION=1 TRICKLE_SAMPLE_RATE=0.01 trickle run python app.py
```

In production mode:
- Variable tracing disabled (zero overhead for most code)
- Only 1% of function calls get full type observation
- Errors are **always** captured regardless of sample rate
- Database queries, HTTP requests, and console output still traced

## Use Case 6: Distributed Tracing

```bash
# Service A
TRICKLE_SERVICE_NAME=user-api trickle run python user_service.py

# Service B
TRICKLE_SERVICE_NAME=order-api trickle run python order_service.py
```

Trickle automatically injects `X-Trickle-Trace-Id` headers into outgoing HTTP requests, linking observations across services.

## Use Case 7: MCP Server for Agent Access

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

15 tools available — agents can query any aspect of your application's runtime behavior without adding console.log or re-running code.

## Use Case 8: Cloud Dashboard & Team Sharing

```bash
# One-time setup: authenticate with the cloud
trickle cloud login --url https://cloud.trickle.dev

# After that, every trickle run auto-pushes to cloud
trickle run python app.py
# → all data (variables, calltrace, queries, errors, alerts)
#   automatically uploaded after run completes
```

View your project:
```bash
trickle cloud projects
#   my-api — 10 files, 45KB, updated today

trickle cloud share
#   ✓ Share link created
#   URL: https://cloud.trickle.dev/api/v1/shared/abc123
#   Expires: 7 days
```

Share the URL with your team — anyone can view the dashboard without authentication. The hosted dashboard shows:
- Alert summary (critical/warning/ok)
- Runtime errors with stack traces
- Performance hotspots with bar charts
- Database queries sorted by duration
- Observed functions with types

Pull data to another machine:
```bash
# On any machine with the same project name
trickle cloud pull
# → downloads all data to .trickle/
trickle status
# → shows the full picture
```

Self-host the cloud backend:
```bash
# Docker
docker run -p 4888:4888 -v trickle-data:/data trickle-backend

# Or fly.io
cd packages/backend && fly deploy
```

## Comparison with Datadog

| Feature | Datadog | trickle |
|---------|---------|---------|
| Setup | Dashboard config, agent install, API keys | `trickle run app.py` |
| Pricing | $23/host/month | Free (open source) + self-hostable |
| Variable values | No | Yes — every assignment |
| Function signatures | No | Yes — with param types |
| N+1 detection | Manual query analysis | Automatic |
| Auto-fix | No | Yes — `trickle heal` |
| AI agent access | Limited API | 26 MCP tools |
| Code changes | SDK instrumentation | Zero |
| Cloud dashboard | Hosted SaaS | Self-hosted or cloud.trickle.dev |
| Team sharing | Paid feature | Free — shareable links |
| Local dashboard | No | `trickle dashboard-local` |
| Production mode | Always on | Configurable sampling |
| Data ownership | Datadog's servers | Your infrastructure |
