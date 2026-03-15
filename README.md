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

**[Full DevOps Guide →](usecases/devops-ci.md)**

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

**What agents can query:**

| Data | Command | Description |
|------|---------|-------------|
| Variables | `trickle context <file>` | Types + actual values at every line |
| Functions | `trickle functions` | Signatures with parameter types + timing |
| Errors | `trickle context --errors` | Stack trace + nearby variable values |
| DB Queries | `trickle context --queries` | SQL/Redis/MongoDB with timing + row counts |
| HTTP | `trickle context --http` | Fetch calls with status codes + response types |
| Console | `trickle context --console` | All stdout/stderr with timestamps |

**Database tracing** captures SQL queries (pg, mysql2, sqlite3, psycopg2, pymysql), Redis commands (ioredis, redis-py), and MongoDB operations (mongoose, pymongo) — all automatically, zero config.

**MCP Integration** — 9 tools for direct agent access:
```json
{ "mcpServers": { "trickle": { "command": "npx", "args": ["trickle-cli", "mcp-server"] } } }
```

Tools: `get_runtime_context`, `get_annotated_source`, `get_function_signatures`, `get_errors`, `get_database_queries`, `get_console_output`, `get_http_requests`, `check_data_freshness`, `refresh_runtime_data`.

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
| `trickle run <cmd>` | Run any command with auto-instrumentation |
| `trickle dev` | Start app + watch for type changes |
| `trickle proxy -t <url>` | Capture types from any API (no code changes) |
| `trickle stubs src/` | Generate `.pyi` type stubs (Python) |
| `trickle annotate src/file.py` | Inject types into source (Python) |
| `trickle codegen --client` | Generate typed API client (TypeScript) |
| `trickle codegen --react-query` | Generate React Query hooks |
| `trickle openapi` | Generate OpenAPI 3.0 spec |
| `trickle check --against base.json` | CI: detect breaking type changes |
| `trickle context <file>` | Runtime context for AI agent debugging |
| `trickle context --annotated` | Source code with inline runtime values |
| `trickle tool-schema` | Generate LLM tool calling schemas |
| `trickle mcp-server` | MCP server for direct AI agent integration |
| `trickle functions` | List all observed functions |
| `trickle overview` | Compact view of all routes and types |
| `trickle vars` | Show traced variables with types |
| `trickle mock` | Start mock API server from captured data |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TRICKLE_LOCAL` | `0` | `1` for offline mode (no backend needed) |
| `TRICKLE_TRACE_VARS` | `1` | `0` to disable variable tracing |
| `TRICKLE_OBSERVE_INCLUDE` | all user code | Comma-separated module patterns to trace |
| `TRICKLE_OBSERVE_EXCLUDE` | none | Comma-separated module patterns to skip |
| `TRICKLE_INJECT` | `0` | `1` to inject types into source files |
| `TRICKLE_COVERAGE` | `0` | `1` to print type coverage report |
| `TRICKLE_DEBUG` | `0` | `1` for verbose output |

## Architecture

```
Your Code → trickle (import hooks / AST transform)
                ↓
         .trickle/observations.jsonl  (function types + timing)
         .trickle/variables.jsonl     (variable assignments)
         .trickle/errors.jsonl        (crash context + nearby values)
         .trickle/queries.jsonl       (SQL, Redis, MongoDB queries)
         .trickle/console.jsonl       (stdout/stderr output)
                ↓
    ┌───────────┼───────────┬──────────────┐
    ↓           ↓           ↓              ↓
 VSCode      CLI tools    AI Agents      MCP Server
 Extension   (codegen,    (trickle       (9 tools for
 (inline     stubs,       context,       Claude, Cursor,
  hints)     openapi)     CLAUDE.md)     Copilot)
```

## Packages

| Package | Registry | Description |
|---|---|---|
| [`trickle-observe`](https://www.npmjs.com/package/trickle-observe) | npm | JS/TS runtime instrumentation |
| [`trickle-cli`](https://www.npmjs.com/package/trickle-cli) | npm | CLI for codegen, stubs, CI checks |
| [`trickle-backend`](https://www.npmjs.com/package/trickle-backend) | npm | Optional backend for team sharing |
| [`trickle-observe`](https://pypi.org/project/trickle-observe/) | PyPI | Python runtime instrumentation |
| [`trickle-vscode`](https://marketplace.visualstudio.com/items?itemName=yiheinchai.trickle-vscode) | VS Marketplace | VSCode inline type hints |

## License

MIT
