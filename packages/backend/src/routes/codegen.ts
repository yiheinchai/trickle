import { Router, Request, Response } from "express";
import { db } from "../db/connection";
import { listFunctions, getFunctionByName, getLatestSnapshot } from "../db/queries";
import { generateAllTypes, generatePythonTypes, generateApiClient, generateOpenApiSpec, generateHandlerTypes, generateZodSchemas, generateReactQueryHooks, generateTypeGuards, generateMiddleware, generateMswHandlers, generateJsonSchemas, generateSwrHooks, generatePydanticModels, generateClassValidatorDtos, generateGraphqlSchema, generateTrpcRouter, generateAxiosClient, generateInlineAnnotations } from "../services/type-generator";
import { TypeNode } from "../types";

const router = Router();

interface FunctionTypeData {
  name: string;
  argsType: TypeNode;
  returnType: TypeNode;
  module?: string;
  env?: string;
  observedAt?: string;
  sampleInput?: unknown;
  sampleOutput?: unknown;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Collect type data for all matching functions.
 */
function collectFunctionTypes(opts: {
  functionName?: string;
  env?: string;
}): FunctionTypeData[] {
  const results: FunctionTypeData[] = [];

  let functionRows: Record<string, unknown>[];

  if (opts.functionName) {
    functionRows = getFunctionByName(db, opts.functionName);
  } else {
    const listed = listFunctions(db, {
      env: opts.env,
      limit: 500,
    });
    functionRows = listed.rows;
  }

  for (const fn of functionRows) {
    const functionId = fn.id as number;
    const functionName = fn.function_name as string;
    const moduleName = fn.module as string;
    const environment = (fn.environment as string) || undefined;

    const snapshot = getLatestSnapshot(db, functionId, opts.env);
    if (!snapshot) continue;

    const argsType = tryParseJson(snapshot.args_type as string) as TypeNode;
    const returnType = tryParseJson(snapshot.return_type as string) as TypeNode;

    if (!argsType || !returnType) continue;

    results.push({
      name: functionName,
      argsType,
      returnType,
      module: moduleName,
      env: (snapshot.env as string) || environment,
      observedAt: snapshot.observed_at as string,
      sampleInput: snapshot.sample_input ? tryParseJson(snapshot.sample_input as string) : undefined,
      sampleOutput: snapshot.sample_output ? tryParseJson(snapshot.sample_output as string) : undefined,
    });
  }

  // Deduplicate by function name — when the same endpoint is observed
  // across different modules/languages/sessions, keep only the most
  // recently observed entry to avoid duplicate declarations in codegen.
  const deduped = new Map<string, FunctionTypeData>();
  for (const entry of results) {
    const existing = deduped.get(entry.name);
    if (!existing || (entry.observedAt && (!existing.observedAt || entry.observedAt > existing.observedAt))) {
      deduped.set(entry.name, entry);
    }
  }

  return Array.from(deduped.values());
}

// GET / — generate types for all (or filtered) functions
router.get("/", (req: Request, res: Response) => {
  try {
    const { functionName, env, language } = req.query;

    const functions = collectFunctionTypes({
      functionName: functionName as string | undefined,
      env: env as string | undefined,
    });

    if (functions.length === 0) {
      res.json({ types: "// No functions found matching the given filters.\n" });
      return;
    }

    const format = (req.query.format as string)?.toLowerCase();
    const isPython = (language as string)?.toLowerCase() === "python";

    if (format === "snapshot") {
      // Return raw type data as a portable JSON snapshot for `trickle check`
      const snapshot = {
        version: 1,
        createdAt: new Date().toISOString(),
        functions: functions.map((f) => ({
          name: f.name,
          module: f.module,
          env: f.env,
          argsType: f.argsType,
          returnType: f.returnType,
        })),
      };
      res.json(snapshot);
      return;
    }

    if (format === "openapi") {
      const title = (req.query.title as string) || undefined;
      const version = (req.query.version as string) || undefined;
      const serverUrl = (req.query.serverUrl as string) || undefined;
      const spec = generateOpenApiSpec(functions, { title, version, serverUrl });
      res.json(spec);
      return;
    }

    let types: string;
    if (format === "handlers") {
      types = generateHandlerTypes(functions);
      res.json({ types });
      return;
    } else if (format === "zod") {
      types = generateZodSchemas(functions);
      res.json({ types });
      return;
    } else if (format === "react-query") {
      types = generateReactQueryHooks(functions);
      res.json({ types });
      return;
    } else if (format === "guards") {
      types = generateTypeGuards(functions);
      res.json({ types });
      return;
    } else if (format === "middleware") {
      types = generateMiddleware(functions);
      res.json({ types });
      return;
    } else if (format === "msw") {
      types = generateMswHandlers(functions);
      res.json({ types });
      return;
    } else if (format === "json-schema") {
      types = generateJsonSchemas(functions);
      res.json({ types });
      return;
    } else if (format === "swr") {
      types = generateSwrHooks(functions);
      res.json({ types });
      return;
    } else if (format === "pydantic") {
      types = generatePydanticModels(functions);
      res.json({ types });
      return;
    } else if (format === "class-validator") {
      types = generateClassValidatorDtos(functions);
      res.json({ types });
      return;
    } else if (format === "graphql") {
      types = generateGraphqlSchema(functions);
      res.json({ types });
      return;
    } else if (format === "trpc") {
      types = generateTrpcRouter(functions);
      res.json({ types });
      return;
    } else if (format === "axios") {
      types = generateAxiosClient(functions);
      res.json({ types });
      return;
    } else if (format === "annotate") {
      const lang = (language as string)?.toLowerCase() === "python" ? "python" : "typescript";
      const annotations = generateInlineAnnotations(functions, lang as "typescript" | "python");
      res.json({ annotations });
      return;
    } else if (format === "stubs") {
      // Group functions by module and return per-module type stubs
      const byModule: Record<string, typeof functions> = {};
      for (const fn of functions) {
        const mod = fn.module || "_default";
        if (!byModule[mod]) byModule[mod] = [];
        byModule[mod].push(fn);
      }

      const stubs: Record<string, { ts: string; python: string }> = {};
      for (const [mod, fns] of Object.entries(byModule)) {
        stubs[mod] = {
          ts: generateAllTypes(fns),
          python: generatePythonTypes(fns),
        };
      }
      res.json({ stubs });
      return;
    } else if (format === "client") {
      types = generateApiClient(functions);
    } else if (isPython) {
      types = generatePythonTypes(functions);
    } else {
      types = generateAllTypes(functions);
    }

    res.json({ types });
  } catch (err) {
    console.error("Codegen error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:functionName — generate types for a specific function
router.get("/:functionName", (req: Request, res: Response) => {
  try {
    const { functionName } = req.params;
    const { env, language } = req.query;

    const functions = collectFunctionTypes({
      functionName,
      env: env as string | undefined,
    });

    if (functions.length === 0) {
      res.status(404).json({ error: `No function found matching "${functionName}"` });
      return;
    }

    const isPython = (language as string)?.toLowerCase() === "python";
    const types = isPython
      ? generatePythonTypes(functions)
      : generateAllTypes(functions);

    res.json({ types });
  } catch (err) {
    console.error("Codegen error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
