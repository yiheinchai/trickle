# trickle

**AI writes 41% of your code. Do you know what it actually does?**

Run any JavaScript or Python app with `trickle run` — zero code changes — and instantly see every function's real types, generate a test suite, create typed API clients, and catch bugs before they ship. No OpenAPI spec required. No framework lock-in. Works with Express, Fastify, Koa, Hono, FastAPI, Flask, Django, and plain scripts.

> *Amazon Q's AI code caused 6.3M lost orders. The gap between "code that compiles" and "code that works" is where bugs hide. Trickle closes that gap.*

## Getting Started (2 minutes)

### Install

```bash
npm install -g trickle-cli
npm install trickle-observe       # JS/TS projects
pip install trickle-observe       # Python projects
```

### Run your app

```bash
trickle run node app.js           # Node.js / Express
trickle run python app.py         # Python / Flask / FastAPI
trickle run npx tsx src/index.ts  # TypeScript
trickle run uvicorn app:app       # ASGI servers
trickle run python manage.py runserver  # Django
```

### See what happened

```bash
trickle summary                   # complete overview: errors, queries, root causes
trickle why                       # causal debugging: trace back to root cause
trickle explain src/api.ts        # understand a file: functions, call graph, data flow
trickle flamegraph                # where is time being spent?
trickle doctor                    # health check with recommended next actions
trickle eval                      # reliability score (A-F) for agent runs
trickle cost-report               # LLM cost breakdown by provider/model/tier
trickle security                  # scan for prompt injection, data exfiltration
trickle audit --compliance        # compliance report (EU AI Act / Colorado AI Act)
```

### Run tests with observability

```bash
trickle test                      # auto-detects jest, vitest, pytest, mocha
trickle test "npx vitest run"     # or specify your test command
trickle test "npx jest"
trickle test "python -m pytest"
```

### For vitest/jest: inline type hints in test files

```typescript
// vitest.config.ts (or vite.config.ts)
import { defineConfig } from 'vitest/config';
import { tricklePlugin } from 'trickle-observe/vite-plugin';

export default defineConfig({
  plugins: [tricklePlugin()],
});
```

Run `npx vitest run` — inline variable hints appear in both source files and test files.

### AI Agent Observability (LangChain, CrewAI, OpenAI, Claude)

Zero-code tracing for all major agent frameworks:

```bash
trickle run python my_agent.py    # auto-detects and traces agent execution
trickle eval                      # reliability score: A-F grade
trickle why                       # causal debugging: why did the agent fail?
trickle cost-report               # cost by provider, model tier, agent
trickle security                  # prompt injection, data exfiltration detection
```

**Auto-captures:** LLM calls (OpenAI + Anthropic + Gemini + Mistral + Cohere), agent workflows (LangChain + CrewAI + Claude Agent SDK + OpenAI Agents SDK), MCP tool calls, token counts, estimated costs, agent memory operations (Mem0 + LangGraph checkpointer).

```
$ trickle eval
  Overall: B (78/100)
  Completion     ████████████████████ 100/100
  Errors         ████████████████░░░░  80/100
  Cost           ████████████████████ 100/100
  Tools          ███████████░░░░░░░░░  55/100
  Latency        █████████████████░░░  85/100

$ trickle cost-report
  Model Tier Analysis
  🔴 Frontier      $0.043  83% cost  25% of calls
  🟡 Standard      $0.008  15% cost  25% of calls
  🟢 Mini          $0.001   1% cost  50% of calls
```

### For AI coding agents (Claude Code, Cursor)

```bash
trickle init    # creates CLAUDE.md + .claude/settings.json with 39 MCP tools
```

The agent can now use `why`, `get_llm_calls`, `get_agent_trace`, `get_cost_report`, `get_recommended_actions`, and 34 more tools.

---

## Who is this for?

Pick your role for a detailed guide with use cases.

### Vibe Coders / AI-Assisted Developers

> *"AI generated 500 lines. It compiles. But what does it actually do?"*

Run the AI-generated code with trickle, then instantly get types, tests, and API docs for everything it built:

```bash
trickle run node app.js                  # observe everything
trickle explain src/app.js               # understand what it does
trickle test --generate --unit -o tests/ # generate test suite
trickle codegen --client                 # generate typed API client
trickle security                         # scan for vulnerabilities
```

**[Full Vibe Coding Guide →](usecases/vibe-coding.md)**

---

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

### JavaScript / TypeScript Developers

> *"I want to see runtime values inline in my editor without console.log."*

```bash
trickle run node app.js          # captures all variable values + function types
```

Open the file in VSCode — inline type hints appear for every variable. Works with CJS, ESM, TypeScript (tsx/ts-node), and React/JSX.

**[Full JavaScript Developer Guide →](usecases/javascript-developer.md)**

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

**[Full Frontend Developer Guide →](usecases/frontend-developer.md)** | **[React Guide →](usecases/react-developer.md)** | **[Next.js Guide →](usecases/nextjs-developer.md)** | **[React Native Guide →](usecases/react-native-developer.md)**

---

### Backend / API Developers

> *"I want to see what my API actually does at runtime — queries, errors, performance."*

Run your server through trickle. Zero code changes. It captures functions, database queries, errors, and detects N+1 patterns automatically.

```bash
trickle run node app.js          # or: trickle run python app.py
trickle summary                   # errors, queries, N+1 patterns, root causes
trickle explain src/routes.js     # functions, call graph, data flow, queries
trickle test                      # run tests with observability (jest/vitest/pytest)
trickle flamegraph                # where is time being spent?
```

Also generates types: `trickle codegen` (TypeScript), `trickle openapi` (OpenAPI spec), `trickle codegen --zod` (Zod schemas).

**[Full Backend Developer Guide →](usecases/backend-api-developer.md)** | **[AWS Lambda Guide →](usecases/aws-lambda-developer.md)**

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

