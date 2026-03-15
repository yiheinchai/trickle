# trickle

**Runtime type observability for JavaScript and Python.** Run your code, get types — in your IDE, automatically.

```
# One command. Types appear in VSCode as your code runs.
trickle run python app.py
```

Trickle observes your running code and captures the actual types flowing through your functions and variables. No manual type annotations, no guessing — just run your code and get full type information in your IDE.

## Who is this for?

Pick your role. Each guide has install instructions, quick start, and real-world use cases.

### ML Engineers / Data Scientists

> *"I'm tired of printing tensor shapes everywhere."*

Run `%load_ext trickle` in your Jupyter notebook. Every variable gets inline type hints — tensor shapes, dtypes, model architectures, training loss trends. No more `print(x.shape)`.

```python
%load_ext trickle

model = nn.Linear(784, 10)       # → Linear(7850 params 30.7 KB)
x = torch.randn(32, 784)        # → Tensor[32, 784] float32 98.0 KB
output = model(x)               # → Tensor[32, 10] float32
loss = criterion(output, target) # → Tensor[] float32 = 2.3041

# Training loops track loss evolution automatically:
# [trickle] Scalar tracking:
#   loss (L7): 2.513 ↓ 0.209 (min=0.2025, max=2.513, 50 steps)
```

**What gets traced:** Tensors (shape, dtype, device, memory), nn.Modules (params, memory, train/eval, gradient norms after backward), optimizers, schedulers, DataLoaders, datasets, HuggingFace datasets/DatasetDict, gradient context, NaN/Inf detection in tensors and gradients, return values, and more.

**[Full ML Engineer Guide →](usecases/ml-engineer.md)**

---

### Data Scientists / Analysts

> *"I'm tired of calling `df.shape` and `df.head()` after every operation."*

`%load_ext trickle` in Jupyter. Every DataFrame, Series, GroupBy, and sklearn model shows its key info inline.

```python
%load_ext trickle

df = pd.read_csv("sales.csv")       # → DataFrame(10000 rows x 12 cols, 1.2 MB)
revenue = df["revenue"]             # → Series(10000, float64, "revenue")
grouped = df.groupby("region")      # → DataFrameGroupBy(by=region, 5 groups, size=1800-2200)

model = RandomForestClassifier(n_estimators=100, max_depth=5)
model.fit(X_train, y_train)         # → RandomForestClassifier(n_estimators=100, max_depth=5) [5 features, 2 classes]
```

**What gets traced:** DataFrames, Series, GroupBy, Index/MultiIndex, sklearn models (30+ estimators with fitted status), pipelines, NumPy arrays, tensors.

**[Full Data Scientist Guide →](usecases/data-scientist.md)**

---

### Python Developers

> *"I have a Python codebase with no type annotations. I don't want to add them manually."*

One import. Run your code. Get `.pyi` stub files with full type signatures. Your IDE immediately gets autocomplete and type checking.

```python
import trickle.auto

# Your code runs normally. When it finishes:
# → .pyi files appear next to your source files
# → IDE autocomplete works immediately
```

Or without any code changes:
```bash
trickle run python app.py        # auto-instruments everything
trickle stubs src/               # generates .pyi files
trickle annotate src/utils.py    # injects types into source
```

**[Full Python Developer Guide →](usecases/python-developer.md)**

---

### Frontend Developers

> *"The backend team ships endpoints faster than they write docs. I'm guessing at response shapes."*

Generate a fully typed API client from real API traffic — always in sync with what the backend actually returns.

```bash
# No backend changes needed — run a transparent proxy
trickle proxy --target http://localhost:3000 --port 4000

# Use your app normally, then generate types
trickle codegen --client -o src/api-client.ts
```

```typescript
const users = await api.getApiUsers();
// TypeScript knows: { id: number; name: string; email: string }[]
```

Also generates: React Query hooks, SWR hooks, Axios clients, MSW mock handlers, JSON Schema.

**[Full Frontend Developer Guide →](usecases/frontend-developer.md)**

---

### Backend / API Developers

> *"I want types and OpenAPI specs without maintaining them by hand."*

