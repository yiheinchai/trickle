import { Router, Request, Response } from "express";
import { db } from "../db/connection";
import { upsertFunction, findSnapshotByHash, insertSnapshot, insertError } from "../db/queries";
import { sseBroker } from "../services/sse-broker";
import { IngestPayload } from "../types";

const router = Router();

function processPayload(payload: IngestPayload) {
  const {
    functionName,
    module,
    language,
    environment,
    typeHash,
    argsType,
    returnType,
    sampleInput,
    sampleOutput,
    error,
  } = payload;

  const env = environment || "unknown";
  const func = upsertFunction(db, { functionName, module, environment: env, language });
  const functionId = func.id as number;

  let isNewType = false;
  const existingSnapshot = findSnapshotByHash(db, functionId, typeHash, env);

  if (!existingSnapshot) {
    insertSnapshot(db, {
      functionId,
      typeHash,
      argsType: JSON.stringify(argsType),
      returnType: JSON.stringify(returnType),
      variablesType: null as any,
      sampleInput: sampleInput !== undefined ? JSON.stringify(sampleInput) : null as any,
      sampleOutput: sampleOutput !== undefined ? JSON.stringify(sampleOutput) : null as any,
      env,
    });
    isNewType = true;

    sseBroker.broadcast("type:new", {
      functionName,
      module,
      typeHash,
      environment: env,
    });
  }

  let errorRecord: Record<string, unknown> | undefined;
  if (error) {
    errorRecord = insertError(db, {
      functionId,
      errorType: error.type,
      errorMessage: error.message,
      stackTrace: error.stackTrace || null as any,
      argsType: JSON.stringify(argsType),
      returnType: JSON.stringify(returnType),
      variablesType: null as any,
      argsSnapshot: error.argsSnapshot !== undefined ? JSON.stringify(error.argsSnapshot) : null as any,
      typeHash,
      env,
    });

    sseBroker.broadcast("error:new", {
      functionName,
      module,
      errorType: error.type,
      errorMessage: error.message,
      environment: env,
    });
  }

  return { functionId, isNewType, error: errorRecord };
}

// POST / — single payload ingest
router.post("/", (req: Request, res: Response) => {
  try {
    const payload = req.body as IngestPayload;

    if (!payload.functionName || !payload.module || !payload.typeHash) {
      res.status(400).json({ error: "Missing required fields: functionName, module, typeHash" });
      return;
    }

    const result = processPayload(payload);

    res.status(200).json({
      ok: true,
      functionId: result.functionId,
      isNewType: result.isNewType,
      errorId: result.error?.id,
    });
  } catch (err) {
    console.error("Ingest error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /batch — batch ingest
router.post("/batch", (req: Request, res: Response) => {
  try {
    const { payloads } = req.body as { payloads: IngestPayload[] };

    if (!Array.isArray(payloads) || payloads.length === 0) {
      res.status(400).json({ error: "Expected non-empty payloads array" });
      return;
    }

    const results: unknown[] = [];

    const transaction = db.transaction(() => {
      for (const payload of payloads) {
        if (!payload.functionName || !payload.module || !payload.typeHash) {
          results.push({ error: "Missing required fields", functionName: payload.functionName });
          continue;
        }
        const result = processPayload(payload);
        results.push({
          ok: true,
          functionId: result.functionId,
          isNewType: result.isNewType,
          errorId: result.error?.id,
        });
      }
    });

    transaction();

    res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error("Batch ingest error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