Or use the one-command CI integration:
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
trickle test --generate --unit   # auto-generate unit tests from runtime data
```

**[Full QA Guide →](usecases/qa-engineer.md)**

---

### AI Coding Agents (Claude Code, Cursor, Copilot)

> *"My agent keeps adding console.log to debug. There must be a better way."*

One command sets up everything — CLAUDE.md, MCP server config, and project settings:

```bash
trickle init                     # creates CLAUDE.md + .claude/settings.json
trickle run node app.js          # capture runtime data (zero code changes)
```

Agents use **39 MCP tools** for autonomous debugging:

```
Agent workflow:
1. get_recommended_actions     → "You have 2 N+1 queries. Call get_last_run_summary."
2. get_last_run_summary        → errors, queries, root causes, fix recommendations
3. explain_file("src/api.ts")  → functions, call graph, data flow, queries, variables
4. save_baseline               → save metrics before fixing
5. (agent fixes the code)
6. refresh_runtime_data        → re-run the app
7. compare_with_baseline       → "Fix verified — 3 metrics improved, 0 regressed"
```

Also: `run_tests` (structured pass/fail), `get_flamegraph` (performance hotspots), `get_errors` (errors with variable context), `get_new_alerts` (production monitoring).

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

Zero config, zero code changes. Auto-detects databases (PostgreSQL, MySQL, SQLite, Redis, MongoDB) and ORMs (Prisma, Sequelize, TypeORM, SQLAlchemy, Django ORM, Knex, Drizzle), HTTP clients, and WebSocket connections. Production mode with configurable sampling.

**[Full Observability Platform Guide →](usecases/observability-platform.md)** | **[SRE / Platform Engineer Guide →](usecases/sre-platform-engineer.md)**

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

---

## Complete CLI Reference

Every command trickle provides, organized by category. Run `trickle <command> --help` for full flag details.

### Project Setup & Configuration

#### `trickle init`

Configure your project for trickle. Sets up tsconfig paths, npm scripts, .gitignore entries, and creates CLAUDE.md + `.claude/settings.json` for AI coding agents.

```bash
trickle init                     # interactive setup
```

**What it configures:**
- `tsconfig.json` — adds path aliases for generated types
- `package.json` — adds `trickle:dev`, `trickle:stubs` scripts
- `.gitignore` — adds `.trickle/` directory
- `CLAUDE.md` — project context for AI agents
- `.claude/settings.json` — MCP server configuration with all 39 tools

#### `trickle dev [command]`

Run your app with auto-instrumentation and live type generation. Types update as you develop.

```bash
trickle dev                      # auto-detects start command
trickle dev "node app.js"        # explicit command
trickle dev "uvicorn app:app"    # Python ASGI
```

Combines `trickle run` with `trickle watch` — re-generates types whenever new observations come in.

#### `trickle python`

Set up a Python project for trickle observation.

```bash
trickle python                   # configures Python project
```

#### `trickle next [setup]`

Set up a Next.js project with trickle's webpack plugin.

```bash
trickle next setup               # configures next.config.js
```

Adds `withTrickle()` wrapper to your Next.js config for automatic component instrumentation.

#### `trickle rn [setup|ip]`

Set up React Native / Expo project with Metro transformer.

```bash
trickle rn setup                 # configures metro.config.js
trickle rn ip                    # show LAN IP for device connection
```

#### `trickle lambda`

AWS Lambda helpers for setup, layer deployment, and data retrieval.

```bash
trickle lambda setup             # configure Lambda function
trickle lambda layer             # create Lambda layer
trickle lambda pull              # pull observations from CloudWatch
```

---

### Core Observability

#### `trickle run [command...]`

**The primary command.** Run any command with zero-code auto-instrumentation. Automatically starts the trickle backend, instruments the process, and captures all runtime data.

```bash
trickle run node app.js
trickle run python app.py
trickle run npx tsx src/index.ts
trickle run uvicorn app:app --reload
trickle run python manage.py runserver
trickle run "npm test"
```

**What gets captured automatically:**
- Function arguments, return values, and execution time
- Variable assignments with types and sample values
- Express/Fastify/Koa/Hono/FastAPI/Flask/Django route handlers
- Database queries (SQLite, PostgreSQL, MySQL, Redis, MongoDB)
- HTTP requests (fetch, requests, httpx)
- WebSocket connections and messages
- LLM API calls (OpenAI, Anthropic, Gemini, Mistral, Cohere)
- Agent workflows (LangChain, CrewAI, Claude Agent SDK, OpenAI Agents SDK)
- MCP tool calls (client and server)
- Agent memory operations (Mem0, LangGraph checkpointer)
- Console output (stdout/stderr)
- Uncaught exceptions with variable context
- Call graph (parent-child function relationships)

**Flags:**
- `--local` — Force local-only mode (no backend server)
- `--no-vars` — Disable variable tracing (faster)

#### `trickle test [command...]`

Run tests with structured observability results. Auto-detects test framework (jest, vitest, pytest, mocha).

```bash
trickle test                      # auto-detect test runner
trickle test "npx vitest run"     # explicit command
trickle test "python -m pytest"
trickle test --generate           # auto-generate API route tests from observed types
trickle test --generate --unit    # auto-generate function-level unit tests (vitest/jest)
trickle test --generate --unit --framework pytest  # generate pytest tests for Python
trickle test --generate --unit --function myFunc   # filter by function name
trickle test --generate --unit --module src/utils  # filter by module
trickle test --generate --unit -o tests/generated.test.ts  # write to file
```

**Output:** Structured pass/fail results with function types, errors, and variable context for each failing test.

#### `trickle summary`

One JSON output with everything captured in the last run. Designed for both humans and AI agents.

```bash
trickle summary                   # full summary
trickle summary --json            # JSON format for agents
```

**Includes:** Function count, error count, top errors with stack traces, slow functions, N+1 queries, root cause analysis, recommended actions.

#### `trickle tail`

Stream live events as they happen (Server-Sent Events).

```bash
trickle tail                      # stream all events
trickle tail --filter "api"       # filter by function name
```

Shows real-time type observations, errors, and function calls as your app runs.

#### `trickle status`

Show data freshness — what data exists, how old it is, and whether the backend is running.

```bash
trickle status
```

#### `trickle demo`

Self-running showcase of trickle's features. Creates a sample app, instruments it, and demonstrates key commands.

```bash
trickle demo
```

---

### Analysis & Debugging

#### `trickle functions`

List all observed functions with timing, type info, and call counts.

```bash
trickle functions                 # list all functions
trickle functions --env production # filter by environment
trickle functions -q "user"       # search by name
```

#### `trickle types <function-name>`

Show type snapshots for a specific function. Supports diffing between snapshots.

```bash
trickle types createUser          # show type history
trickle types createUser --diff   # diff between latest snapshots
```

#### `trickle vars`

Show traced variables with types, sample values, and source locations.

```bash
trickle vars                      # all variables
trickle vars --file src/api.ts    # filter by file
trickle vars --tensors            # only tensor variables (shape, dtype, device)
```

#### `trickle errors [id]`

List errors with full context — stack traces, nearby variable values, function arguments at the time of the error.

```bash
trickle errors                    # list all errors
trickle errors 42                 # show specific error with full context
trickle errors --env staging      # filter by environment
trickle errors --since 2h         # errors in last 2 hours
```

#### `trickle explain <file>`

Understand a file through runtime data. Shows functions, call graph, data flow, queries, and variables — everything the file does at runtime.

```bash
trickle explain src/api.ts        # full file analysis
trickle explain src/routes.py     # works for Python too
```

**Output:** Functions defined in the file, their call relationships, database queries they execute, variables they use, and errors they produce.

#### `trickle context [file:line]`

Runtime context for AI agent debugging. Provides structured data about what's happening at a specific location.

```bash
trickle context src/api.ts        # context for entire file
trickle context src/api.ts:42     # context at specific line
trickle context --errors          # error context with nearby variable values
```

#### `trickle why [query]`

Causal debugging — trace back from a symptom to its root cause. Follows the chain: error → function → caller → data flow.

```bash
trickle why                       # analyze most recent error
trickle why "timeout"             # search for timeout-related issues
trickle why "null"                # trace null pointer issues
```

#### `trickle search <query>`

Full-text search across all observed types — find where a field name appears across your entire API surface.

```bash
trickle search "email"            # find all functions with "email" fields
trickle search "userId"           # trace userId across the codebase
```

#### `trickle doctor`

Comprehensive health check. Analyzes all captured data and provides prioritized recommendations.

```bash
trickle doctor                    # full health check
```

**Checks:** Error rates, slow functions, N+1 queries, missing error handling, type inconsistencies, stale data, memory issues.

---

### Performance & Monitoring

#### `trickle monitor`

Detect anomalies in real-time: N+1 queries, slow functions, error spikes, memory issues.

```bash
trickle monitor                   # one-time analysis
trickle monitor --watch           # continuous monitoring
trickle monitor --watch --webhook https://hooks.slack.com/... # with alerts
```

**Detects:**
- N+1 query patterns (same query repeated in a loop)
- Slow functions (>1s by default, configurable)
- Error rate spikes
- Memory growth patterns
- Unused database indexes (from query analysis)

#### `trickle watch-alerts`

Continuous alert monitoring stream. Like `trickle monitor --watch` but focused on alerts only.

```bash
trickle watch-alerts              # stream alerts
trickle watch-alerts --webhook <url>  # forward to webhook
```

#### `trickle rules init` / `trickle rules list`

Create and manage custom alerting rules.

```bash
trickle rules init                # create .trickle/rules.json with defaults
trickle rules list                # show active rules and thresholds
```

**Default rules:** Slow function (>1000ms), N+1 queries (>5 similar), error rate (>5%), memory growth (>50MB).

#### `trickle flamegraph`

Interactive flamegraph showing where time is spent. Visualizes the call tree with timing data.

```bash
trickle flamegraph                # generate flamegraph
trickle flamegraph --html         # open in browser
trickle flamegraph --json         # JSON format for agents
```

#### `trickle metrics`

APM-style latency percentiles (p50/p95/p99), error rates, and query performance.

```bash
trickle metrics                   # text summary
trickle metrics --html            # interactive dashboard in browser
trickle metrics --json            # structured for agents
```

#### `trickle waterfall`

Jaeger-like request timeline — see how a single request flows through your system.

```bash
trickle waterfall                 # show latest request timeline
```

#### `trickle anomaly`

Detect deviations from a learned baseline. Compare current behavior against historical patterns.

```bash
trickle anomaly                   # detect anomalies
trickle anomaly --learn           # learn current state as baseline
```

#### `trickle slo init` / `trickle slo check`

Service Level Objective tracking. Define targets and check compliance.

```bash
trickle slo init                  # create .trickle/slos.json with defaults
trickle slo check                 # check compliance (exit 1 if breached)
```

**Default SLOs:** Error rate <1%, p99 latency <500ms, availability 99.9%.

#### `trickle dashboard-local`

Generate a self-contained HTML dashboard — no backend needed. Opens in browser.

```bash
trickle dashboard-local           # generate and open dashboard
trickle dashboard-local -o dashboard.html  # save to file
```

**Shows:** Functions, errors, performance metrics, call graph, database queries, LLM costs — all in a dark-themed interactive UI.

---

### Code Generation

#### `trickle codegen [function-name]`

Generate typed code from observed runtime data. Supports 17 output formats.

```bash
# TypeScript types (default)
trickle codegen                   # all functions
trickle codegen createUser        # specific function

