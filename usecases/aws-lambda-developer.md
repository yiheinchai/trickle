# AWS Lambda Developer

## Quick Start: Debug Lambda Handlers Locally

```bash
npm install -g trickle-cli && npm install trickle-observe

# Run your tests with observability
trickle test                           # auto-detects jest/vitest/mocha
trickle test "npx vitest run"          # vitest specifically
trickle test "npx jest"                # jest specifically

# See what happened
trickle summary                        # errors, queries, root causes
trickle explain handler.js             # functions, call graph, data flow, variables
trickle flamegraph                     # performance hotspots

# For vitest inline type hints:
# Add to vitest.config.ts:
#   import { tricklePlugin } from 'trickle-observe/vite-plugin';
#   export default defineConfig({ plugins: [tricklePlugin()] });
```

Example output from `trickle explain handler.js`:
```
Functions:
  → createUser(event: { body: string }) -> { statusCode: number, body: string }  (5ms)
  → getUser(event: { pathParameters: { id: string } }) -> { statusCode: 404, ... }
  → listUsers(event: {}) -> { statusCode: 200, body: "[{\"id\":1,...}]" }

Variables:
  L14 body: { name: "Alice", email: "alice@test.com" }
  L27 user: null   ← why the 404 happened!

Database Queries: INSERT INTO users, SELECT * FROM users WHERE id = ?
```

## Who they are

Backend engineers deploying Node.js/TypeScript functions to AWS Lambda. They struggle with observability because Lambda's ephemeral, frozen processes make traditional debugging impossible.

## Pain points without trickle

- No way to see what types/values are flowing through handler code
- Adding `console.log` everywhere is tedious and must be removed before prod
- Cold starts mean they can't attach debuggers
- Local testing doesn't reveal Lambda-specific issues (e.g., `/var/task` is read-only)
- CloudWatch Logs are noisy — hard to grep for structured data

## How trickle helps

### Option A — Zero code changes (NODE_OPTIONS)

```bash
# Add these env vars to the Lambda function
NODE_OPTIONS=--require trickle-observe/lambda
TRICKLE_AUTO=1
TRICKLE_LOCAL_DIR=/tmp/.trickle
```

Trickle auto-instruments all functions when modules load, writes observations to `/tmp/.trickle/`, and they survive the invocation (Lambda keeps `/tmp` warm across invocations).

### Option B — Explicit wrapper

```typescript
import { wrapLambda } from 'trickle-observe/lambda';

export const handler = wrapLambda(async (event, context) => {
  const order = await fetchOrder(event.orderId);
  const result = processOrder(order);
  return { statusCode: 200, body: JSON.stringify(result) };
});
```

Trickle automatically:
- Writes variable traces to `/tmp/.trickle/variables.jsonl`
- Flushes to your backend before Lambda freezes the process
- Captures all function arguments and return values

### Option C — Stream to CloudWatch Logs

```typescript
import { wrapLambda, printObservations } from 'trickle-observe/lambda';

export const handler = wrapLambda(async (event, context) => {
  const result = await processOrder(event.orderId);
  printObservations(); // emits [trickle] JSON lines → CloudWatch
  return result;
});
```

Then pull observations locally:

```bash
trickle lambda pull --function my-order-processor --region us-east-1
```

### Lambda Layer (zero changes to existing functions)

```bash
trickle lambda layer --out trickle-layer.zip
aws lambda publish-layer-version \
  --layer-name trickle-observe \
  --zip-file fileb://trickle-layer.zip \
  --compatible-runtimes nodejs18.x nodejs20.x
```

### Real-time streaming to VSCode (via ngrok)

```bash
npx ngrok http 4888
# Set TRICKLE_BACKEND_URL=https://your-ngrok-url in Lambda env vars
```

Now every Lambda invocation streams observations directly to your VSCode inlay hints in real time.

## Customer journey

1. **Discovers trickle** — sees inline hints while debugging local code
2. **Deploys to Lambda** — wonders if they can get the same experience in the cloud
3. **Runs `trickle lambda setup`** — gets step-by-step instructions
4. **Adds NODE_OPTIONS env var** — zero code changes, observations start flowing
5. **Uses `trickle lambda pull`** — extracts observations from CloudWatch after an invocation
6. **Opens Lambda handler in VSCode** — sees inline type hints just like local dev
7. **Sets up ngrok for real-time** — now gets live hints on every invocation

## Key differentiator

Unlike CloudWatch Insights or X-Ray, trickle shows the actual **variable values and types** inline in the source code, exactly where the developer is looking — no context switching to a separate console.
