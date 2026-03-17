import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { fetchCodegen, fetchOpenApiSpec, fetchMockConfig } from "../api-client";
import { testGenCommand } from "./test-gen";

export interface ExportOptions {
  dir?: string;
  env?: string;
}

interface ExportResult {
  file: string;
  label: string;
  ok: boolean;
  count?: string;
}

/**
 * `trickle export` — Generate all output formats into a directory at once.
 *
 * Creates a complete `.trickle/` directory with:
 * - types.d.ts — TypeScript type declarations
 * - api-client.ts — Typed fetch-based API client
 * - handlers.d.ts — Express handler type aliases
 * - schemas.ts — Zod validation schemas
 * - hooks.ts — TanStack React Query hooks
 * - guards.ts — Runtime type guard functions
 * - openapi.json — OpenAPI 3.0 specification
 * - api.test.ts — Generated API test scaffolds
 */
export async function exportCommand(opts: ExportOptions): Promise<void> {
  const outDir = path.resolve(opts.dir || ".trickle");

  // Ensure directory exists
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log("");
  console.log(chalk.bold("  trickle export"));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log(chalk.gray(`  Output directory: ${outDir}`));
  if (opts.env) {
    console.log(chalk.gray(`  Environment: ${opts.env}`));
  }
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log("");

  const results: ExportResult[] = [];
  const queryOpts = { env: opts.env };

  // 1. TypeScript types
  results.push(await generateFile(
    path.join(outDir, "types.d.ts"),
    "TypeScript types",
    () => fetchCodegen({ ...queryOpts }).then((r) => r.types),
    countInterfaces,
  ));

  // 2. API client
  results.push(await generateFile(
    path.join(outDir, "api-client.ts"),
    "Typed API client",
    () => fetchCodegen({ ...queryOpts, format: "client" }).then((r) => r.types),
    countFunctions,
  ));

  // 3. Express handler types
  results.push(await generateFile(
    path.join(outDir, "handlers.d.ts"),
    "Express handler types",
    () => fetchCodegen({ ...queryOpts, format: "handlers" }).then((r) => r.types),
    countHandlers,
  ));

  // 4. Zod schemas
  results.push(await generateFile(
    path.join(outDir, "schemas.ts"),
    "Zod schemas",
    () => fetchCodegen({ ...queryOpts, format: "zod" }).then((r) => r.types),
    countSchemas,
  ));

  // 5. React Query hooks
  results.push(await generateFile(
    path.join(outDir, "hooks.ts"),
    "React Query hooks",
    () => fetchCodegen({ ...queryOpts, format: "react-query" }).then((r) => r.types),
    countHooks,
  ));

  // 6. Type guards
  results.push(await generateFile(
    path.join(outDir, "guards.ts"),
    "Type guards",
    () => fetchCodegen({ ...queryOpts, format: "guards" }).then((r) => r.types),
    countGuards,
  ));

  // OpenAPI spec
  results.push(await generateFile(
    path.join(outDir, "openapi.json"),
    "OpenAPI 3.0 spec",
    async () => {
      const spec = await fetchOpenApiSpec({ env: opts.env });
      return JSON.stringify(spec, null, 2);
    },
    countPaths,
  ));

  // API tests
  results.push(await generateFile(
    path.join(outDir, "api.test.ts"),
    "API test scaffolds",
    async () => {
      const { routes } = await fetchMockConfig();
      if (routes.length === 0) return null;
      // Use the testGenCommand's internal logic by fetching via codegen format?
      // Actually, let's generate a simple version directly
      return generateTestContent(routes);
    },
    countTests,
  ));

  // Summary
  console.log("");
  const successCount = results.filter((r) => r.ok).length;
  const skipCount = results.filter((r) => !r.ok).length;

  for (const r of results) {
    if (r.ok) {
      const countStr = r.count ? chalk.gray(` (${r.count})`) : "";
      console.log(chalk.green("  ✓ ") + chalk.bold(r.file) + countStr);
    } else {
      console.log(chalk.yellow("  ─ ") + chalk.gray(r.file) + chalk.gray(" (skipped — no data)"));
    }
  }

  console.log("");
  if (successCount > 0) {
    console.log(chalk.green(`  ${successCount} files generated`) + (skipCount > 0 ? chalk.gray(`, ${skipCount} skipped`) : ""));
  } else {
    console.log(chalk.yellow("  No files generated — instrument your app and make some requests first."));
  }
  console.log("");
}