# Typed API client
trickle codegen --client          # generate typed fetch client
trickle codegen --client -o src/api-client.ts

# Validation schemas
trickle codegen --zod             # Zod schemas
trickle codegen --pydantic        # Pydantic models
trickle codegen --class-validator # class-validator DTOs
trickle codegen --json-schema     # JSON Schema

# Data fetching hooks
trickle codegen --react-query     # React Query (TanStack Query) hooks
trickle codegen --swr             # SWR hooks
trickle codegen --axios           # Axios client

# API framework schemas
trickle codegen --graphql         # GraphQL schema
trickle codegen --trpc            # tRPC router

# Testing
trickle codegen --msw             # Mock Service Worker handlers
trickle codegen --guards          # TypeScript type guards

# Express
trickle codegen --handlers        # Express handler types
trickle codegen --middleware      # Express middleware

# Documentation
trickle codegen --docs            # API documentation

# Inline
trickle codegen --annotate        # Inline type annotations
```

**Flags:**
- `-o, --output <file>` — Write to file instead of stdout
- `--env <environment>` — Filter by environment
- `--language <js|python>` — Force language

#### `trickle stubs <directory>`

Generate `.d.ts` (TypeScript) and `.pyi` (Python) sidecar type stub files for observed modules.

```bash
trickle stubs src/                # generate stubs for all files in src/
trickle stubs .                   # current directory
```

Stubs appear alongside source files: `utils.ts` → `utils.d.ts`, `helpers.py` → `helpers.pyi`.

#### `trickle openapi`

Generate an OpenAPI 3.0 specification from observed API routes.

```bash
trickle openapi                   # print to stdout
trickle openapi -o openapi.json   # save to file
trickle openapi --title "My API" --version "1.0.0"
```

#### `trickle annotate <file>`

Inject type annotations directly into source files based on observed runtime data.

```bash
trickle annotate src/utils.py     # add type annotations to Python file
trickle annotate src/helpers.ts   # add JSDoc to TypeScript file
```

#### `trickle auto`

Auto-detect project dependencies and generate only relevant types.

```bash
trickle auto                      # detect and generate
```

#### `trickle infer [file]`

Infer types from a JSON file — no running app needed.

```bash
trickle infer data.json           # infer types from JSON
trickle infer response.json       # generate TypeScript interface from API response
```

---

### API & Endpoint Tools

#### `trickle proxy`

Transparent reverse proxy that captures API traffic for type inference.

```bash
trickle proxy --target http://localhost:3000 --port 4000
```

All requests through port 4000 are forwarded to port 3000, with request/response types captured automatically. Then use `trickle codegen --client` to generate a typed client.

#### `trickle capture <method> <url>`

Capture types from a live endpoint with a single request.

```bash
trickle capture GET http://localhost:3000/api/users
trickle capture POST http://localhost:3000/api/users -d '{"name":"Alice"}'
```

#### `trickle validate <method> <url>`

Validate an endpoint's response against previously observed types.

```bash
trickle validate GET http://localhost:3000/api/users
```

Exits non-zero if the response type doesn't match the observed type — useful for CI contract testing.

#### `trickle trace <method> <url>`

Make an HTTP request with inline annotations showing response type and timing.

```bash
trickle trace GET http://localhost:3000/api/users
```

#### `trickle mock`

Serve a mock API server based on observed routes and sample data.

```bash
trickle mock                      # serve on default port
trickle mock --port 5000          # custom port
```

Returns realistic sample data from actual observed responses. Supports all HTTP methods and routes that were observed during `trickle run`.

#### `trickle replay`

Regression testing via request replay. Replays previously captured requests and compares responses.

```bash
trickle replay                    # replay all captured requests
```

#### `trickle sample [route]`

Generate test fixtures and factory functions from observed data.

```bash
trickle sample                    # all routes
trickle sample "GET /api/users"   # specific route
```

---

### Comparison & Diff

#### `trickle diff`

Cross-function type drift report. Shows how types have changed over time.

```bash
trickle diff                      # temporal drift (last two snapshots per function)
trickle diff --env1 staging --env2 production  # cross-environment comparison
```

#### `trickle check`

Breaking change detection. Compare current types against a baseline.

```bash
trickle check --save baseline.json    # save current state as baseline
trickle check --against baseline.json # detect breaking changes (exit 1 if breaking)
```

Use in CI to catch API regressions before they reach production.

#### `trickle diff-runs`

Side-by-side comparison of two different runs.

```bash
trickle diff-runs                 # compare last two runs
```

#### `trickle verify`

Before/after metric comparison to verify fixes.

```bash
trickle verify --baseline         # save metrics before fixing
# ... make changes ...
trickle verify                    # compare against baseline
```

#### `trickle changelog`

Generate an API changelog from type diffs over time.

```bash
trickle changelog                 # show changes
trickle changelog --since 7d      # last 7 days
```

---

### AI Agent & LLM Tools

#### `trickle eval`

Score agent reliability with an A-F grade. Evaluates completion rate, error handling, cost efficiency, tool usage, and latency.

```bash
trickle eval                      # reliability score
trickle eval --fail-under B       # exit 1 if below B grade (for CI)
trickle eval --json               # structured output for agents
```

#### `trickle cost-report`

LLM cost breakdown by provider, model, and tier.

```bash
trickle cost-report               # human-readable report
trickle cost-report --json        # structured for agents
```

Shows: per-model cost, token counts, cost per call, model tier analysis (frontier/standard/mini), optimization recommendations.

#### `trickle llm`

Show all LLM/AI API calls with details.

```bash
trickle llm                       # list all LLM calls
trickle llm --json                # structured output
```

**Shows:** Provider, model, input/output tokens, cost, latency, tool use, system prompt preview.

#### `trickle mcp-calls`

Show MCP tool invocations (both outgoing client calls and incoming server calls).

```bash
trickle mcp-calls                 # list all MCP tool calls
```

#### `trickle memory`

Agent memory operations tracking (Mem0 add/get/search/update/delete, LangGraph checkpointer put/get/list).

```bash
trickle memory                    # list all memory operations
trickle memory --json             # structured output
```

#### `trickle benchmark [command...]`

Multi-trial reliability testing. Runs a command multiple times and computes pass@k, consistency, cost variance, and latency distribution.

```bash
trickle benchmark "python agent.py" --trials 10
trickle benchmark "python agent.py" --trials 5 --parallel
```

**Output:** Pass rate, consistency score, cost per trial, latency percentiles, failure analysis.

#### `trickle playback`

Step-by-step agent execution replay. Walk through an agent's decision process.

```bash
trickle playback                  # replay last agent run
trickle playback --json           # structured for programmatic use
```

#### `trickle summarize`

Compress agent traces into a concise summary.

```bash
trickle summarize                 # summarize last run
```

#### `trickle tool-schema [function-name]`

Generate LLM tool-calling schemas from observed function signatures.

```bash
trickle tool-schema               # all functions
trickle tool-schema createUser    # specific function
trickle tool-schema --format openai    # OpenAI function calling format
trickle tool-schema --format anthropic # Anthropic tool use format
trickle tool-schema --format mcp       # MCP tool format
```

---

### Security & Compliance

#### `trickle security`

Scan for security issues in agent interactions.

```bash
trickle security                  # full security scan
trickle security --json           # structured output
```

**Detects:** Prompt injection attempts, data exfiltration patterns, sensitive data in prompts/responses, unsafe tool invocations.

#### `trickle audit`

Code quality audit based on observed runtime behavior.

```bash
trickle audit                     # quality audit
trickle audit --compliance        # EU AI Act / Colorado AI Act compliance report
trickle audit --json              # structured output
```

**Checks:** Sensitive data exposure (passwords, tokens, SSNs in responses), oversized responses (>15 fields), deep nesting (>4 levels), naming inconsistency (mixed camelCase/snake_case), empty responses, cross-route type inconsistency.

---

### Documentation & Export

#### `trickle docs`

Generate API documentation from observed types.

```bash
trickle docs                      # markdown docs
trickle docs --html               # HTML documentation
```

#### `trickle overview`

Compact route listing with type signatures — a quick view of your entire API surface.

```bash
trickle overview                  # list all routes with signatures
```

#### `trickle coverage`

Type observation health report. Shows how well your codebase is covered by observations.

```bash
trickle coverage                  # coverage report
trickle coverage --json           # structured output
```

**Shows:** Total functions, functions with types, freshness, error rates, observation health (0-100 per function).

#### `trickle export`

Export observation data in multiple formats.

```bash
trickle export --csv              # CSV format
trickle export --otlp             # OpenTelemetry format
trickle export --json             # JSON format
```

#### `trickle pack` / `trickle unpack`

Create and restore portable type bundles for sharing across machines or teams.

```bash
trickle pack                      # create trickle-bundle.json
trickle pack -o types.json        # custom output path
trickle unpack types.json         # restore from bundle
```

#### `trickle deps`

Module dependency graph. Shows how modules relate to each other based on runtime call data.

```bash
trickle deps                      # text output
trickle deps --mermaid            # Mermaid diagram format
```

#### `trickle layers`

Per-layer activation breakdown for ML models. Shows which layers consume the most compute.

```bash
trickle layers                    # layer analysis
```

---

### Remediation & Fix

#### `trickle heal`

Generate auto-remediation plans with context for AI agents.

```bash
trickle heal                      # human-readable fix plans
trickle heal --json               # structured for agent consumption
```

**Generates:** Step-by-step fix plans for each detected issue, with confidence scores, affected files, and code suggestions.

#### `trickle fix`

Code fix suggestions based on observed errors and anomalies.

```bash
trickle fix                       # suggest fixes
```

#### `trickle agent [command...]`

Launch an autonomous debugging agent that iteratively diagnoses and fixes issues.

```bash
trickle agent "node app.js"       # autonomous debugging
```

---

### CI/CD Integration

#### `trickle ci [command...]`

Run a command with CI-optimized output. Generates GitHub/GitLab annotations for errors, N+1 queries, and slow functions.

```bash
trickle ci "npm test"             # with annotations
trickle ci "python -m pytest"
```

```yaml
# GitHub Actions example
- name: Run tests with trickle
  run: npx trickle ci "python -m pytest tests/"
