# trickle-lite

Runtime type monitoring for TypeScript. trickle-lite shows what every value really was while your code ran, and where that drifts from the type you declared.

A type annotation is a contract, and `tsc` proves the code consistent with it. Nothing checks that the contract describes reality: `JSON.parse(raw) as Lesson`, `items[0]` typed as present, or a regex group typed `string` all compile. trickle-lite records the types that actually flow through the code. It then has your own `tsc` check each one against the declared type, in the same scope, and reports any mismatch as drift.

This is the slim core of trickle, for TypeScript only. It has no backend, no framework or LLM instrumentation, and no Python. It does three things: capture, check and show.

## Quick start

```sh
npm install && npm run build && npm link     # `trickle-lite` on PATH (not yet on npm)
trickle-lite run -- npx tsx src/index.ts     # any node/tsx program
trickle-lite run --no-node-hook -- npx vitest run   # Vitest, with the plugin (below)
trickle-lite show src/lesson.ts              # source with the runtime type of each value
trickle-lite check                           # drift report (exit code 1 when there is drift)
```

For Vitest, add the plugin. It instruments project files before esbuild strips their types and installs the recorder in each worker:

```ts
import { trickle } from 'trickle-lite/vitest';
export default defineConfig({ plugins: [trickle()] });
```

To keep the dependency optional, load it only when `TRICKLE_LITE_HOME` is set. `trickle-lite run` sets it; see the Bunshin repository's `scripts/trickle.mjs`.

## VS Code

```sh
npm run vscode:package && code --install-extension vscode/trickle-lite.vsix
```

- **Inline hints**: `: T` after unannotated values, `⇒ T` after a function's parameters for what it returned, and `≈ T` on annotated values if `trickleLite.hints.annotated` is on. `⚠` marks drift.
- **Hover**: the full runtime type, how many times it was seen, and TypeScript's explanation of any drift.
- **Problems**: drift as warnings. Values declared `any` appear as hints, with a quick fix that writes the observed type in. Undeclared properties are optional, through `trickleLite.diagnostics.undeclaredProperties`.
- **Live**: hints refresh within a second of new observations while the program runs. The drift check reruns when observations change or a file is saved.

## How it works

1. **Capture.** `src/instrument.ts` parses each project file with the TypeScript parser. It wraps parameters, variable initialisers, assignments, destructured names, `catch` bindings and `return` expressions with `__tt(point, value)`. No line breaks are added, so stack traces keep their line numbers. Node runs go through a loader hook (`--import trickle-lite/register`, which also resolves `./x.js` to `x.ts`); Vitest goes through the plugin.
2. **Record.** `src/runtime.ts` infers a compact type for each value and merges it into a union per point. It never calls getters or reads proxies, and it handles cycles. Objects keep separate shapes, and discriminated unions stay unions. It appends changes to `.trickle/observations.jsonl`, which any number of processes can share. Hot paths are sampled after warm-up, but every value's top-level kind is still checked, so a rare `undefined` is not missed.
3. **Check.** `src/check.ts` writes a shadow copy of the project under `.trickle/shadow` (with `node_modules` linked). Next to each observed value it adds `const __tcN: typeof value = null as unknown as (<runtime type>)`, plus per-property and excess-property checks, and runs the project's own `tsc -p`. Errors on those lines become drift, worded by TypeScript itself. Small helper types defer to the declaration where the record is deliberately imprecise: long strings, class instances, `Date`, typed arrays, tuples and RegExp matches. Generic type parameters are skipped.

## Privacy

Only types are recorded, never values. Short identifier-like strings (24 characters or fewer, `[A-Za-z0-9_\-.:/]`) are kept as literal types for enum checks, except under keys that look sensitive. Everything stays in `.trickle/`. Add that folder to `.gitignore`.

## Environment

| Variable | Effect |
|---|---|
| `TRICKLE_ROOT` | Project root (default: nearest directory with `.git` or `pnpm-workspace.yaml`) |
| `TRICKLE_INCLUDE` / `TRICKLE_EXCLUDE` | Comma-separated path fragments to observe / skip |
| `TRICKLE_TESTS=1` | Also observe test files (skipped by default) |
| `TRICKLE_DISABLE=1` | Observation off |

## Develop

```sh
npm test               # builds, then node:test (types, instrumenter, end-to-end drift, extension against a stubbed vscode API)
npm run vscode:build   # bundles vscode/dist/{extension.js,cli.mjs}
```