Run your server through trickle. It captures every request/response type and generates TypeScript interfaces, OpenAPI specs, and validation middleware.

```bash
trickle run node app.js          # or: trickle run uvicorn app:app

# After hitting some endpoints:
trickle codegen --handlers       # typed Express handler signatures
trickle openapi                  # OpenAPI 3.0 spec from real traffic
trickle codegen --zod            # Zod validation schemas
```

**[Full Backend Developer Guide →](usecases/backend-api-developer.md)**

---

### Full-Stack Developers

> *"I own both frontend and backend. I want end-to-end type safety without maintaining types in two places."*

```bash
trickle init                     # one-time setup
trickle dev                      # types update as you develop
```

Types flow from your API to your frontend client automatically. Change a backend response → your frontend types update → TypeScript catches the mismatch.

**[Full Full-Stack Guide →](usecases/fullstack-developer.md)**

---

### DevOps / CI Engineers

> *"I want to catch breaking API changes before they reach production."*

```bash
# Save baseline (in CI, on main branch)
trickle run npm test
trickle check --save baseline.json

# On PRs: detect breaking changes (exits non-zero if breaking)
trickle run npm test
trickle check --against baseline.json
```

Or use the new one-command CI integration:
```yaml
# GitHub Actions
- run: npx trickle ci "python -m pytest tests/"
# Detects N+1 queries, slow functions, errors → annotations on PR
```

**[Full DevOps Guide →](usecases/devops-ci.md)** | **[Example Workflow →](.github/workflows/trickle-example.yml)**

---

### QA / Test Engineers

> *"I want to catch API regressions without hand-writing contract tests."*

```bash
trickle run npm test             # capture real types
trickle check --against baseline # detect regressions
trickle test --generate          # auto-generate API tests
```

**[Full QA Guide →](usecases/qa-engineer.md)**

---

### AI Coding Agents (Claude Code, Cursor, Copilot)

> *"My agent keeps adding console.log to debug. There must be a better way."*

Trickle caches **full runtime state** so AI agents can debug autonomously without re-running your code:

```bash
trickle run node app.js          # capture everything once
```

Agents then query the cached data — no more edit→run→read cycles:

```bash
trickle context src/api.ts --annotated   # source + runtime values
```
```
  13 | const user = createUser(body.name, body.email);  // user = {"id":1,"name":"Alice",...}
  19 | const count = users.length;                       // count = 3
  25 | const user = getUser(id);                         // user = null  ← bug!
```

**What agents can query (12 data types):**

| Data | Command | Description |
|------|---------|-------------|
| Health check | `trickle doctor` | One-shot overview: status, counts, issues, memory |
| Variables | `trickle context <file>` | Types + actual values at every line |
| Functions | `trickle functions` | Signatures with parameter types + timing |
| Call trace | `trickle context --trace` | Which function called which, execution flow |
| Errors | `trickle context --errors` | Stack trace + nearby variable values |
| DB Queries | `trickle context --queries` | SQL/Redis/MongoDB with timing + row counts (Prisma, SQLAlchemy, Knex, Drizzle auto-patched) |
| HTTP | `trickle context --http` | Fetch calls with status codes + response types |
| Logs | `trickle context --logs` | Structured logging events with levels + context |
| Console | `trickle context --console` | All stdout/stderr with timestamps |
| Memory | `trickle context --profile` | RSS + heap snapshots at start/end |
| Traces | `trickle context --traces` | Distributed spans across microservices |
| Environment | `trickle context --env` | Runtime version, env vars, detected frameworks |

**Auto-remediation pipeline:**
```bash
trickle run python app.py       # capture everything
trickle monitor                  # detect N+1 queries, slow functions, errors
trickle heal                     # generate fix plans for agents
trickle verify                   # compare before/after metrics
```

**MCP Integration** — 18 tools for direct agent access:
```json
{ "mcpServers": { "trickle": { "command": "npx", "args": ["trickle-cli", "mcp-server"] } } }
```