```

#### `trickle check`

Breaking change detection for CI pipelines. See [Comparison & Diff](#comparison--diff) section.

---

### Utilities

#### `trickle watch`

Auto-regenerate types whenever new observations come in.

```bash
trickle watch                     # watch for changes
```

#### `trickle cleanup`

Prune old observation data.

```bash
trickle cleanup                   # delete data older than 30 days
trickle cleanup --retain-days 7   # keep last 7 days
trickle cleanup --retain-lines 1000  # keep last 1000 lines per file
```

#### `trickle cost`

Cloud cost estimation for observed functions (Lambda pricing model).

```bash
trickle cost                      # estimate costs
```

#### `trickle ticket`

Create issues in external trackers from observed errors.

```bash
trickle ticket                    # create from latest error
trickle ticket --github           # create GitHub issue
trickle ticket --linear           # create Linear issue
trickle ticket --jira             # create Jira issue
```

---

### Cloud & Team Management

#### `trickle cloud login`

Authenticate with a trickle cloud backend.

```bash
trickle cloud login --url https://cloud.trickle.dev
trickle cloud login --url http://your-server:4888  # self-hosted
```

#### `trickle cloud push` / `trickle cloud pull`

Sync observation data with the cloud.

```bash
trickle cloud push                # upload current data
trickle cloud pull                # download data from cloud
```

#### `trickle cloud share`

Create a shareable dashboard link (no auth needed to view).

```bash
trickle cloud share
# → URL: https://cloud.trickle.dev/api/v1/shared/abc123
```

#### `trickle cloud projects`

List all projects in the cloud.

```bash
trickle cloud projects            # list projects
```

#### `trickle cloud status`

Show sync status between local and cloud.

```bash
trickle cloud status
```

#### `trickle cloud team create <name>`

Create a team with you as owner.

```bash
trickle cloud team create "My Team"
```

#### `trickle cloud team list`

List teams you belong to.

```bash
trickle cloud team list
```

#### `trickle cloud team info`

Show team details.

```bash
trickle cloud team info --team <id>
```

#### `trickle cloud team invite`

Add a member with role-based access.

```bash
trickle cloud team invite --team <id> --key-id <their-key-id> --role admin
```

Four roles: **owner** (full control), **admin** (manage members/projects), **member** (push/pull), **viewer** (read-only).

#### `trickle cloud team remove`

Remove a team member.

```bash
trickle cloud team remove --team <id> --key-id <their-key-id>
```

#### `trickle cloud team add-project`

Share a project with your team.

```bash
trickle cloud team add-project --team <id>
```

---

### MCP Server

#### `trickle mcp-server`

Start the MCP (Model Context Protocol) server for AI coding agents. Provides 39 tools over stdio transport.

```bash
trickle mcp-server                # start MCP server (stdio)
```

Typically configured via `trickle init` which adds the server to `.claude/settings.json`.

---

## All 39 MCP Tools

These tools are available to AI coding agents via `trickle mcp-server`.

### Foundational Context

| Tool | Description |
|------|-------------|
| `get_runtime_context` | Variable values and function types for a file/line |
| `get_annotated_source` | Source code with inline runtime values |
| `get_function_signatures` | All observed function signatures |
| `explain_file` | Full understanding: functions, call graph, queries, errors |

### Error & Debugging

| Tool | Description |
|------|-------------|
| `get_errors` | Crash context with nearby variable values |
| `get_database_queries` | SQL/Redis/MongoDB queries with timing |
| `get_call_trace` | Function call graph with parent-child relationships |
| `get_request_trace` | Everything in one HTTP request |

### Health & Monitoring

| Tool | Description |
|------|-------------|
| `get_doctor` | Comprehensive health check |
| `get_alerts` | Slow queries, N+1s, errors, memory issues |
| `get_new_alerts` | Only new alerts since last check (polling-friendly) |
| `get_recommended_actions` | Prioritized next steps |
| `detect_anomalies` | Performance deviations from baseline |
| `check_slos` | Service Level Objective compliance |

### Performance & Analytics

| Tool | Description |
|------|-------------|
| `get_flamegraph` | Hotspots and call tree |
| `get_performance_profile` | Memory RSS and heap snapshots |
| `get_websocket_events` | WebSocket connections and messages |
| `get_distributed_traces` | Cross-service request flow |
| `get_http_requests` | All fetch() / requests calls |
| `get_logs` | Python logging module entries |
| `get_console_output` | stdout/stderr capture |

### Comparison & Baseline

| Tool | Description |
|------|-------------|
| `save_baseline` | Save metrics before fixing |
| `compare_with_baseline` | Compare after fixing |
| `diff_runs` | Side-by-side snapshot comparison |

### AI & LLM

| Tool | Description |
|------|-------------|
| `get_llm_calls` | OpenAI/Anthropic/Gemini/Mistral/Cohere calls with tokens and cost |
| `get_cost_report` | Cost attribution by provider/model |
| `get_agent_trace` | LangChain/CrewAI/Claude/OpenAI agent timeline |
| `get_mcp_tool_calls` | MCP tool invocations with direction and latency |
| `get_memory_operations` | Mem0/LangGraph memory add/get/search/update/delete |

### Data Refresh & Orchestration

| Tool | Description |
|------|-------------|
| `check_data_freshness` | Does data exist? How old is it? |
| `refresh_runtime_data` | Run the app to capture fresh data |
| `get_last_run_summary` | One call gives everything from the last run |

### Environment & Config

| Tool | Description |
|------|-------------|
| `get_environment` | Python version, env vars, detected frameworks |

### Remediation & Testing

| Tool | Description |
|------|-------------|
| `get_heal_plans` | Auto-remediation with confidence scores |
| `get_fix_suggestions` | Code rewrites for detected issues |
| `run_tests` | Structured test results with context on failures |

---

## JavaScript Client API

### Package: `trickle-observe` (npm)

Zero runtime dependencies. Works with Node.js and browsers.

### Entry Points

| Import | Usage |
|--------|-------|
| `trickle-observe` | Main API: `trickle()`, `observe()`, `instrument()` |
| `trickle-observe/register` | Zero-code: `node -r trickle-observe/register app.js` |
| `trickle-observe/observe` | Zero-code: `node -r trickle-observe/observe app.js` |
| `trickle-observe/auto` | Zero-code with auto type generation |
| `trickle-observe/auto-env` | Conditional: only activates if `TRICKLE_AUTO=1` |
| `trickle-observe/observe-esm` | ESM: `node --loader trickle-observe/observe-esm app.mjs` |
| `trickle-observe/lambda` | AWS Lambda: `wrapLambda()` + `printObservations()` |
| `trickle-observe/vite-plugin` | Vite/Vitest: `tricklePlugin()` |
| `trickle-observe/next-plugin` | Next.js: `withTrickle()` |
| `trickle-observe/metro-transformer` | React Native: Metro transformer |
| `trickle-observe/trace-var` | Internal: variable tracing |

### Core Functions

#### `trickle(fn, opts?)` / `trickle(name, fn, opts?)`

Wrap a function to capture runtime types.

```javascript
const { trickle } = require('trickle-observe');

