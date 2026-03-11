import chalk from "chalk";
import { getBackendUrl } from "../config";

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
}

export async function auditCommand(opts: AuditOptions): Promise<void> {
  const base = getBackendUrl();
  const url = new URL("/api/audit", base);
  if (opts.env) url.searchParams.set("env", opts.env);

  let data: AuditResponse;
  try {
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = (await res.json()) as AuditResponse;
  } catch {
    console.error(chalk.red(`\n  Cannot connect to trickle backend at ${chalk.bold(base)}.`));
    console.error(chalk.red("  Is the backend running?\n"));
    process.exit(1);
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
