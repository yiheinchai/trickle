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

## Deployed code (Cloudflare Workers)

The same observation works on a deployed Worker. Types go to a separate trickle-lite server with its own Postgres, never to the Worker's own database:

```
Worker (instrumented build) --HTTPS, write token--> trickle-lite serve --> its own Postgres
your machine / editor       <--read token---------- trickle-lite pull  (then check, show, VS Code as usual)
```

1. **Server.** Run `trickle-lite serve` (the `Dockerfile` here runs it) with `TRICKLE_INGEST_TOKEN` and `TRICKLE_READ_TOKEN`, two different random tokens. Its database is the Neon project in `neon.ts`. `neon env pull` writes `DATABASE_URL` (pooled, used for requests) and `DATABASE_URL_UNPOOLED` (direct, used to apply the schema) to `.env.local`, which the server reads when it starts. In production, set those two as environment variables instead. The schema (one table) is applied at start and is idempotent.
2. **Worker secrets**, once: `wrangler secret put TRICKLE_SERVER` (the server's https URL), `wrangler secret put TRICKLE_INGEST_TOKEN`, and optionally `TRICKLE_PROJECT`.
3. **Deploy observed**, in the Worker's directory: `trickle-lite worker npx wrangler deploy`. This builds an instrumented copy of the repository in the data folder, with an entry that sends observations after each response (`ctx.waitUntil`, so responses are not delayed), and deploys that. The repository is unchanged. A normal deploy afterwards replaces it with the uninstrumented Worker.
4. **Read**: `TRICKLE_SERVER=… TRICKLE_READ_TOKEN=… trickle-lite pull && trickle-lite check`. In VS Code, set `trickleLite.server` and run "trickle: Set Server Read Token" (kept in VS Code's secret storage); the extension pulls every 15 s.

**Only types leave the Worker.** It records no strings, no literals, no booleans and no sample values. Error messages are not recorded, only that something was an `Error`. Objects whose keys are not plain identifiers (IDs, emails, file names) are recorded as `{ [key: string]: T }` with the keys dropped. What does leave is code structure: file paths, variable and property names, and positions. The server applies the same rules again to everything it receives, validates every field, and refuses bodies over 1 MB. The ingest token can only write and the read token can only read. The Worker sends only over HTTPS (localhost excepted), and if the server is down the Worker carries on unaffected.

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