const createUser = trickle(async (name, email) => {
  // ... your code
  return { id: 1, name, email };
});

// With explicit name
const handler = trickle('createUser', async (name, email) => { ... });
```

**TrickleOpts:**
- `name?: string` — Explicit function name
- `module?: string` — Module/package name
- `trackArgs?: boolean` — Track arguments (default: true)
- `trackReturn?: boolean` — Track return value (default: true)
- `sampleRate?: number` — Fraction of calls to capture, 0–1 (default: 1)
- `maxDepth?: number` — Max depth for type inference (default: 5)

#### `configure(opts)`

Configure global settings before wrapping functions.

```javascript
const { configure } = require('trickle-observe');

configure({
  backendUrl: 'http://localhost:4888',
  batchIntervalMs: 2000,
  enabled: true,
  environment: 'staging',
  maxBatchSize: 50,
  debug: false,
});
```

#### `observe(obj, opts?)` / `observeFn(fn, opts?)`

Universal observation — wrap all functions in an object, or a single function.

```javascript
const { observe, observeFn } = require('trickle-observe');

// Observe all functions in a module
const helpers = observe(require('./helpers'), { module: 'helpers' });
helpers.fetchUser('user_123');  // types captured

// Observe a single function
const tracedFetch = observeFn(fetchUser, { name: 'fetchUser' });
```

**ObserveOpts:**
- `module?: string` — Module name (auto-inferred)
- `environment?: string` — Environment label (auto-detected)
- `sampleRate?: number` — 0–1, fraction of calls captured (default: 1)
- `maxDepth?: number` — Max depth for type inference (default: 5)
- `enabled?: boolean` — Disable observation (default: true)

#### `instrumentExpress(app, opts?)` / `trickleMiddleware(opts?)`

Instrument Express routes to capture request/response types.

```javascript
const { instrumentExpress, trickleMiddleware } = require('trickle-observe');

