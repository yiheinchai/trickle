### **AXIS 1: Core Runtime Type Capture**

The foundation. This is what trickle IS.

| Feature                       | What it does                              | Verdict       |
| :---------------------------- | :---------------------------------------- | :------------ |
| `run`                         | Run any script with auto type observation | KEEP — core   |
| `hints`                       | Output source with inline types (CLI)     | KEEP — core   |
| `hints --errors`              | Crash-time variable state for debugging   | KEEP — core   |
| `vars`                        | Show captured variable types/values       | KEEP — core   |
| `init`                        | Set up trickle in a project               | KEEP — core   |
| `status`                      | Quick overview of available data          | KEEP — useful |
| `errors`                      | List captured errors                      | KEEP — useful |
| VSCode inlay hints            | Inline types in editor                    | KEEP — core   |
| VSCode error mode             | Crash-time values on assignment lines     | KEEP — core   |
| VSCode autocomplete           | Runtime-type-aware completions            | KEEP — core   |
| VSCode semantic tokens        | Property/method coloring                  | KEEP — core   |
| Notebook integration          | `%load_ext trickle`                       | KEEP — core   |
| Python `type_inference.py`    | Runtime type inference engine             | KEEP — core   |
| Python `notebook.py`          | AST transformer for notebooks             | KEEP — core   |
| Python `\_entry_transform.py` | AST transformer for scripts               | KEEP — core   |
| Python `observe_runner.py`    | trickle run Python entrypoint             | KEEP — core   |
| JS `type-inference.ts`        | Runtime type inference for JS             | KEEP — core   |
| JS `trace-var.ts`             | Variable tracing for JS                   | KEEP — core   |

---

### **AXIS 2: Type Codegen & Stubs**

Generating `.d.ts`/`.pyi` from observed types.

| Feature                    | What it does                             | Verdict |
| :------------------------- | :--------------------------------------- | :------ |
| `codegen`                  | Generate TS/Python type definitions      | Keep?   |
| `stubs`                    | Generate .d.ts/.pyi sidecar files        | Keep?   |
| `annotate`                 | Write type annotations into source files | Keep?   |
| `auto`                     | Auto-detect project and generate types   | Keep?   |
| `infer`                    | Infer types from JSON file/stdin         | Keep?   |
| Python `\_auto_codegen.py` | .pyi generation engine                   | Keep?   |
| JS `auto-codegen.ts`       | .d.ts generation engine                  | Keep?   |

---

### **AXIS 3: API Observation (Express/FastAPI/etc.)**

Capturing HTTP route types.

| Feature                | What it does                                  | Verdict |
| :--------------------- | :-------------------------------------------- | :------ |
| `functions`            | List observed functions                       | Keep?   |
| `types`                | Show type snapshots for a function            | Keep?   |
| `diff`                 | Type drift across functions                   | Keep?   |
| `openapi`              | Generate OpenAPI spec from runtime            | Keep?   |
| `mock`                 | Mock API server from observed routes          | Keep?   |
| `overview`             | Compact API overview with inline types        | Keep?   |
| `trace`                | HTTP request with inline type annotations     | Keep?   |
| `check`                | Detect breaking API changes                   | Keep?   |
| `validate`             | Validate live response against observed types | Keep?   |
| JS `express.ts`        | Express auto-instrumentation                  | Keep?   |
| JS `fastify.ts`        | Fastify auto-instrumentation                  | Keep?   |
| JS `koa.ts`            | Koa auto-instrumentation                      | Keep?   |
| JS `hono.ts`           | Hono auto-instrumentation                     | Keep?   |
| JS `lambda.ts`         | Lambda handler wrapping                       | Keep?   |
| Python `instrument.py` | FastAPI/Flask/Django auto-instrumentation     | Keep?   |

---

### **AXIS 4: ML/PyTorch Deep Hooks**

Beyond basic type capture — gradient flows, activations, etc.

| Feature                         | What it does                            | Verdict |
| :------------------------------ | :-------------------------------------- | :------ |
| `layers`                        | Per-layer activation/gradient breakdown | Keep?   |
| Python `\_backward_hook.py`     | Gradient norm tracking                  | Keep?   |
| Python `\_activation_hook.py`   | Activation statistics                   | Keep?   |
| Python `\_attention_hook.py`    | Attention pattern capture               | Keep?   |
| Python `\_checkpoint_hook.py`   | Checkpoint observability                | Keep?   |
| Python `\_dataloader_hook.py`   | DataLoader batch shapes                 | Keep?   |
| Python `\_optimizer_hook.py`    | Optimizer state tracking                | Keep?   |
| Python `\_lr_scheduler_hook.py` | LR schedule tracking                    | Keep?   |
| Python `\_loss_probe_hook.py`   | Loss landscape probing                  | Keep?   |
| Python `progress.py`            | Training progress tracking              | Keep?   |

---

### **AXIS 5: LLM/Agent Observability**

Tracing AI API calls, agent workflows, costs.

