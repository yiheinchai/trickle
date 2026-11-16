# trickle-lite

Runtime type monitoring for TypeScript. trickle-lite shows what every value actually was while your code ran, and where that drifts from the type you declared.

A type annotation is a contract, and `tsc` proves the code consistent with it. Nothing checks that the contract matches reality: `JSON.parse(raw) as Lesson`, `items[0]` typed as present, or a regex group typed `string` all compile. trickle-lite records the types that really flow through the code. It then has your own `tsc` check each one against the declared type, and reports any mismatch as drift.

It runs on a project from the outside: nothing goes into the project's config, dependencies or working tree. Its data (observations, drift report, the shadow copy it type-checks) lives in `~/.cache/trickle-lite/<project>-<hash>/` (or under `$XDG_CACHE_HOME`).

## Use

```sh
npm install && npm run build && npm link   # `trickle-lite` on PATH (not yet on npm)

cd your-project
trickle-lite run pnpm test                 # or: npx vitest run, npx tsx src/index.ts, node app.ts
trickle-lite show src/lesson.ts            # source with the runtime type of each value (handy for agents)
trickle-lite check                         # re-check after editing types; exit code 1 when there is drift
```

`run` puts a loader hook in `NODE_OPTIONS`. In node/tsx processes it instruments project TypeScript as it loads. In Vitest it adds the trickle-lite plugin to any config written with `defineConfig` from `vitest/config`.

## VS Code

```sh
npm run vscode:package && code --install-extension vscode/trickle-lite.vsix
```

Observed types appear inline, live while the code runs: `: T` after values with no annotation, and `⇒ T` after a function's parameters for what it returned. `⚠` marks drift. Hover a hint or name for the full type, how often it was seen, and TypeScript's explanation of any drift. Drift shows as warnings in Problems, and values declared `any` as hints. The check reruns when observations change or you save. The settings are `trickleLite.hints.enabled` and `trickleLite.hints.annotated` (the second also shows hints where a type is already written).

## How it works

1. **Capture.** `instrument.ts` parses each project file with the TypeScript parser and wraps parameters, variable initialisers, assignments, destructured names, `catch` bindings and `return` values with `__tt(point, value)`. No lines are added, so stack traces keep their line numbers.
2. **Record.** `runtime.ts` infers a compact type per value and merges them into a union per point. It never calls getters or reads proxies, it bounds work per value, and it samples hot paths after warm-up but still checks every value's top-level kind. Types go to `observations.jsonl` in the data folder, which `run` compacts at the end.
3. **Check.** `check.ts` writes a shadow copy of the project to the data folder with `node_modules` linked. Next to each observed value it adds `const __tcN: typeof value = null as unknown as (<runtime type>)`, then runs the project's own `tsc -p`. Errors on those lines are drift, in TypeScript's own words. Where the record is deliberately imprecise, the check trusts the declaration: long strings, class instances, `Date` and typed arrays, tuples, RegExp matches. Generic type parameters are skipped.

Only code that runs is checked. Instrumentation slows hot loops, so timing-sensitive tests can fail under it. `TRICKLE_EXCLUDE` (comma-separated path fragments) skips files, and `TRICKLE_TESTS=1` observes test files too.

## Privacy

Only types are recorded, never values. The exception is short identifier-like strings (24 characters or fewer, `[A-Za-z0-9_\-.:/]`), kept as literal types so enum drift can be caught, and never under keys that look sensitive. Everything stays on the machine, in the data folder; `trickle-lite clear` deletes it.

## Develop

```sh
npm test   # build, bundle the extension, node:test (types, instrumenter, end-to-end drift, extension on a stubbed vscode API)
```
