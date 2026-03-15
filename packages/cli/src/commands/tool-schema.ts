/**
 * Generate LLM tool calling schemas from observed function types.
 *
 * Reads .trickle/observations.jsonl and generates JSON schemas compatible with:
 * - OpenAI function calling (tools API)
 * - Anthropic tool use (Claude API)
 * - MCP server tool definitions
 *
 * Usage:
 *   trickle tool-schema                    # all functions
 *   trickle tool-schema createUser         # specific function
 *   trickle tool-schema --format openai    # OpenAI format (default)
 *   trickle tool-schema --format anthropic # Anthropic format
 *   trickle tool-schema --format mcp       # MCP server format
 *   trickle tool-schema --out tools.json   # write to file
 */

import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";

export interface ToolSchemaOptions {
  format?: "openai" | "anthropic" | "mcp";
  out?: string;
  module?: string;
}

interface TypeNode {
  kind: string;
  name?: string;
  elements?: TypeNode[];
  element?: TypeNode;
  properties?: Record<string, TypeNode>;
  class_name?: string;
}

interface Observation {
  functionName: string;
  module: string;
  argsType: TypeNode;
  returnType: TypeNode;
  paramNames?: string[];
  sampleInput?: unknown;
  sampleOutput?: unknown;
}

/**
 * Convert a trickle TypeNode to a JSON Schema type.
 */
function typeNodeToJsonSchema(node: TypeNode): Record<string, unknown> {
  if (!node) return { type: "string" };

  switch (node.kind) {
    case "primitive":
      switch (node.name) {
        case "string": return { type: "string" };
        case "number": return { type: "number" };
        case "integer": return { type: "integer" };
        case "boolean": return { type: "boolean" };
        case "null": return { type: "null" };
        case "undefined": return { type: "null" };
        default: return { type: "string" };
      }

    case "object": {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      if (node.properties) {
        for (const [key, value] of Object.entries(node.properties)) {
          properties[key] = typeNodeToJsonSchema(value);
          required.push(key);
        }
      }
      return {
        type: "object",
        properties,
        required: required.length > 0 ? required : undefined,
      };
    }

    case "array":
      return {
        type: "array",
        items: node.element ? typeNodeToJsonSchema(node.element) : { type: "string" },
      };

    case "union": {
      const types = (node.elements || []).map(typeNodeToJsonSchema);
      if (types.length === 2 && types.some(t => (t as any).type === "null")) {
        const nonNull = types.find(t => (t as any).type !== "null")!;
        return nonNull; // JSON Schema doesn't have a great nullable pattern for tool use
      }
      return { anyOf: types };
    }

    case "tuple":
      return {
        type: "array",
        items: (node.elements || []).map(typeNodeToJsonSchema),
      };

    default:
      return { type: "string" };
  }
}

/**
 * Build a JSON Schema for function parameters from observed args type + param names.
 */
