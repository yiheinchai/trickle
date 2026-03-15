---
name: dogfood-trickle
description: >
  Dogfood trickle by creating real demo projects, running trickle on them,
  finding bugs and UX issues, then fixing and publishing them. Use when asked
  to test trickle, dogfood, find bugs, try trickle on a real project, or
  improve trickle's developer experience. Also use when someone says
  "test trickle on react", "try trickle with python", "dogfood ML workflow", etc.
argument-hint: "[focus: react|python|ml|express|fullstack|all]"
disable-model-invocation: true
---

# Dogfood Trickle

You are dogfooding trickle — testing it on real-world projects to find bugs, UX issues, and missing features, then fixing and publishing them.

## Workflow

### Phase 1: Setup a demo project

Based on the focus area (or pick one), create a realistic multi-file project:

**React/Frontend:**
- Express API backend with multiple endpoints (CRUD, nested responses, query params)
- React frontend with Vite
- Run backend with `trickle run node server.js`
- Hit all endpoints with curl to capture types
- Generate typed client: `trickle codegen --client -o src/api/client.ts`
- Generate React Query hooks: `trickle codegen --react-query -o src/api/hooks.ts`
- Build React app using the generated hooks
- Test Vite plugin: add `tricklePlugin()` to vite.config.ts

**Python/ML:**
- Multi-file project: data loading, model definition, training loop, metrics
- Use PyTorch, numpy, sklearn as appropriate
- Run with `import trickle.auto` at top of entry file
- Use conda base env: `eval "$(conda shell.zsh hook 2>/dev/null)" && conda activate base`
- Check generated `.pyi` stub files
- Test `trickle layers` for nn.Sequential observability
- Test `trickle vars` and `trickle functions`

**Express/Backend:**
- Multi-route Express app with middleware
- Run with `TRICKLE_LOCAL=1 trickle run node server.js`
- Test codegen for all formats: `--client`, `--react-query`, `--swr`, `--zod`, `--openapi`
- Test `trickle mock` for mock server

### Phase 2: Test every touchpoint

For each demo project, systematically test:

1. **Inline type hints** — Open files in VSCode, run `Trickle: Refresh Variables`, verify hints appear
2. **Variable tracing** — Check `.trickle/variables.jsonl` has data for all variables including function params
3. **Function observation** — Run `trickle functions` and `trickle overview`
4. **Code generation** — Generate all relevant output formats, verify they compile and have no duplicates
5. **CLI commands** — Try `trickle vars`, `trickle types <name>`, `trickle search <field>`, `trickle layers`
6. **Edge cases** — Subdirectories, multiple sessions, stale data, large projects

### Phase 3: File bugs and fix them

When you find an issue:

1. **Document it clearly** — What happened, what was expected, root cause if known
2. **Spawn a background agent** to fix it with a detailed prompt including:
   - Bug description with reproduction steps
   - Which files to modify
   - How to test the fix
   - Instructions to commit and push (per mission.md)
3. **Track all spawned agents** — Save to memory with status and test instructions
4. **When an agent completes**, spawn a publish agent for affected packages

### Phase 4: Publish

Per mission.md, after each fix/feature is pushed:

1. Bump the patch version in the affected package's `package.json`
2. Build the package
3. Publish to npm (`npm publish`) or VS Code Marketplace (`vsce publish`)
4. Commit version bump and push
5. Update the installed versions locally:
   - `npm install -g trickle-cli@latest`
   - `npm install trickle-observe@latest` (in demo projects)
   - `pip install --upgrade trickle-observe` (in conda base)

### Packages and their registries

| Package | Directory | Registry |
|---|---|---|
| `trickle-cli` | `packages/cli` | npm |
| `trickle-observe` (JS) | `packages/client-js` | npm |
| `trickle-observe` (Python) | `packages/client-python` | PyPI |
| `trickle-backend` | `packages/backend` | npm |
| `trickle-vscode` | `packages/vscode-extension` | VS Code Marketplace |

### Common issues found in past sessions

These are bugs that were found and fixed during dogfooding. Watch for regressions:

1. **Codegen duplicate declarations** — When observations.jsonl has stale/multi-session data, codegen produces duplicate `export function`, `export interface`, and duplicate object keys
2. **Vite plugin import injection** — `__trickle_tv()` injected inside `import {}` specifiers instead of after the import statement
3. **VSCode extension subdirectory lookup** — Extension only reads `.trickle/` from workspace root, not subdirectories
4. **JS function params not traced** — Unlike Python, JS didn't trace function parameters (req, res in Express callbacks)
5. **nn.Sequential observability** — All activation stats map to same line, need `trickle layers` CLI or inline hints per layer

### Environment notes

- Use conda base env for Python: `eval "$(conda shell.zsh hook 2>/dev/null)" && conda activate base`
- Python pip needs `--break-system-packages` flag outside conda
- Trickle local mode: `TRICKLE_LOCAL=1` (no backend needed)
- VSCode extension refresh: `Cmd+Shift+P` → `Trickle: Refresh Variables`
