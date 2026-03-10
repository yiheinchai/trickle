import chalk from "chalk";

// TypeNode shape matching the backend
interface TypeNode {
  kind: string;
  name?: string;
  element?: TypeNode;
  properties?: Record<string, TypeNode>;
  members?: TypeNode[];
  params?: TypeNode[];
  returnType?: TypeNode;
  resolved?: TypeNode;
  key?: TypeNode;
  value?: TypeNode;
  elements?: TypeNode[];
}

const INDENT_SIZE = 2;

function primitiveColor(name: string): string {
  switch (name) {
    case "string":
      return chalk.green(name);
    case "number":
    case "bigint":
      return chalk.yellow(name);
    case "boolean":
      return chalk.blue(name);
    case "null":
    case "undefined":
      return chalk.gray(name);
    case "symbol":
      return chalk.magenta(name);
    default:
      return chalk.white(name);
  }
}

/**
 * Format a TypeNode as colorized pseudo-TypeScript.
 */
export function formatType(node: TypeNode | unknown, indent: number = 0): string {
  if (!node || typeof node !== "object") {
    return chalk.gray("unknown");
  }

  const n = node as TypeNode;
  const pad = " ".repeat(indent);
  const innerPad = " ".repeat(indent + INDENT_SIZE);

  switch (n.kind) {
    case "primitive":
      return primitiveColor(n.name || "unknown");

    case "array":
      if (n.element) {
        const inner = formatType(n.element, indent);
        // Wrap complex types in parens for array notation
        if (n.element.kind === "union") {
          return `(${inner})[]`;
        }
        return `${inner}[]`;
      }
      return chalk.gray("unknown[]");

    case "object": {
      if (!n.properties) return chalk.gray("{}");
      const keys = Object.keys(n.properties);
      if (keys.length === 0) return chalk.gray("{}");

      // Inline for small objects (2 or fewer properties)
      if (keys.length <= 2) {
        const props = keys.map(
          (key) => `${chalk.white(key)}: ${formatType(n.properties![key], 0)}`
        );
        return `{ ${props.join(", ")} }`;
      }

      // Multi-line for larger objects
      const lines = keys.map(
        (key) =>
          `${innerPad}${chalk.white(key)}: ${formatType(n.properties![key], indent + INDENT_SIZE)}`
      );
      return `{\n${lines.join(",\n")}\n${pad}}`;
    }

    case "union": {
      if (!n.members || n.members.length === 0) return chalk.gray("never");
      return n.members.map((m) => formatType(m, indent)).join(chalk.gray(" | "));
    }

    case "function": {
      const params = (n.params || [])
        .map((p, i) => `${chalk.white(`arg${i}`)}: ${formatType(p, indent)}`)
        .join(", ");
      const ret = n.returnType ? formatType(n.returnType, indent) : chalk.gray("void");
      return `(${params}) => ${ret}`;
    }

    case "promise": {
      const resolved = n.resolved ? formatType(n.resolved, indent) : chalk.gray("unknown");
      return `${chalk.cyan("Promise")}<${resolved}>`;
    }

    case "map": {
      const key = n.key ? formatType(n.key, indent) : chalk.gray("unknown");
      const value = n.value ? formatType(n.value, indent) : chalk.gray("unknown");
      return `${chalk.cyan("Map")}<${key}, ${value}>`;
    }

    case "set": {
      const element = n.element ? formatType(n.element, indent) : chalk.gray("unknown");
      return `${chalk.cyan("Set")}<${element}>`;
    }

    case "tuple": {
      if (!n.elements || n.elements.length === 0) return "[]";
      const elems = n.elements.map((e) => formatType(e, indent)).join(", ");
      return `[${elems}]`;
    }

    case "unknown":
      return chalk.gray("unknown");

    default:
      return chalk.gray("unknown");
  }
}

/**
 * Format a type node as a compact single-line string (no colors).
 */
export function formatTypePlain(node: TypeNode | unknown): string {
  if (!node || typeof node !== "object") return "unknown";

  const n = node as TypeNode;

  switch (n.kind) {
    case "primitive":
      return n.name || "unknown";
    case "array":
      return n.element ? `${formatTypePlain(n.element)}[]` : "unknown[]";
    case "object": {
      if (!n.properties) return "{}";
      const keys = Object.keys(n.properties);
      if (keys.length === 0) return "{}";
      const props = keys.map((k) => `${k}: ${formatTypePlain(n.properties![k])}`);
      return `{ ${props.join(", ")} }`;
    }
    case "union":
      return (n.members || []).map(formatTypePlain).join(" | ");
    case "function": {
      const params = (n.params || []).map((p, i) => `arg${i}: ${formatTypePlain(p)}`).join(", ");
      return `(${params}) => ${n.returnType ? formatTypePlain(n.returnType) : "void"}`;
    }
    case "promise":
      return `Promise<${n.resolved ? formatTypePlain(n.resolved) : "unknown"}>`;
    default:
      return "unknown";
  }
}