// Option 1: Monkey-patch all routes
instrumentExpress(app);

// Option 2: Use as middleware
app.use(trickleMiddleware());
```

**Captured data:** Route name (`GET /api/users`), request body/params/query, response body, errors, duration.

#### `instrument(app, opts?)`

Auto-detect framework and instrument.

```javascript
const { instrument } = require('trickle-observe');
instrument(app); // works for Express, and other supported frameworks
```

#### `flush()`

Flush pending observations to the backend.

```javascript
const { flush } = require('trickle-observe');
await flush();
```

### Framework Plugins

#### Vite Plugin

```typescript
// vite.config.ts
import { tricklePlugin } from 'trickle-observe/vite-plugin';

export default {
  plugins: [tricklePlugin({
    backendUrl: 'http://localhost:4888',
    include: ['src/**'],
    exclude: ['node_modules'],
    debug: false,
    traceVars: true,
  })],
};
```

Instruments React components — tracks renders, useState changes, and hook behavior.

#### Next.js Plugin

```javascript
// next.config.js
const { withTrickle } = require('trickle-observe/next-plugin');

module.exports = withTrickle({
  // ...existing Next.js config
}, {
  backendUrl: process.env.TRICKLE_BACKEND_URL,
  include: ['src/**'],
  exclude: ['node_modules'],
  debug: false,
  traceVars: true,
  ingestPort: 4889,   // client-side ingest server port
});
```

Supports App Router and Pages Router, client and server components.

#### Metro Transformer (React Native)

```javascript
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.transformer.babelTransformerPath = require.resolve('trickle-observe/metro-transformer');
module.exports = config;
```

#### AWS Lambda

```typescript
import { wrapLambda, printObservations } from 'trickle-observe/lambda';

