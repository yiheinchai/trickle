# SRE / Platform Engineer: Production Observability Without Vendor Lock-in

You're responsible for keeping services running. Datadog costs are spiraling ($23/host/month × 200 hosts = $55K/year), and your team still spends hours building custom dashboards. Trickle gives you full observability with zero vendor lock-in — self-hosted, open source, and auto-configured.

## Install

```bash
npm install -g trickle-cli
pip install trickle-observe    # for Python services
npm install trickle-observe    # for Node.js services
```

## Quick Start: Deploy the Cloud Backend

```bash
# Option 1: Docker (recommended)
docker run -d \
  -p 4888:4888 \
  -v trickle-data:/data \
  --name trickle-cloud \
  trickle-backend

# Option 2: fly.io
cd packages/backend && fly deploy

# Option 3: Any Node.js host
npm install -g trickle-backend
TRICKLE_DB_PATH=/var/data/trickle.db trickle-backend
```

## Use Case 1: Instrument All Services (Zero Code Changes)

```bash
# Instead of: node server.js
trickle run node server.js

# Instead of: python app.py
trickle run python app.py

# Instead of: gunicorn app:app
trickle run gunicorn app:app
```

That's it. No SDK integration, no config files, no code changes. Trickle auto-patches:
- **Database drivers**: pg, mysql2, sqlite3, psycopg2, pymysql, redis, pymongo, **Prisma**, **SQLAlchemy**, **Django ORM**, Knex, Drizzle, **Sequelize**, **TypeORM**
- **HTTP clients**: fetch, requests, httpx
- **WebSocket**: ws, socket.io
- **Logging**: winston, pino, bunyan (JS); Python logging, loguru, structlog; console.log

## Use Case 2: Team Dashboard

```bash
# Each developer authenticates once
trickle cloud login --url https://trickle.internal:4888

# Every trickle run auto-pushes all data
trickle run python app.py
# → variables, calltrace, queries, errors, alerts
#   all pushed to the cloud automatically

# Share dashboard with the team
trickle cloud share
#   URL: https://trickle.internal:4888/api/v1/shared/abc123
```

The dashboard shows:
- **Status**: HEALTHY / WARNING / CRITICAL
- **Alerts**: N+1 queries, deep call stacks, runtime errors
- **Performance hotspots**: sorted by duration with visual bars
- **Database queries**: sorted by duration, repeated query detection
- **Observed functions**: signatures with timing
- **Memory profile**: RSS + heap at start/end

## Use Case 3: CI/CD Integration

```yaml
# .github/workflows/trickle.yml
name: Observability Check
on: [pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm install -g trickle-cli

      # One command: run tests + detect issues + annotate PR
      - run: trickle ci "npm test"
        # Detects: N+1 queries, slow functions, errors, memory issues
        # Posts ::error:: and ::warning:: annotations on the PR
```

## Use Case 4: Auto-Remediation Loop

```bash
# 1. Detect issues
trickle run python app.py
trickle monitor
#   ✗ N+1 query: "SELECT * FROM orders WHERE user_id = ?" × 10

# 2. Get fix plan (consumable by AI agents)
trickle heal --json
#   {
#     "alert": { "severity": "critical", "category": "n_plus_one" },
#     "recommendation": "Replace with JOIN or batch query",
#     "confidence": "high",
#     "context": { "queries": [...], "callTrace": [...] }
#   }

# 3. AI agent applies fix, then verify
trickle verify --baseline   # save current metrics
# ... agent applies fix ...
trickle run python app.py
trickle verify
#   N+1 Queries: 1 → 0  ↓ 1
#   ✓ Fix verified
```

## Use Case 5: Production Mode

```bash
# Low overhead for production
TRICKLE_PRODUCTION=1 TRICKLE_SAMPLE_RATE=0.01 trickle run python app.py
```

Production mode:
- Variable tracing disabled (zero overhead)
- 1% function call sampling
- Errors always captured (100%)
- DB queries, HTTP, WebSocket still traced
- Memory profiling at start/end only

## Use Case 6: Webhook Alerts

```bash
# Slack alerts for detected issues
trickle monitor --webhook https://hooks.slack.com/services/... --watch
```

## Use Case 7: SLO Monitoring

```bash
# Define SLOs
trickle slo init
# → Creates .trickle/slos.json with defaults:
#   - 99% of requests < 500ms
#   - 99% availability (error rate < 1%)
#   - 95% of queries < 100ms

# Check compliance
trickle slo check
#   ✓ Request Latency — Target: 99%  |  Actual: 100%  |  Budget: 100%
#   ✗ Error Rate — Target: 99%  |  Actual: 93.3%  |  Budget: 0%
#   ✓ Query Latency — Target: 95%  |  Actual: 100%  |  Budget: 100%

# CI integration (exit 1 on breach)
trickle slo check --json  # structured output for automation
```

## Use Case 8: Team Management (RBAC)

```bash
# Create a team for your org
trickle cloud team create "Platform Engineering"
#   ✓ Team "Platform Engineering" created
#   ID: abc123...

# Invite team members (they need an API key first via `trickle cloud login`)
trickle cloud team invite --team abc123 --key-id <bobs-key-id> --role admin
trickle cloud team invite --team abc123 --key-id <carols-key-id> --role member
trickle cloud team invite --team abc123 --key-id <daves-key-id> --role viewer

# Share a project with the team
trickle cloud team add-project --team abc123 --project my-api

# Team members can now pull and view your project
# (Bob runs on his machine:)
trickle cloud pull  # downloads team project data

# View team details
trickle cloud team info --team abc123
```

**Roles:**
| Role | View dashboards | Push data | Manage projects | Invite members | Remove members |
|------|:-:|:-:|:-:|:-:|:-:|
| **viewer** | ✓ | | | | |
| **member** | ✓ | ✓ | ✓ (own) | | |
| **admin** | ✓ | ✓ | ✓ | ✓ | ✓ (below rank) |
| **owner** | ✓ | ✓ | ✓ | ✓ | ✓ |

## Use Case 8: MCP Server for AI Agents

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

26 MCP tools available — AI agents can query runtime data, detect issues, generate flamegraphs, run root cause analysis, and apply fixes without human intervention. Key tools: `get_recommended_actions` (guided workflow), `get_last_run_summary` (complete overview), `explain_file` (understand any file), `get_flamegraph` (performance hotspots).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TRICKLE_PRODUCTION` | `0` | Enable production mode (lower overhead) |
| `TRICKLE_SAMPLE_RATE` | `1.0` | Function observation sample rate (0.01 = 1%) |
| `TRICKLE_CLOUD_URL` | — | Cloud backend URL |
| `TRICKLE_CLOUD_TOKEN` | — | API key (or use `trickle cloud login`) |
| `TRICKLE_DB_PATH` | `~/.trickle/trickle.db` | Backend database path |
| `TRICKLE_RATE_LIMIT` | `300` | API rate limit (requests/minute) |
| `TRICKLE_RETENTION_DAYS` | `30` | Data retention period |
| `TRICKLE_CORS_ORIGINS` | `*` | Allowed CORS origins (comma-separated) |

## Cost Comparison

| | Datadog | trickle |
|---|---|---|
| 200 hosts | $55,200/year | $0 (self-hosted) |
| Setup time | Days | Minutes |
| Code changes | SDK integration | None |
| Data ownership | Datadog servers | Your infrastructure |
| AI agent access | Limited API | 26 MCP tools |
| Auto-fix | No | Yes (heal + verify) |
| Lock-in | High | None (open source) |
