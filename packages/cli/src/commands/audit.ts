import chalk from "chalk";
import { getBackendUrl } from "../config";
import { isLocalMode, getLocalFunctions } from "../local-data";
import { readObservations } from "../local-codegen";

interface AuditIssue {
  severity: "error" | "warning" | "info";
  rule: string;
  message: string;
  route?: string;
  field?: string;
}

interface AuditResponse {
  summary: {
    total: number;
    errors: number;
    warnings: number;
    info: number;
    routesAnalyzed: number;
  };
  issues: AuditIssue[];
}

export interface AuditOptions {
  env?: string;
  json?: boolean;
  failOnError?: boolean;
  failOnWarning?: boolean;
  local?: boolean;
}

export async function auditCommand(opts: AuditOptions): Promise<void> {
  let data: AuditResponse;

  if (isLocalMode(opts)) {
    // Run audit locally from observations
    const path = require("path");
    const jsonlPath = path.join(process.cwd(), ".trickle", "observations.jsonl");
    const observations = readObservations(jsonlPath);
    const issues: AuditIssue[] = [];

    // Check for sensitive field names in responses
    const sensitivePatterns = /^(password|secret|token|api_key|apiKey|authorization|ssn|credit_card|creditCard)$/i;
    let routesAnalyzed = 0;

    for (const fn of observations) {
      const isRoute = /^(GET|POST|PUT|DELETE|PATCH)\s/.test(fn.name);
      if (isRoute) routesAnalyzed++;

      // Check return type for sensitive fields
      if (fn.returnType?.kind === "object" && fn.returnType.properties) {
        for (const key of Object.keys(fn.returnType.properties)) {
          if (sensitivePatterns.test(key)) {
            issues.push({
              severity: "error",
              rule: "sensitive-field-in-response",
              message: `Sensitive field "${key}" exposed in response`,
              route: fn.name,
              field: key,
            });
          }
        }
      }
    }

    data = {
      summary: {
        total: issues.length,
        errors: issues.filter(i => i.severity === "error").length,
        warnings: issues.filter(i => i.severity === "warning").length,
        info: issues.filter(i => i.severity === "info").length,
        routesAnalyzed,
      },
      issues,
    };
  } else {
    const base = getBackendUrl();
    const url = new URL("/api/audit", base);
    if (opts.env) url.searchParams.set("env", opts.env);

    try {
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = (await res.json()) as AuditResponse;
    } catch {
      console.error(chalk.red(`\n  Cannot connect to trickle backend at ${chalk.bold(base)}.`));
      console.error(chalk.red("  Is the backend running?\n"));
      process.exit(1);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    if (opts.failOnError && data.summary.errors > 0) process.exit(1);
    if (opts.failOnWarning && (data.summary.errors + data.summary.warnings) > 0) process.exit(1);
    return;
  }

  console.log("");
  console.log(chalk.bold("  API Audit Report"));
  console.log(chalk.gray(`  ${data.summary.routesAnalyzed} routes analyzed\n`));

  if (data.issues.length === 0) {
    console.log(chalk.green("  ✓ No issues found — your API looks clean!\n"));
    return;
  }

  // Group by severity
  const errors = data.issues.filter((i) => i.severity === "error");
  const warnings = data.issues.filter((i) => i.severity === "warning");
  const infos = data.issues.filter((i) => i.severity === "info");

  if (errors.length > 0) {
    console.log(chalk.red.bold(`  ✗ ${errors.length} error${errors.length > 1 ? "s" : ""}`));
    for (const issue of errors) {
      const route = issue.route ? chalk.gray(` [${issue.route}]`) : "";
      console.log(chalk.red(`    • ${issue.message}${route}`));
    }
    console.log("");
  }

  if (warnings.length > 0) {
    console.log(chalk.yellow.bold(`  ⚠ ${warnings.length} warning${warnings.length > 1 ? "s" : ""}`));
    for (const issue of warnings) {
      const route = issue.route ? chalk.gray(` [${issue.route}]`) : "";
      console.log(chalk.yellow(`    • ${issue.message}${route}`));
    }
    console.log("");
  }

  if (infos.length > 0) {
    console.log(chalk.blue.bold(`  ℹ ${infos.length} info`));
    for (const issue of infos) {
      const route = issue.route ? chalk.gray(` [${issue.route}]`) : "";
      console.log(chalk.blue(`    • ${issue.message}${route}`));
    }
    console.log("");
  }

  // Summary line
  const parts: string[] = [];
  if (errors.length > 0) parts.push(chalk.red(`${errors.length} errors`));
  if (warnings.length > 0) parts.push(chalk.yellow(`${warnings.length} warnings`));
  if (infos.length > 0) parts.push(chalk.blue(`${infos.length} info`));
  console.log(chalk.gray(`  Total: ${parts.join(", ")}\n`));

  if (opts.failOnError && data.summary.errors > 0) process.exit(1);
  if (opts.failOnWarning && (data.summary.errors + data.summary.warnings) > 0) process.exit(1);
}
