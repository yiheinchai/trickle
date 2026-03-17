# AI / LLM Developer: Auto-Generate Tool Schemas from Runtime Types

You're building AI applications with function calling, tool use, or MCP servers. Writing JSON schemas for every function by hand is tedious and error-prone — especially when your functions change. Trickle observes your functions at runtime and generates accurate tool schemas automatically.

## Install

```bash
npm install -g trickle-cli
npm install trickle-observe
```

---

## Use Case 1: Generate OpenAI Function Calling Schemas

Run your app once with trickle, then generate tool schemas:

```bash
# Step 1: Run your app to observe function types
trickle run node api.js

# Step 2: Generate OpenAI-compatible tool schemas
trickle tool-schema
```

**Output:**
```json
[
  {
    "type": "function",
    "function": {
      "name": "createUser",
      "description": "create user (from api module)",
      "parameters": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "email": { "type": "string" },
          "role": { "type": "string" }
        },
        "required": ["name", "email", "role"]
      }
    }
  }
]
```

Use directly with the OpenAI API:
```typescript
const response = await openai.chat.completions.create({
  model: 'gpt-4',
  messages: [...],
  tools: JSON.parse(fs.readFileSync('tools.json', 'utf-8')),
});
```

---

## Use Case 2: Anthropic Tool Use (Claude API)

```bash
trickle tool-schema --format anthropic --out tools.json
```

**Output:**
```json
[
  {
    "name": "getUser",
    "description": "get user (from db module)",
    "input_schema": {
      "type": "object",
      "properties": {
        "id": { "type": "number" }
      },
      "required": ["id"]
    }
  }
]
```

---

## Use Case 3: MCP Server Tool Definitions

Building an MCP server? Generate tool definitions from your existing functions:

```bash
trickle tool-schema --format mcp --out mcp-tools.json
```

**Output:**
```json
[
  {
    "name": "searchUsers",
    "description": "search users (from api module)",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": { "type": "string" },
        "limit": { "type": "number" }
      },
      "required": ["query", "limit"]
    }
  }
]
```

---

## Use Case 4: Filter by Function or Module

```bash
# Specific function
trickle tool-schema createUser

# All functions from a module
trickle tool-schema --module api

# Save to file
trickle tool-schema --out tools.json --format openai
```

---

## How It Works

1. **Run once**: `trickle run node app.js` observes all function calls
2. **Type inference**: Parameter names, types, and return types are captured from actual runtime data
3. **Schema generation**: `trickle tool-schema` converts observed types to JSON Schema

No manual schema writing. No type annotations needed. The schemas are derived from what your code actually does at runtime.

---

## Quick Start

```bash
# Install
npm install -g trickle-cli

# Run your app
trickle run node app.js

# Generate tool schemas
trickle tool-schema --format openai --out tools.json

# Use with your AI framework of choice
```
