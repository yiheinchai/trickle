# QA / Test Engineer: Catch Regressions and Understand Test Failures

You're responsible for quality. Trickle helps in two ways:
1. **Test observability**: run tests and see exactly what happened at runtime (queries, errors, variable values at failure points)
2. **Contract testing**: detect breaking API changes automatically in CI

## Install

```bash
npm install -g trickle-cli
pip install trickle-observe    # for Python projects
```

## Quick Start: Run Tests with Observability

```bash
# Auto-detects your test framework (jest, vitest, pytest, mocha)
trickle test

# Or specify:
trickle test "npx jest"
trickle test "npx vitest run"
trickle test "python -m pytest tests/"
```

You get structured results with runtime context at failure points:
```
Tests:  9 passed | 1 failed | 0 skipped | 10 total

Failures:
  ✗ should return user by id
    Expected status 200 but got 404
    Variables near failure: user_id = 999, row = null
    Queries: SELECT * FROM users WHERE id = 999

Observability:
  10 functions | 69 queries | N+1 pattern detected
```

After tests, check for deeper issues:
```bash
trickle summary       # root causes, N+1 patterns, slow queries
trickle flamegraph    # performance hotspots
trickle doctor        # health check with recommended actions
```

## Quick Start: API Contract Testing

### Step 1: Capture a baseline

```bash
trickle run npm test
trickle check --save baseline.json
```

Commit `baseline.json` to your repo.

### Step 2: Check for breaking changes in CI

```bash
trickle run npm test
trickle check --against baseline.json
```

Exit code 0 = no breaking changes. Exit code 1 = something broke.

## Use Case 1: Detect Removed Fields

A backend developer removes `email` from the user response. `trickle check` catches it:

```
  BREAKING: GET /api/users
    - Removed field: email (was: string)
```

## Use Case 2: Detect Type Changes

`id` changed from `number` to `string`:

```
  BREAKING: GET /api/users/:id
    - Field type changed: id (number → string)
```

## Use Case 3: View All Type Drift

See what's changed across all endpoints:

```bash
trickle diff --since 1w
```

Shows every field addition, removal, and type change in the last week.

Compare across environments:

```bash
trickle diff --env1 staging --env2 production
```

## Use Case 4: Generate Test Files

Generate API tests from observed types:

```bash
trickle test --generate -o tests/api.test.ts --framework vitest
```

This creates test files that:
- Hit every observed endpoint
- Verify response shapes match captured types
- Use realistic sample data from actual observations

```bash
# Or for Jest
trickle test --generate -o tests/api.test.ts --framework jest
```

## Use Case 5: Replay Captured Requests

Replay previously captured API requests and verify responses still match:

```bash
trickle replay --target http://localhost:3000
```

Options:
```bash
# Strict mode — compare exact values, not just shapes
trickle replay --strict

# Stop on first failure
trickle replay --fail-fast

# JSON output for CI parsing
trickle replay --json
```

## Use Case 6: Validate Live Endpoints

Check a specific endpoint against expected types:

```bash
trickle validate GET http://localhost:3000/api/users
trickle validate POST http://localhost:3000/api/users -d '{"name":"test","email":"test@test.com"}'

# Strict mode — extra fields are errors
trickle validate GET http://localhost:3000/api/users --strict
```

## Use Case 7: API Audit

Run quality checks on observed API types:

```bash
trickle audit
```

Flags issues like:
- Sensitive data in responses (passwords, tokens)
- Inconsistent naming conventions
- Overly complex response types

```bash
# Fail in CI on errors
trickle audit --fail-on-error

# Fail on warnings too
trickle audit --fail-on-warning

# JSON output
trickle audit --json
```

## Use Case 8: Type Coverage Report

How much of your API is observed?

```bash
trickle coverage
```

Shows which endpoints have type data and which are missing. Use in CI:

```bash
# Fail if health score below 80
trickle coverage --fail-under 80

# JSON for dashboards
trickle coverage --json
```

## Use Case 9: Error Tracking

See all errors captured during test runs:

```bash
trickle errors

# Filter by endpoint
trickle errors --function "POST /api/orders"

# Recent errors
trickle errors --since 1h

# Full error detail with stack trace
trickle errors <error-id>
```

## CI Pipeline Example

```yaml
# .github/workflows/api-check.yml
jobs:
  api-contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install
      - run: npm install -g trickle-cli

      # Start the server in background
      - run: trickle run node src/server.js &
      - run: sleep 3

      # Run tests to generate traffic
      - run: npm test

      # Check for breaking changes
      - run: trickle check --against baseline.json

      # Audit for quality issues
      - run: trickle audit --fail-on-error

      # Coverage threshold
      - run: trickle coverage --fail-under 80
```

## Updating the Baseline

When breaking changes are intentional:

```bash
trickle run npm test
trickle check --save baseline.json
git add baseline.json
git commit -m "Update API type baseline — added pagination fields"
```
