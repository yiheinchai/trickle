import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { fetchCodegen } from "../api-client";

export interface AutoOptions {
  dir?: string;
  env?: string;
}

interface DetectedFormat {
  format: string;
  fileName: string;
  label: string;
  reason: string;
}

/**
 * Detect which codegen formats are relevant based on package.json dependencies.
 */
function detectFormats(projectDir: string): DetectedFormat[] {
  const pkgPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return [];
  }

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch {
    return [];
  }

  const deps: Record<string, string> = {
    ...(pkg.dependencies as Record<string, string> || {}),
    ...(pkg.devDependencies as Record<string, string> || {}),
  };

  const formats: DetectedFormat[] = [];

  // Always generate base TypeScript types
  formats.push({
    format: "",
    fileName: "types.d.ts",
    label: "TypeScript types",
    reason: "always generated",
  });

  // Axios client
  if (deps["axios"]) {
    formats.push({
      format: "axios",
      fileName: "axios-client.ts",
      label: "Axios client",
      reason: "axios detected",
    });
  }

  // Fetch-based client (always useful as a fallback if no axios)
  if (!deps["axios"]) {
    formats.push({
      format: "client",
      fileName: "api-client.ts",
      label: "Fetch API client",
      reason: "default HTTP client",
    });
  }

  // React Query / TanStack Query
  if (deps["@tanstack/react-query"] || deps["react-query"]) {
    formats.push({
      format: "react-query",
      fileName: "hooks.ts",
      label: "React Query hooks",
      reason: deps["@tanstack/react-query"] ? "@tanstack/react-query" : "react-query",
    });
  }

  // SWR
  if (deps["swr"]) {
    formats.push({
      format: "swr",
      fileName: "swr-hooks.ts",
      label: "SWR hooks",
      reason: "swr detected",
    });
  }

  // Zod
  if (deps["zod"]) {
    formats.push({
      format: "zod",
      fileName: "schemas.ts",
      label: "Zod schemas",
      reason: "zod detected",
    });
  }

  // tRPC
  if (deps["@trpc/server"] || deps["@trpc/client"]) {
    formats.push({
      format: "trpc",
      fileName: "trpc-router.ts",
      label: "tRPC router",
      reason: deps["@trpc/server"] ? "@trpc/server" : "@trpc/client",
    });
  }

  // class-validator / NestJS
  if (deps["class-validator"] || deps["@nestjs/common"]) {
    formats.push({
      format: "class-validator",
      fileName: "dtos.ts",
      label: "class-validator DTOs",
      reason: deps["class-validator"] ? "class-validator" : "@nestjs/common",
    });
  }

  // Express handler types
  if (deps["express"] || deps["@types/express"]) {
    formats.push({
      format: "handlers",
      fileName: "handlers.d.ts",
      label: "Express handler types",
      reason: deps["express"] ? "express" : "@types/express",
    });
    formats.push({
      format: "middleware",
      fileName: "middleware.ts",
      label: "Express middleware",
      reason: deps["express"] ? "express" : "@types/express",
    });
  }

  // MSW
  if (deps["msw"]) {
    formats.push({
      format: "msw",
      fileName: "msw-handlers.ts",
      label: "MSW mock handlers",
      reason: "msw detected",
    });
  }

  // Pydantic (Python projects)
  if (fs.existsSync(path.join(projectDir, "requirements.txt")) ||
      fs.existsSync(path.join(projectDir, "pyproject.toml"))) {
    // Check if pydantic is in requirements
    let hasPydantic = false;
    try {
      const reqPath = path.join(projectDir, "requirements.txt");
      if (fs.existsSync(reqPath)) {
        const reqs = fs.readFileSync(reqPath, "utf-8");
        if (reqs.toLowerCase().includes("pydantic")) hasPydantic = true;
      }
      const pyprojectPath = path.join(projectDir, "pyproject.toml");
      if (fs.existsSync(pyprojectPath)) {
        const pyproject = fs.readFileSync(pyprojectPath, "utf-8");
        if (pyproject.toLowerCase().includes("pydantic")) hasPydantic = true;
      }
    } catch {}
    if (hasPydantic) {
      formats.push({
        format: "pydantic",
        fileName: "models.py",
        label: "Pydantic models",
        reason: "pydantic detected",
      });
    }
  }

  // Type guards (always useful)
  formats.push({
    format: "guards",
    fileName: "guards.ts",
    label: "Type guards",
    reason: "runtime type checking",
  });

  return formats;
}

/**
 * `trickle auto` — Auto-detect project deps and generate only relevant type files.
 */
export async function autoCommand(opts: AutoOptions): Promise<void> {
  const projectDir = process.cwd();
  const outDir = path.resolve(opts.dir || ".trickle");

  // Detect formats
  const formats = detectFormats(projectDir);

  if (formats.length === 0) {
    console.error(chalk.red("\n  No package.json found in current directory."));
    console.error(chalk.gray("  Run this command from your project root.\n"));
    process.exit(1);
  }

  // Ensure output directory
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log("");
  console.log(chalk.bold("  trickle auto"));
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log(chalk.gray(`  Project: ${projectDir}`));
  console.log(chalk.gray(`  Output:  ${outDir}`));
  if (opts.env) {
    console.log(chalk.gray(`  Env:     ${opts.env}`));
  }
  console.log(chalk.gray("  " + "─".repeat(50)));
  console.log("");

  // Show detected formats
  console.log(chalk.gray("  Detected dependencies:"));
  for (const f of formats) {
    console.log(chalk.gray(`    ${chalk.white(f.label)} ← ${f.reason}`));
  }
  console.log("");

  // Generate each format
  const queryOpts = { env: opts.env };
  let generated = 0;
  let skipped = 0;

  for (const f of formats) {
    const filePath = path.join(outDir, f.fileName);
    try {
      const result = await fetchCodegen({
        ...queryOpts,
        format: f.format || undefined,
      });

      const content = result.types;
      if (!content || content.includes("No functions found") || content.includes("No API routes found")) {
        console.log(chalk.yellow("  ─ ") + chalk.gray(`${f.fileName} (no data)`));
        skipped++;
        continue;
      }

      fs.writeFileSync(filePath, content, "utf-8");
      generated++;

      const size = content.split("\n").length;
      console.log(
        chalk.green("  ✓ ") +
        chalk.bold(f.fileName) +
        chalk.gray(` (${size} lines)`),
      );
    } catch {
      console.log(chalk.yellow("  ─ ") + chalk.gray(`${f.fileName} (error)`));
      skipped++;
    }
  }

  console.log("");
  if (generated > 0) {
    console.log(
      chalk.green(`  ${generated} files generated`) +
      (skipped > 0 ? chalk.gray(`, ${skipped} skipped`) : ""),
    );
    console.log(chalk.gray(`  Output directory: ${outDir}`));
  } else {
    console.log(chalk.yellow("  No files generated — instrument your app and make some requests first."));
  }
  console.log("");
}