export const handler = wrapLambda(async (event, context) => {
  const result = await processOrder(event.orderId);
  printObservations();  // Optional: stream to CloudWatch
  return { statusCode: 200, body: JSON.stringify(result) };
});
```

---

## Python Client API

### Package: `trickle-observe` (PyPI)

Requires Python >=3.9, depends on `requests`.

### Core Functions

#### `@trickle` — Decorator

```python
from trickle import trickle

@trickle
def create_user(name: str, email: str) -> dict:
    return {"id": 1, "name": name, "email": email}

# With options
@trickle(name="custom_name", module="my.module")
def fetch_data():
    ...
```

Supports sync, async, generator, and async generator functions. Captures arguments, return values, execution time, and errors.

#### `observe(obj)` / `observe_fn(fn)`

Universal function observation.

```python
from trickle import observe, observe_fn

# Observe all functions in a module
import my_helpers
helpers = observe(my_helpers, module="my-helpers")
helpers.fetch_user("user_123")  # types captured

# Observe a single function
traced_fetch = observe_fn(fetch_user, name="fetch_user")
```

#### `configure(backend_url, batch_interval, enabled, max_batch_size, max_retries)`

Configure transport settings.

```python
from trickle import configure

configure(
    backend_url="http://localhost:4888",
    batch_interval=2.0,
    enabled=True,
    max_batch_size=100,
    max_retries=3,
)
```

#### `instrument(app)` / `instrument_fastapi(app)` / `instrument_flask(app)` / `instrument_django(urlpatterns)`

Auto-instrument web frameworks.

```python
# FastAPI
from fastapi import FastAPI
from trickle import instrument

app = FastAPI()
instrument(app)  # auto-detects FastAPI

# Flask
from flask import Flask
from trickle import instrument_flask

app = Flask(__name__)
instrument_flask(app)

# Django (in urls.py)
from trickle import instrument_django
instrument_django(urlpatterns)
```

#### `progress(every, **metrics)`

Emit training progress metrics.

```python
from trickle import progress

for epoch in range(10):
    for step, (x, y) in enumerate(loader):
        loss = criterion(model(x), y)
        progress(epoch=epoch, step=step, loss=loss.item(), every=10)
```

### Zero-Code Usage

```bash
# Run any Python script with auto-instrumentation
python -m trickle my_script.py
python -m trickle my_module

# Or import in your code
import trickle.auto  # that's it — all functions get traced
```

### Jupyter/IPython

```python
%load_ext trickle
# All variables now get inline type hints
```

### Auto-Instrumented Libraries

The Python client automatically instruments these when imported:

**Web Frameworks:** FastAPI, Flask, Django (via middleware/hooks)

**LLM Providers:** OpenAI, Anthropic, Google Gemini, Mistral, Cohere

**Agent Frameworks:** LangChain, CrewAI, Claude Agent SDK, OpenAI Agents SDK

**Databases:** sqlite3, psycopg2/psycopg (PostgreSQL), pymysql, mysql-connector

**HTTP:** requests, httpx (sync + async)

**Logging:** Python stdlib logging, structlog

**MCP:** MCP client SDK, FastMCP server

**Memory:** Mem0, LangGraph checkpointer

**ML (via hooks):**
- `torch.nn.Module` forward hooks — activation statistics (mean, std, dead ReLUs, saturation)
- `torch.Tensor.backward()` — loss probe (plateau/diverging/oscillating detection)
- `torch.nn.functional.softmax` — attention statistics (entropy, dead/sharp heads)
- `torch.save()` / `save_pretrained()` — checkpoint tracking
- `torch.utils.data.DataLoader` — batch shape profiling
- Optimizer state tracking (lr, momentum, weight_decay)
- LR scheduler tracking

---

## Environment Variables

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `TRICKLE_BACKEND_URL` | `http://localhost:4888` | Backend server URL |
| `TRICKLE_ENABLED` | `1` | Set to `0` to disable all observation |
| `TRICKLE_LOCAL` | `0` | `1` for offline mode (writes to `.trickle/` files, no backend needed) |
| `TRICKLE_LOCAL_DIR` | `.trickle` | Override local output directory |
| `TRICKLE_DEBUG` | `0` | `1` for verbose debug output |
| `TRICKLE_ENV` | auto-detected | Override environment name |

### Observation Control

| Variable | Default | Description |
|----------|---------|-------------|
| `TRICKLE_TRACE_VARS` | `1` | `0` to disable variable tracing |
| `TRICKLE_PRODUCTION` | `0` | `1` for production mode (samples non-errors, disables var tracing) |
| `TRICKLE_SAMPLE_RATE` | `1.0` | Fraction of calls to observe (0.01 = 1%) |
| `TRICKLE_OBSERVE_INCLUDE` | all user code | Comma-separated module patterns to trace |
| `TRICKLE_OBSERVE_EXCLUDE` | none | Comma-separated module patterns to skip |
| `TRICKLE_CAPTURE_CONSOLE` | `1` | `0` to disable console output capture |
| `TRICKLE_SERVICE_NAME` | cwd basename | Service name for distributed tracing |

### Code Generation

| Variable | Default | Description |
|----------|---------|-------------|
| `TRICKLE_INJECT` | `0` | `1` to inject types into source files |
| `TRICKLE_COVERAGE` | `0` | `1` to print type coverage report on exit |
| `TRICKLE_SUMMARY` | `0` | `1` to print type summary on exit |
| `TRICKLE_STUBS` | `1` (Python auto mode) | `0` to disable .pyi generation |
| `TRICKLE_AUTO` | `0` | `1` to enable auto mode via auto-env entry point |

### LLM Budget Enforcement

| Variable | Default | Description |
|----------|---------|-------------|
| `TRICKLE_TOKEN_BUDGET` | `0` (unlimited) | Max total tokens. Alert at 50%, warn at 80%, stop at 100% |
| `TRICKLE_COST_BUDGET` | `0` (unlimited) | Max cost in USD. Same graduated alerts |

### Cloud

| Variable | Default | Description |
|----------|---------|-------------|
| `TRICKLE_CLOUD_URL` | none | Cloud backend URL for real-time sync |
| `TRICKLE_CLOUD_TOKEN` | none | Cloud authentication token |
| `TRICKLE_CLOUD_PROJECT` | cwd basename | Cloud project name |

