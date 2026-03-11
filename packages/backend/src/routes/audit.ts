import { Router, Request, Response } from "express";
import { db } from "../db/connection";
import { listFunctions, getLatestSnapshot } from "../db/queries";
import { TypeNode } from "../types";

const router = Router();

interface AuditIssue {
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
  route?: string;
  field?: string;
}

const SENSITIVE_FIELD_NAMES = new Set([
  "password", "passwd", "pass", "secret", "token", "apikey", "api_key",
  "apiKey", "accesstoken", "access_token", "accessToken", "refreshtoken",
  "refresh_token", "refreshToken", "privatekey", "private_key", "privateKey",
  "ssn", "creditcard", "credit_card", "creditCard", "cvv", "pin",
]);

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Count properties in a TypeNode recursively */
function countProperties(node: TypeNode): number {
  if (node.kind === "object") {
    return Object.keys(node.properties).length;
  }
  return 0;
}

/** Get max nesting depth of a TypeNode */
function maxDepth(node: TypeNode, current: number = 0): number {
  switch (node.kind) {
    case "object": {
      if (Object.keys(node.properties).length === 0) return current;
      let max = current;
      for (const val of Object.values(node.properties)) {
        max = Math.max(max, maxDepth(val, current + 1));
      }
      return max;
    }
    case "array":
      return maxDepth(node.element, current + 1);
    case "union":
      return Math.max(...node.members.map((m) => maxDepth(m, current)), current);
    case "tuple":
      return Math.max(...node.elements.map((e) => maxDepth(e, current + 1)), current);
    case "map":
      return maxDepth(node.value, current + 1);
    case "set":
      return maxDepth(node.element, current + 1);
    case "promise":
      return maxDepth(node.resolved, current);
    default:
      return current;
  }
}

/** Check if an object mixes camelCase and snake_case */
function detectNamingInconsistency(node: TypeNode, path: string): string | null {
  if (node.kind !== "object") return null;
  const keys = Object.keys(node.properties);
  if (keys.length < 2) return null;

  let hasCamel = false;
  let hasSnake = false;
  for (const key of keys) {
    if (key.includes("_") && key !== key.toUpperCase()) hasSnake = true;
    if (/[a-z][A-Z]/.test(key)) hasCamel = true;
  }
  if (hasCamel && hasSnake) {
    const camelKeys = keys.filter((k) => /[a-z][A-Z]/.test(k));
    const snakeKeys = keys.filter((k) => k.includes("_") && k !== k.toUpperCase());
    return `Mixed naming: camelCase (${camelKeys.slice(0, 3).join(", ")}) and snake_case (${snakeKeys.slice(0, 3).join(", ")})`;
  }
  return null;
}

/** Find sensitive fields in a TypeNode recursively */
function findSensitiveFields(node: TypeNode, path: string, results: string[]): void {
  if (node.kind === "object") {
    for (const [key, val] of Object.entries(node.properties)) {
      const fullPath = path ? `${path}.${key}` : key;
      if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
        results.push(fullPath);
      }
      findSensitiveFields(val, fullPath, results);
    }
  } else if (node.kind === "array") {
    findSensitiveFields(node.element, `${path}[]`, results);
  } else if (node.kind === "union") {
    for (const m of node.members) {
      findSensitiveFields(m, path, results);
    }
  }
}

/** Collect all field names with their types across routes */
function collectFieldTypes(
  node: TypeNode,
  prefix: string,
  result: Map<string, Set<string>>,
): void {
  if (node.kind === "object") {
    for (const [key, val] of Object.entries(node.properties)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (!result.has(key)) result.set(key, new Set());
      if (val.kind === "primitive") {
        result.get(key)!.add(val.name);
      } else {
        result.get(key)!.add(val.kind);
      }
      collectFieldTypes(val, fullKey, result);
    }
  } else if (node.kind === "array") {
    collectFieldTypes(node.element, `${prefix}[]`, result);
  }
}

