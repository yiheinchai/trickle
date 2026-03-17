import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { fetchCodegen } from "../api-client";
import { isLocalMode } from "../local-data";
import { generateFromJsonl } from "../local-codegen";

export interface CodegenOptions {
  out?: string;
  env?: string;
  python?: boolean;
  client?: boolean;
  handlers?: boolean;
  zod?: boolean;
  reactQuery?: boolean;
  guards?: boolean;
  middleware?: boolean;
  msw?: boolean;
  jsonSchema?: boolean;
  swr?: boolean;
  pydantic?: boolean;
  classValidator?: boolean;
  graphql?: boolean;
  trpc?: boolean;
  axios?: boolean;
  watch?: boolean;
  local?: boolean;
}

export async function codegenCommand(
  functionName: string | undefined,
  opts: CodegenOptions,
): Promise<void> {
  const language = opts.python ? "python" : undefined;
  const format = opts.axios ? "axios" : opts.trpc ? "trpc" : opts.graphql ? "graphql" : opts.classValidator ? "class-validator" : opts.pydantic ? "pydantic" : opts.swr ? "swr" : opts.jsonSchema ? "json-schema" : opts.msw ? "msw" : opts.middleware ? "middleware" : opts.guards ? "guards" : opts.reactQuery ? "react-query" : opts.zod ? "zod" : opts.handlers ? "handlers" : opts.client ? "client" : undefined;

  async function generate(): Promise<string> {
    if (isLocalMode(opts)) {
      const jsonlPath = path.join(process.cwd(), ".trickle", "observations.jsonl");
      const stubs = generateFromJsonl(jsonlPath);
      const sections: string[] = [];
      for (const [_mod, content] of Object.entries(stubs)) {
        sections.push(opts.python ? content.python : content.ts);
      }
      return sections.join("\n") || (opts.python
        ? "# No observations found in .trickle/observations.jsonl\n"
        : "// No observations found in .trickle/observations.jsonl\n");
    }
    const result = await fetchCodegen({
      functionName,
      env: opts.env,
      language,
      format,
    });
    return result.types;
  }

  if (opts.watch) {
    console.log(chalk.gray("\n  Watching for type changes (polling every 5s)...\n"));
    console.log(chalk.gray("  Press Ctrl+C to stop.\n"));

    let lastOutput = "";

    const poll = async () => {
      try {
        const types = await generate();
        if (types !== lastOutput) {
          lastOutput = types;
          if (opts.out) {
            writeToFile(opts.out, types, opts.python);
            console.log(
              chalk.green(`  Updated ${chalk.bold(opts.out)}`) +
                chalk.gray(` at ${new Date().toLocaleTimeString()}`),
            );
          } else {
            console.clear();
            console.log(types);
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.error(chalk.red(`  Error: ${err.message}`));
        }
      }
    };

    await poll();
    const interval = setInterval(poll, 5000);

    // Keep process alive until Ctrl+C
    process.on("SIGINT", () => {
      clearInterval(interval);
      console.log(chalk.gray("\n  Stopped watching.\n"));
      process.exit(0);
    });

    // Prevent the process from exiting
    await new Promise(() => {});
    return;
  }

  // One-shot generation
  try {
    const types = await generate();

    if (opts.out) {
      writeToFile(opts.out, types, opts.python);
      const ext = opts.python ? ".pyi" : ".d.ts";
      console.log("");
      console.log(
        chalk.green(`  Types written to ${chalk.bold(opts.out)}`),
      );
      console.log(
        chalk.gray(`  ${countInterfaces(types)} type definitions generated.`),
      );
      console.log("");
    } else {
      console.log("");
      console.log(types);
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
    }
    process.exit(1);
  }
}

function writeToFile(filePath: string, content: string, _python?: boolean): void {
  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolvedPath, content, "utf-8");
}

function countInterfaces(types: string): number {
  const tsMatches = types.match(/export (interface|type) /g);
  const pyMatches = types.match(/class \w+\(TypedDict\)/g);
  return (tsMatches?.length ?? 0) + (pyMatches?.length ?? 0);
}
