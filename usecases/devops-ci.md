# DevOps / CI Engineer: Enforce API Contracts in Your Pipeline

You want to catch breaking API changes before they reach production. Trickle captures runtime types and gives you CLI commands that return exit codes — drop them into any CI pipeline.

## Install

```bash
npm install -g trickle-cli
```

## Quick Start

### Save a baseline

On your main branch, after tests pass:

```bash
trickle run npm test
trickle check --save api-baseline.json
git add api-baseline.json && git commit -m "Save API type baseline"
```

### Check in CI

```bash
trickle run npm test
trickle check --against api-baseline.json
```

Exit code 1 if any breaking change is detected.

## GitHub Actions Example

```yaml
name: API Contract Check

on: [pull_request]

jobs:
  api-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci
      - run: npm install -g trickle-cli

      # Start the server
      - run: trickle run node src/server.js &
      - run: sleep 3

      # Run test suite to generate traffic
      - run: npm test

      # Check for breaking changes
      - name: API contract check
        run: trickle check --against api-baseline.json

      # Quality audit
      - name: API audit
        run: trickle audit --fail-on-error

      # Coverage threshold
      - name: Type coverage
        run: trickle coverage --fail-under 80 --json
```

## Use Case 1: Breaking Change Detection

`trickle check` detects:
- **Removed fields** — a response field that existed before is gone
- **Type changes** — `id` was `number`, now it's `string`
- **Removed endpoints** — an entire route no longer responds

```bash
trickle check --against api-baseline.json
```

Output on failure:
```
  BREAKING CHANGES DETECTED

  GET /api/users
    - Removed field: email (was: string)
    - Type changed: role (string → number)

  DELETE /api/users/:id
    - Endpoint no longer observed

  2 endpoints affected, 3 breaking changes
```

## Use Case 2: API Quality Audit

```bash
trickle audit --fail-on-error --json > audit-results.json
```

Checks for:
- Sensitive data in responses (passwords, tokens, secrets)
- Inconsistent naming (camelCase vs snake_case mixed)
- Overly complex response shapes
- Missing common fields (pagination, timestamps)

## Use Case 3: Type Coverage as a Gate

```bash
trickle coverage --fail-under 80
```

Fails the build if less than 80% of endpoints have type observations. Useful to ensure test suites actually hit the API.

```bash
# JSON output for dashboards
trickle coverage --json

# Custom staleness threshold
trickle coverage --stale-hours 48
```

## Use Case 4: Diff Report in PR Comments

Generate a diff of what changed:

```bash
trickle diff --since 1d > type-diff.txt
```

Post as a PR comment using your CI tool. Reviewers see exactly which API types changed.

## Use Case 5: Proxy for Production Monitoring

Run a proxy in front of your production API:

```bash
trickle proxy --target http://production-api:3000 --port 4000
```

Then periodically check:
```bash
trickle check --against production-baseline.json
```

Detect when production behavior drifts from expected types.

## Use Case 6: Export Observations

```bash
trickle export --dir ./type-snapshots/
```

Archive type observations for compliance or analysis.

```bash
trickle pack -o types-snapshot.json     # portable bundle
trickle unpack types-snapshot.json      # import into another environment
```

## Use Case 7: One-Command CI with `trickle ci`

The simplest CI integration — one command does everything:

```yaml
# GitHub Actions
- run: npx trickle ci "python -m pytest tests/"
```

This command:
1. Runs your tests with trickle instrumentation
2. Detects N+1 queries, slow functions, errors, memory issues
3. Posts `::error::` and `::warning::` annotations directly on your PR
4. Exits non-zero if critical issues are found

```bash
# Fail on warnings too (stricter)
trickle ci "npm test" --fail-on-warning

# JSON output for custom integrations
trickle ci "npm test" --format json
```

## Use Case 8: Autonomous Agent Analysis

```bash
trickle agent "python app.py" --fix
```

Generates a visual analysis report with:
- Status (healthy/warning/critical)
- Performance hotspot bar chart
- N+1 query detection
- Fix recommendations
- Error summaries

## CI Commands Reference

| Command | Exit Code | Use |
|---|---|---|
| `trickle ci "<command>"` | 1 on critical | **One-command CI** (recommended) |
| `trickle agent "<command>" --fix` | 0 | Autonomous debugging report |
| `trickle monitor` | 0 | Detect issues (writes alerts.jsonl) |
| `trickle verify --baseline` / `trickle verify` | 0 | Before/after comparison |
| `trickle check --against <file>` | 1 on breaking changes | Contract enforcement |
| `trickle audit --fail-on-error` | 1 on errors | Quality gate |
| `trickle coverage --fail-under <N>` | 1 below threshold | Coverage gate |

All commands support `--json` for machine-readable output.

## Updating the Baseline

When breaking changes are intentional (new API version, planned removal):

```bash
trickle run npm test
trickle check --save api-baseline.json
git add api-baseline.json
git commit -m "Update API baseline — removed deprecated email field"
```