router.get("/", (req: Request, res: Response) => {
  try {
    const { env } = req.query;
    const issues: AuditIssue[] = [];

    // Collect all functions with their types
    const listed = listFunctions(db, {
      env: env as string | undefined,
      limit: 500,
    });

    const functions: Array<{
      name: string;
      argsType: TypeNode;
      returnType: TypeNode;
    }> = [];

    for (const fn of listed.rows) {
      const functionId = fn.id as number;
      const functionName = fn.function_name as string;

      const snapshot = getLatestSnapshot(db, functionId, env as string | undefined);
      if (!snapshot) {
        // Untyped function
        issues.push({
          severity: "warning",
          rule: "no-types",
          message: `No type observations recorded`,
          route: functionName,
        });
        continue;
      }

      const argsType = tryParseJson(snapshot.args_type as string) as TypeNode;
      const returnType = tryParseJson(snapshot.return_type as string) as TypeNode;
      if (!argsType || !returnType) continue;

      functions.push({ name: functionName, argsType, returnType });
    }

    // Analyze each function
    const globalFieldTypes = new Map<string, Set<string>>();

    for (const fn of functions) {
      const routeName = fn.name;

      // 1. Sensitive data in responses
      const sensitiveFields: string[] = [];
      findSensitiveFields(fn.returnType, "", sensitiveFields);
      for (const field of sensitiveFields) {
        issues.push({
          severity: "error",
          rule: "sensitive-data",
          message: `Response exposes potentially sensitive field "${field}"`,
          route: routeName,
          field,
        });
      }

      // 2. Oversized responses (>15 top-level properties)
      const propCount = countProperties(fn.returnType);
      if (propCount > 15) {
        issues.push({
          severity: "warning",
          rule: "oversized-response",
          message: `Response has ${propCount} top-level fields — consider pagination or field selection`,
          route: routeName,
        });
      }

      // 3. Deeply nested types (>4 levels)
      const depth = maxDepth(fn.returnType);
      if (depth > 4) {
        issues.push({
          severity: "warning",
          rule: "deep-nesting",
          message: `Response is nested ${depth} levels deep — consider flattening`,
          route: routeName,
        });
      }

      // 4. Naming inconsistency
      const namingIssue = detectNamingInconsistency(fn.returnType, "");
      if (namingIssue) {
        issues.push({
          severity: "warning",
          rule: "inconsistent-naming",
          message: namingIssue,
          route: routeName,
        });
      }

      // Also check args for naming issues
      const argsNaming = detectNamingInconsistency(fn.argsType, "");
      if (argsNaming) {
        issues.push({
          severity: "warning",
          rule: "inconsistent-naming",
          message: `Request: ${argsNaming}`,
          route: routeName,
        });
      }

      // 5. Empty response type
      if (fn.returnType.kind === "unknown" ||
          (fn.returnType.kind === "object" && Object.keys(fn.returnType.properties).length === 0)) {
        issues.push({
          severity: "info",
          rule: "empty-response",
          message: `Response type is empty or unknown — may need more observations`,
          route: routeName,
        });
      }

      // Collect field types for cross-route consistency check
      collectFieldTypes(fn.returnType, "", globalFieldTypes);
    }

    // 6. Cross-route type inconsistency (same field name, different types)
    for (const [fieldName, types] of globalFieldTypes) {
      if (types.size > 1 && !["kind", "type", "data", "value", "result", "status"].includes(fieldName)) {
        const typeList = Array.from(types).sort().join(", ");
        issues.push({
          severity: "warning",
          rule: "type-inconsistency",
          message: `Field "${fieldName}" has different types across routes: ${typeList}`,
        });
      }
    }

    // Sort: errors first, then warnings, then info
    const severityOrder = { error: 0, warning: 1, info: 2 };
    issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    // Summary
    const errorCount = issues.filter((i) => i.severity === "error").length;
    const warningCount = issues.filter((i) => i.severity === "warning").length;
    const infoCount = issues.filter((i) => i.severity === "info").length;

    res.json({
      summary: {
        total: issues.length,
        errors: errorCount,
        warnings: warningCount,
        info: infoCount,
        routesAnalyzed: functions.length,
      },
      issues,
    });
  } catch (err) {
    console.error("Audit error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
