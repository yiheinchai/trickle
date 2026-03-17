import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { fetchOpenApiSpec } from "../api-client";
import { isLocalMode, getLocalOpenApiSpec } from "../local-data";

export interface OpenApiOptions {
  out?: string;
  env?: string;
  title?: string;
  apiVersion?: string;
  server?: string;
  local?: boolean;
}

export async function openapiCommand(opts: OpenApiOptions): Promise<void> {
  try {
    const spec = isLocalMode(opts)
      ? getLocalOpenApiSpec({
          env: opts.env,
          title: opts.title,
          version: opts.apiVersion,
          serverUrl: opts.server,
        })
      : await fetchOpenApiSpec({
          env: opts.env,
          title: opts.title,
          version: opts.apiVersion,
          serverUrl: opts.server,
        });

    const json = JSON.stringify(spec, null, 2) + "\n";

    if (opts.out) {
      const outPath = path.resolve(opts.out);
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(outPath, json, "utf-8");
      console.log("");
      console.log(chalk.green(`  OpenAPI spec written to ${chalk.bold(opts.out)}`));

      // Show summary
      const specObj = spec as Record<string, unknown>;
      const paths = specObj.paths as Record<string, unknown> || {};
      const pathCount = Object.keys(paths).length;
      let operationCount = 0;
      for (const methods of Object.values(paths)) {
        operationCount += Object.keys(methods as Record<string, unknown>).length;
      }
      console.log(chalk.gray(`  ${pathCount} path${pathCount !== 1 ? "s" : ""}, ${operationCount} operation${operationCount !== 1 ? "s" : ""}`));
      console.log("");
    } else {
      process.stdout.write(json);
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
    }
  }
}