async function generateFile(
  filePath: string,
  label: string,
  generator: () => Promise<string | null>,
  counter: (content: string) => string | undefined,
): Promise<ExportResult> {
  const fileName = path.basename(filePath);
  try {
    const content = await generator();
    if (!content || content.includes("No functions found") || content.includes("No API routes found") || content.includes("No observations")) {
      return { file: fileName, label, ok: false };
    }

    fs.writeFileSync(filePath, content, "utf-8");
    const count = counter(content);
    return { file: fileName, label, ok: true, count };
  } catch {
    return { file: fileName, label, ok: false };
  }
}

function countInterfaces(content: string): string | undefined {
  const count = (content.match(/export (interface|type) /g) || []).length;
  return count > 0 ? `${count} types` : undefined;
}

function countFunctions(content: string): string | undefined {
  if (content.includes("createTrickleClient")) return "client factory";
  return undefined;
}

function countHandlers(content: string): string | undefined {
  const count = (content.match(/export type \w+Handler/g) || []).length;
  return count > 0 ? `${count} handlers` : undefined;
}

function countSchemas(content: string): string | undefined {
  const count = (content.match(/Schema = /g) || []).length;
  return count > 0 ? `${count} schemas` : undefined;
}

function countHooks(content: string): string | undefined {
  const count = (content.match(/export function use\w+/g) || []).length;
  return count > 0 ? `${count} hooks` : undefined;
}

function countPaths(content: string): string | undefined {
  try {
    const spec = JSON.parse(content);
    const paths = Object.keys(spec.paths || {}).length;
    return paths > 0 ? `${paths} paths` : undefined;
  } catch {
    return undefined;
  }
}

function countTests(content: string): string | undefined {
  const count = (content.match(/it\("/g) || []).length;
  return count > 0 ? `${count} tests` : undefined;
}

function countGuards(content: string): string | undefined {
  const count = (content.match(/export function is\w+/g) || []).length;
  return count > 0 ? `${count} guards` : undefined;
}

// Simplified test generation (reuses the same logic as test-gen but inline)
interface MockRoute {
  method: string;
  path: string;
  functionName: string;
  sampleInput: unknown;
  sampleOutput: unknown;
}

function generateTestContent(routes: MockRoute[]): string {
  const lines: string[] = [];
  lines.push("// Auto-generated API tests by trickle");
  lines.push(`// Generated at ${new Date().toISOString()}`);
  lines.push("// Do not edit manually — re-run `trickle export` to update");
  lines.push("");
  lines.push('import { describe, it, expect } from "vitest";');
  lines.push("");
  lines.push('const BASE_URL = process.env.TEST_API_URL || "http://localhost:3000";');
  lines.push("");

  // Group by resource
  const groups: Record<string, MockRoute[]> = {};
  for (const r of routes) {
    const parts = r.path.split("/").filter(Boolean);
    const resource = parts[0] === "api" && parts.length >= 2 ? `/api/${parts[1]}` : `/${parts[0] || "root"}`;
    if (!groups[resource]) groups[resource] = [];
    groups[resource].push(r);
  }

  for (const [resource, resourceRoutes] of Object.entries(groups)) {
    lines.push(`describe("${resource}", () => {`);
    for (const route of resourceRoutes) {
      const hasBody = ["POST", "PUT", "PATCH"].includes(route.method);
      const fetchPath = route.path.replace(/:(\w+)/g, "test-$1");

      lines.push(`  it("${route.method} ${route.path} — returns expected shape", async () => {`);
      lines.push(`    const res = await fetch(\`\${BASE_URL}${fetchPath}\`, {`);
      lines.push(`      method: "${route.method}",`);
      if (hasBody && route.sampleInput) {
        const body = typeof route.sampleInput === "object" && route.sampleInput !== null
          ? (route.sampleInput as Record<string, unknown>).body || route.sampleInput
          : route.sampleInput;
        if (body && typeof body === "object" && Object.keys(body as object).length > 0) {
          lines.push(`      headers: { "Content-Type": "application/json" },`);
          lines.push(`      body: JSON.stringify(${JSON.stringify(body)}),`);
        }
      }
      lines.push("    });");
      lines.push("    expect(res.ok).toBe(true);");

      if (route.sampleOutput && typeof route.sampleOutput === "object") {
        lines.push("    const body = await res.json();");
        for (const [key, value] of Object.entries(route.sampleOutput as Record<string, unknown>)) {
          if (Array.isArray(value)) {
            lines.push(`    expect(Array.isArray(body.${key})).toBe(true);`);
          } else if (typeof value === "string") {
            lines.push(`    expect(typeof body.${key}).toBe("string");`);
          } else if (typeof value === "number") {
            lines.push(`    expect(typeof body.${key}).toBe("number");`);
          } else if (typeof value === "boolean") {
            lines.push(`    expect(typeof body.${key}).toBe("boolean");`);
          }
        }
      }
      lines.push("  });");
      lines.push("");
    }
    lines.push("});");
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