| Feature                            | What it does                           | Verdict |
| :--------------------------------- | :------------------------------------- | :------ |
| `llm`                              | Show captured LLM calls (tokens, cost) | Keep?   |
| `cost-report`                      | LLM cost breakdown by model/function   | Keep?   |
| `mcp-calls`                        | Show captured MCP tool calls           | Keep?   |
| `memory`                           | Agent memory operations (Mem0)         | Keep?   |
| `eval`                             | Score agent reliability                | Keep?   |
| `benchmark`                        | Multi-trial reliability testing        | Keep?   |
| `playback`                         | Step-by-step agent execution replay    | Keep?   |
| `summarize`                        | Compress agent traces to key decisions | Keep?   |
| Python `llm_observer.py`           | OpenAI/Anthropic/Gemini auto-patch     | Keep?   |
| Python `agent_observer.py`         | LangChain agent tracing                | Keep?   |
| Python `claude_agent_observer.py`  | Claude Agent SDK tracing               | Keep?   |
| Python `openai_agents_observer.py` | OpenAI Agents SDK tracing              | Keep?   |
| Python `mcp_observer.py`           | MCP tool call tracing                  | Keep?   |
| Python `memory_observer.py`        | Mem0 memory tracing                    | Keep?   |
| JS `llm-observer.ts`               | LLM call tracing for JS                | Keep?   |
| JS `mcp-observer.ts`               | MCP tracing for JS                     | Keep?   |

---

### **AXIS 6: "Datadog Replacement"**

Enterprise observability features nobody asked for.

| Feature                      | What it does                            | Verdict |
| :--------------------------- | :-------------------------------------- | :------ |
| `monitor`                    | Performance issues, anomalies, alerts   | Cut?    |
| `dashboard-local`            | Self-contained observability dashboard  | Cut?    |
| `dashboard`                  | Web dashboard                           | Cut?    |
| `metrics`                    | APM-style p50/p95/p99 latency           | Cut?    |
| `slo`                        | Service Level Objective monitoring      | Cut?    |
| `heal`                       | Auto-remediation with fix plans         | Cut?    |
| `verify`                     | Compare metrics with baseline           | Cut?    |
| `anomaly`                    | Performance anomaly detection           | Cut?    |
| `waterfall`                  | Request timeline (Jaeger-like)          | Cut?    |
| `flamegraph`                 | Interactive flamegraph from call traces | Cut?    |
| `security`                   | Security scanning (SQL injection, PII)  | Cut?    |
| `compliance`                 | EU AI Act / Colorado AI Act audit       | Cut?    |
| `ci`                         | CI/CD integration with annotations      | Cut?    |
| `agent`                      | Autonomous debugging agent              | Cut?    |
| `doctor`                     | Comprehensive health check              | Cut?    |
| `fix`                        | Generate code fix suggestions           | Cut?    |
| `why`                        | Causal debugging trace                  | Cut?    |
| `ticket`                     | Create Jira/Linear/GitHub issues        | Cut?    |
| `changelog`                  | Auto-generate API changelog             | Cut?    |
| `deps`                       | Module dependency graph                 | Cut?    |
| `cost`                       | Cloud cost estimation per function      | Cut?    |
| `diff-runs`                  | Compare two trickle runs                | Cut?    |
| `cleanup`                    | Prune old `.trickle/` data              | Keep?   |
| `cloud`                      | Cloud sync, team sharing, RBAC          | Cut?    |
| Python `profile_observer.py` | Memory profiling                        | Cut?    |
| Python `log_observer.py`     | Structured log aggregation              | Cut?    |
| Python `db_observer.py`      | Database query tracing                  | Cut?    |
| Python `http_observer.py`    | HTTP client tracing                     | Cut?    |
| Python `request_context.py`  | Per-request correlation                 | Cut?    |
| JS `db-observer.ts`          | Database tracing for JS                 | Cut?    |
| JS `fetch-observer.ts`       | Fetch/HTTP tracing for JS               | Cut?    |
| JS `log-observer.ts`         | Log aggregation for JS                  | Cut?    |
| JS `ws-observer.ts`          | WebSocket tracing                       | Cut?    |
| JS `request-context.ts`      | Request correlation for JS              | Cut?    |

---

### **AXIS 7: Misc / Packaging**

| Feature                                | What it does                             | Verdict                     |
| :------------------------------------- | :--------------------------------------- | :-------------------------- |
| `demo`                                 | Self-running feature showcase            | Cut?                        |
| `pack` / `unpack`                      | Portable type bundle export/import       | Cut?                        |
| `export`                               | Generate all output formats at once      | Cut?                        |
| `proxy`                                | Reverse proxy for capture without code   | Keep?                       |
| `capture`                              | Capture types from live API endpoint     | Keep?                       |
| `search`                               | Search across observed types             | Keep?                       |
| `sample`                               | Generate test fixtures from runtime data | Keep?                       |
| `test-gen` / `test-runner`             | Test generation and running              | Keep?                       |
| `replay`                               | Replay captured API requests             | Keep?                       |
| `docs`                                 | Generate API docs from runtime types     | Keep?                       |
| `coverage`                             | Type observation health report           | Keep?                       |
| `dev`                                  | Dev mode with live type generation       | Keep?                       |
| `mcp-server`                           | MCP server for AI agents (26 tools)      | Keep?                       |
| `context`                              | Runtime context for AI agents            | Keep? (overlap with hints?) |
| `summary` / `explain`                  | Agent-optimized summaries                | Keep?                       |
| JS `vite-plugin.ts`                    | Vite integration                         | Keep?                       |
| JS `next-plugin.ts` / `next-loader.ts` | Next.js integration                      | Keep?                       |
| JS `metro-transformer.ts`              | React Native integration                 | Keep?                       |

---