Key tools: `get_doctor` (start here), `get_heal_plans`, `get_alerts`, `get_call_trace`, `get_database_queries`, `get_logs`, `get_distributed_traces`, `get_performance_profile`, `get_environment`, and 9 more.

```bash
trickle init                     # creates CLAUDE.md with agent debugging workflow
```

**[Full AI Agent Guide →](usecases/ai-agent.md)** | **[LLM Tool Schema Guide →](usecases/ai-developer.md)**

---

### Legacy Codebase Explorers

> *"I inherited a codebase with no docs, no types, and no tests. I need to understand what it does."*

```bash
trickle run node server.js       # observe the running app
trickle overview                 # see all endpoints and types
trickle search "email"           # find where fields flow
trickle codegen --docs           # generate API documentation
```

**[Full Legacy Codebase Guide →](usecases/legacy-codebase.md)**

---

### Teams Replacing Datadog / New Relic

> *"We're paying $23/host/month for dashboards we barely use. There must be a simpler way."*

```bash
trickle run python app.py           # captures everything automatically
trickle monitor                     # detects N+1 queries, slow functions, memory issues
trickle heal                        # generates fix plans for AI agents
trickle dashboard-local             # self-contained HTML dashboard
trickle monitor --webhook <url>     # Slack/Discord alerts
```

Zero config, zero code changes. Auto-detects databases (PostgreSQL, MySQL, SQLite, Redis, MongoDB), HTTP clients, and WebSocket connections. Production mode with configurable sampling.

**[Full Observability Platform Guide →](usecases/observability-platform.md)**

---

## Install

### JavaScript / TypeScript

```bash
npm install trickle-observe      # runtime library
npm install -g trickle-cli       # CLI tools
```

### Python

```bash
pip install trickle-observe
```

### VSCode Extension

Search "trickle" in Extensions (Cmd+Shift+X), publisher `yiheinchai`. Shows inline type hints for traced variables.

## How It Works

1. **Observation** — Trickle instruments your code via import hooks (Python/JS) or AST transformation (notebooks). Only your code is traced — stdlib and third-party libraries are skipped.
2. **Type Inference** — When functions run, trickle inspects arguments and return values to build type trees. Handles dicts, lists, classes, tensors, dataframes, and more.
3. **Deduplication** — Same type signature at the same location is only recorded once. Loops don't explode the data.
4. **Output** — Types are written to `.trickle/` as JSONL. The VSCode extension reads these for inline hints. The CLI generates stubs, clients, and specs.

## Quick Reference

| Command | What it does |
|---|---|
| **Observability** | |
| `trickle run <cmd>` | Run any command with auto-instrumentation |
| `trickle monitor` | Detect anomalies: N+1 queries, slow functions, errors, memory |
| `trickle monitor --watch --webhook <url>` | Continuous monitoring with Slack/webhook alerts |
| `trickle heal` | Generate fix plans with context for agent auto-remediation |
| `trickle verify --baseline` / `trickle verify` | Before/after metric comparison to verify fixes |
| `trickle dashboard-local` | Self-contained HTML dashboard (no backend needed) |
| **Debugging** | |
| `trickle context <file>` | Runtime context for AI agent debugging |
| `trickle context --errors` | Error context with nearby variable values |
| `trickle functions` | List all observed functions with timing |
| `trickle vars` | Show traced variables with types |
| **Code Generation** | |
| `trickle stubs src/` | Generate `.pyi`/`.d.ts` type stubs |
| `trickle codegen --client` | Generate typed API client (TypeScript) |
| `trickle openapi` | Generate OpenAPI 3.0 spec |
| **Agent Integration** | |
| `trickle mcp-server` | MCP server (15 tools) for AI agent access |
| `trickle init` | Setup project + create CLAUDE.md for agents |
| `trickle heal --json` | Structured fix plans for agent consumption |
| **Team Management** | |
| `trickle cloud team create <name>` | Create a team with you as owner |
| `trickle cloud team invite` | Invite members with role-based access |
| `trickle cloud team add-project` | Share a project with your team |
| `trickle cloud team list` | List teams you belong to |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TRICKLE_LOCAL` | `0` | `1` for offline mode (no backend needed) |
| `TRICKLE_TRACE_VARS` | `1` | `0` to disable variable tracing |
| `TRICKLE_PRODUCTION` | `0` | `1` for production mode (disables var tracing, enables sampling) |
| `TRICKLE_SAMPLE_RATE` | `1.0` | Fraction of calls to observe (0.01 = 1%, useful for production) |
| `TRICKLE_SERVICE_NAME` | cwd name | Service name for distributed tracing |
| `TRICKLE_OBSERVE_INCLUDE` | all user code | Comma-separated module patterns to trace |
| `TRICKLE_OBSERVE_EXCLUDE` | none | Comma-separated module patterns to skip |
| `TRICKLE_INJECT` | `0` | `1` to inject types into source files |
| `TRICKLE_COVERAGE` | `0` | `1` to print type coverage report |
| `TRICKLE_DEBUG` | `0` | `1` for verbose output |

## Cloud Dashboard & Team Sharing

Share observability data with your team via the cloud backend:

```bash
# One-time setup
trickle cloud login --url https://cloud.trickle.dev