### ML Hooks (Python)

| Variable | Default | Description |
|----------|---------|-------------|
| `TRICKLE_ACT_EVERY` | `20` | Activation stats frequency (every N forward passes) |
| `TRICKLE_ACT_MIN_ELEMENTS` | `8` | Min tensor elements for activation stats |
| `TRICKLE_ATT_EVERY` | `20` | Attention stats frequency |
| `TRICKLE_LOSS_EVERY` | `5` | Loss probe frequency |

### Backend Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4888` | Server port |
| `TRICKLE_DB_PATH` | `~/.trickle/trickle.db` | SQLite database path |
| `TRICKLE_CORS_ORIGINS` | all origins | Comma-separated CORS origins |
| `TRICKLE_RATE_LIMIT` | `300` | Max requests per minute per IP |
| `TRICKLE_RETENTION_DAYS` | `30` | Data retention period for cleanup |

---

## `.trickle/` Directory Structure

All observation data is stored locally in the `.trickle/` directory.

| File | Contents |
|------|----------|
| `observations.jsonl` | Function type observations (args, return types, timing) |
| `variables.jsonl` | Variable assignments with types and sample values |
| `calltrace.jsonl` | Call graph — parent-child function relationships |
| `errors.jsonl` | Errors with stack traces and nearby variable values |
| `queries.jsonl` | Database queries (SQL, Redis, MongoDB) with timing |
| `traces.jsonl` | Distributed trace spans (cross-service) |
| `llm.jsonl` | LLM API calls (provider, model, tokens, cost) |
| `agents.jsonl` | Agent workflow events (LangChain, CrewAI, etc.) |
| `mcp.jsonl` | MCP tool call events |
| `memory.jsonl` | Agent memory operations (Mem0, LangGraph) |
| `logs.jsonl` | Structured log events (Python logging, structlog) |
| `websocket.jsonl` | WebSocket connection and message events |
| `profile.jsonl` | Memory RSS and heap snapshots |
| `console.jsonl` | Captured stdout/stderr output |
| `alerts.jsonl` | Detected anomalies and alerts |
| `heal.jsonl` | Auto-remediation plans |
| `types/` | Generated TypeScript `.d.ts` and Python `.pyi` stubs |
| `rules.json` | Custom alerting rules (created by `trickle rules init`) |
| `slos.json` | SLO definitions (created by `trickle slo init`) |
| `type_history.json` | Type evolution tracking |

---

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
         .trickle/llm.jsonl           (LLM calls: tokens, cost, latency)
         .trickle/agents.jsonl        (agent workflows: LangChain, CrewAI)
         .trickle/mcp.jsonl           (MCP tool calls)
         .trickle/memory.jsonl        (agent memory operations)
         .trickle/websocket.jsonl     (WebSocket messages)
         .trickle/profile.jsonl       (memory RSS + heap snapshots)
         .trickle/console.jsonl       (stdout/stderr output)
         .trickle/alerts.jsonl        (detected anomalies)
         .trickle/heal.jsonl          (fix plans for agents)
                ↓
    ┌───────────┼───────────┬──────────────┬─────────────┐
    ↓           ↓           ↓              ↓             ↓
 VSCode      Monitor      AI Agents      MCP Server    Cloud
 Extension   + Dashboard   (trickle       (39 tools)    (auto-push,
 (inline     + Webhook     heal,                        shared
  hints)     alerts        verify)                      dashboards)
```

## Backend API Reference

The trickle backend runs on port 4888 (configurable via `PORT`). All endpoints return JSON.

### Core Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/ingest` | Single observation payload |
| `POST` | `/api/ingest/batch` | Batch observation payloads (transactional) |
| `GET` | `/api/functions` | List functions (`?q=`, `?env=`, `?language=`, `?limit=`, `?offset=`) |
| `GET` | `/api/functions/:id` | Single function with latest snapshots |
| `GET` | `/api/types/:functionId` | Type snapshots for a function (`?env=`, `?limit=`) |
| `GET` | `/api/types/:functionId/diff` | Diff snapshots (`?from=&to=` or `?fromEnv=&toEnv=`) |
| `GET` | `/api/errors` | List errors (`?functionName=`, `?env=`, `?since=`, `?limit=`) |
| `GET` | `/api/errors/:id` | Single error with type snapshot |
| `GET` | `/api/tail` | SSE stream for live events (`?filter=`) |
| `GET` | `/api/codegen` | Generate types (17 format options via `?format=`) |
| `GET` | `/api/codegen/:functionName` | Types for specific function |
| `GET` | `/api/mock-config` | All observed routes with sample data |
| `GET` | `/api/diff` | Cross-function type drift report |
| `GET` | `/api/coverage` | Type observation coverage |
| `GET` | `/api/audit` | Type schema and API audit |
| `GET` | `/api/search` | Full-text search across types (`?q=`) |
| `GET` | `/api/health` | Health check |
| `GET` | `/dashboard` | Interactive HTML dashboard |

### Cloud Endpoints (Authenticated)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/keys` | Generate API key |
| `POST` | `/api/v1/ingest` | Real-time streaming ingest |
| `POST` | `/api/v1/push` | Upload project data |
| `GET` | `/api/v1/pull` | Download project data |
| `GET` | `/api/v1/projects` | List projects |
| `POST` | `/api/v1/projects` | Create project |
| `POST` | `/api/v1/share` | Create shareable dashboard link |
| `GET` | `/api/v1/shared/:id` | View shared data (public, no auth) |
| `GET` | `/api/v1/dashboard/:projectId` | Authenticated dashboard |

Cloud endpoints require `Authorization: Bearer <api-key>` header.

## Packages

| Package | Registry | Description |
|---------|----------|-------------|
| [`trickle-observe`](https://www.npmjs.com/package/trickle-observe) | npm | JS/TS runtime instrumentation |
| [`trickle-cli`](https://www.npmjs.com/package/trickle-cli) | npm | CLI for codegen, stubs, CI checks |
| [`trickle-backend`](https://www.npmjs.com/package/trickle-backend) | npm | Cloud backend — team sharing, hosted dashboards, API |
| [`trickle-observe`](https://pypi.org/project/trickle-observe/) | PyPI | Python runtime instrumentation |
| [`trickle-vscode`](https://marketplace.visualstudio.com/items?itemName=yiheinchai.trickle-vscode) | VS Marketplace | VSCode inline type hints |

## License

MIT
