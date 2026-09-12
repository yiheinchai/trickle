## 2026-09-12

### Decisions
- Product is runtime types in VSCode (plain files + Jupyter) and `trickle hints`/`vars`/`run`/`init`. Everything else is being deleted by parallel cut agents.
- Type system target: TypeScript Handbook behavior, but types originate from runtime capture (Python and JS/TS). One TypeNode algebra; checker ops (unify, assignability, keyof, indexed access, conditionals, mapped, template literals, utility types, narrowing) match TS.

### Agents in flight
- Cut: CLI, Python client, JS client, VSCode extension, backend/docs/tests
- Type system: `packages/type-system` checker, Python `type_inference`/`type_ops`, JS `type-inference`/`type-ops`, handbook catalog

### Open questions
- Wire checker into VSCode inlay formatting and jsonl observation unify (replace last-write-wins) after cuts land.
- Python/JS capture must stay backward compatible with existing `{kind,name,properties,members}` JSON.
