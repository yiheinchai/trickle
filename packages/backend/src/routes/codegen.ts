import { Router, Request, Response } from "express";
import { db } from "../db/connection";
import { listFunctions, getFunctionByName, getLatestSnapshot } from "../db/queries";
import { generateAllTypes, generatePythonTypes, generateApiClient } from "../services/type-generator";
import { TypeNode } from "../types";

const router = Router();

interface FunctionTypeData {
  name: string;
  argsType: TypeNode;
  returnType: TypeNode;
  module?: string;
  env?: string;
  observedAt?: string;
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
    });
  }

  return results;
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

    let types: string;
    if (format === "client") {
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