# Every trickle run now auto-pushes all data to the cloud
trickle run python app.py

# Share a dashboard link with your team (no auth needed to view)
trickle cloud share
#   ✓ Share link created
#   URL: https://cloud.trickle.dev/api/v1/shared/abc123

# Pull data on another machine
trickle cloud pull
```

Self-host the backend:
```bash
docker run -p 4888:4888 -v trickle-data:/data trickle-backend
trickle cloud login --url http://your-server:4888
```

The hosted dashboard shows alerts, errors, performance hotspots, database queries, and observed functions — all in a dark-themed UI accessible via a single URL.

**Team Management (RBAC):**
```bash
trickle cloud team create "My Team"        # create a team
trickle cloud team invite --team <id> --key-id <their-key-id> --role admin
trickle cloud team add-project --team <id>  # share current project
trickle cloud team list                     # list your teams
```

Four roles: **owner** (full control), **admin** (manage members/projects), **member** (push/pull), **viewer** (read-only). Team members can pull and view shared projects.

**[Full Observability Platform Guide →](usecases/observability-platform.md)**

## Architecture

```
Your Code → trickle (import hooks / AST transform)
                ↓
         .trickle/observations.jsonl  (function types + timing)
         .trickle/variables.jsonl     (variable assignments)
         .trickle/calltrace.jsonl     (call graph + parent-child flow)
         .trickle/errors.jsonl        (crash context + nearby values)
         .trickle/queries.jsonl       (SQL, Redis, MongoDB queries)
         .trickle/traces.jsonl        (distributed spans across services)
         .trickle/websocket.jsonl     (WebSocket messages)
         .trickle/profile.jsonl       (memory RSS + heap snapshots)
         .trickle/console.jsonl       (stdout/stderr output)
         .trickle/alerts.jsonl        (detected anomalies)
         .trickle/heal.jsonl          (fix plans for agents)
                ↓
    ┌───────────┼───────────┬──────────────┬─────────────┐
    ↓           ↓           ↓              ↓             ↓
 VSCode      Monitor      AI Agents      MCP Server    Cloud
 Extension   + Dashboard   (trickle       (18 tools)    (auto-push,
 (inline     + Webhook     heal,                        shared
  hints)     alerts        verify)                      dashboards)
```

## Packages

| Package | Registry | Description |
|---|---|---|
| [`trickle-observe`](https://www.npmjs.com/package/trickle-observe) | npm | JS/TS runtime instrumentation |
| [`trickle-cli`](https://www.npmjs.com/package/trickle-cli) | npm | CLI for codegen, stubs, CI checks |
| [`trickle-backend`](https://www.npmjs.com/package/trickle-backend) | npm | Cloud backend — team sharing, hosted dashboards, API |
| [`trickle-observe`](https://pypi.org/project/trickle-observe/) | PyPI | Python runtime instrumentation |
| [`trickle-vscode`](https://marketplace.visualstudio.com/items?itemName=yiheinchai.trickle-vscode) | VS Marketplace | VSCode inline type hints |

## License

MIT