function buildParametersSchema(
  argsType: TypeNode,
  paramNames?: string[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  if (argsType.kind === "tuple" && argsType.elements) {
    for (let i = 0; i < argsType.elements.length; i++) {
      const paramName = paramNames?.[i] || `arg${i}`;
      const paramType = argsType.elements[i];

      // If the param is an object, flatten it into the schema
      if (paramType.kind === "object" && argsType.elements.length === 1) {
        // Single object parameter — spread its properties
        if (paramType.properties) {
          for (const [key, value] of Object.entries(paramType.properties)) {
            properties[key] = typeNodeToJsonSchema(value);
            required.push(key);
          }
        }
      } else {
        properties[paramName] = typeNodeToJsonSchema(paramType);
        required.push(paramName);
      }
    }
  } else if (argsType.kind === "object" && argsType.properties) {
    for (const [key, value] of Object.entries(argsType.properties)) {
      properties[key] = typeNodeToJsonSchema(value);
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/**
 * Generate a tool description from function name and module.
 */
function generateDescription(funcName: string, moduleName: string): string {
  // Convert camelCase/snake_case to natural language
  const words = funcName
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();
  return `${words} (from ${moduleName} module)`;
}

/**
 * Convert observations to OpenAI tool calling format.
 */
function toOpenAITools(observations: Observation[]): unknown[] {
  return observations.map(obs => ({
    type: "function",
    function: {
      name: obs.functionName,
      description: generateDescription(obs.functionName, obs.module),
      parameters: buildParametersSchema(obs.argsType, obs.paramNames),
    },
  }));
}

/**
 * Convert observations to Anthropic tool use format.
 */
function toAnthropicTools(observations: Observation[]): unknown[] {
  return observations.map(obs => ({
    name: obs.functionName,
    description: generateDescription(obs.functionName, obs.module),
    input_schema: buildParametersSchema(obs.argsType, obs.paramNames),
  }));
}

/**
 * Convert observations to MCP server tool definitions.
 */
function toMCPTools(observations: Observation[]): unknown[] {
  return observations.map(obs => ({
    name: obs.functionName,
    description: generateDescription(obs.functionName, obs.module),
    inputSchema: buildParametersSchema(obs.argsType, obs.paramNames),
  }));
}

export async function toolSchemaCommand(
  functionName: string | undefined,
  opts: ToolSchemaOptions,
): Promise<void> {
  const format = opts.format || "openai";
  const localDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), ".trickle");
  const obsFile = path.join(localDir, "observations.jsonl");

  if (!fs.existsSync(obsFile)) {
    console.error(chalk.red("\n  No observations found. Run your app with trickle first:"));
    console.error(chalk.gray("    trickle run node app.js"));
    console.error(chalk.gray("    trickle run python app.py\n"));
    process.exit(1);
  }

  // Read and deduplicate observations (last type hash wins per function)
  const lines = fs.readFileSync(obsFile, "utf-8").trim().split("\n").filter(Boolean);
  const funcMap = new Map<string, Observation>();

  for (const line of lines) {
    try {
      const obs = JSON.parse(line) as Observation;
      if (!obs.functionName || !obs.argsType) continue;

      // Filter by function name if specified
      if (functionName && obs.functionName !== functionName) continue;

      // Filter by module if specified
      if (opts.module && obs.module !== opts.module) continue;

      // Deduplicate by function name (last observation wins — most complete type)
      const key = `${obs.module}.${obs.functionName}`;
      funcMap.set(key, obs);
    } catch {
      // Skip malformed lines
    }
  }

  const observations = Array.from(funcMap.values());

  if (observations.length === 0) {
    if (functionName) {
      console.error(chalk.yellow(`\n  No observations for function "${functionName}".`));
      console.error(chalk.gray("  Run: trickle functions — to see available functions.\n"));
    } else {
      console.error(chalk.yellow("\n  No function observations found."));
      console.error(chalk.gray("  Run your app with trickle to observe function types.\n"));
    }
    process.exit(1);
  }

  // Generate tools based on format
  let tools: unknown[];
  switch (format) {
    case "anthropic":
      tools = toAnthropicTools(observations);
      break;
    case "mcp":
      tools = toMCPTools(observations);
      break;
    case "openai":
    default:
      tools = toOpenAITools(observations);
      break;
  }

  const output = JSON.stringify(tools, null, 2);

  if (opts.out) {
    fs.writeFileSync(opts.out, output + "\n", "utf-8");
    console.log("");
    console.log(chalk.green(`  Tool schemas written to ${chalk.bold(opts.out)}`));
    console.log(chalk.gray(`  ${tools.length} functions → ${format} format`));
    console.log("");
  } else {
    console.log("");
    console.log(chalk.bold(`  Tool schemas (${format} format)`));
    console.log(chalk.gray(`  ${tools.length} functions from ${new Set(observations.map(o => o.module)).size} modules\n`));
    console.log(output);
    console.log("");
  }
}
