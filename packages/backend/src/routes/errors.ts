import { Router, Request, Response } from "express";
import { db } from "../db/connection";
import { listErrors, getError } from "../db/queries";

const router = Router();

// GET / — list errors with filters
router.get("/", (req: Request, res: Response) => {
  try {
    const { functionName, env, since, limit, offset } = req.query;

    const result = listErrors(db, {
      functionName: functionName as string | undefined,
      env: env as string | undefined,
      since: since as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    });

    const parsed = result.rows.map((row: Record<string, unknown>) => ({
      ...row,
      args_type: tryParseJson(row.args_type as string),
      return_type: tryParseJson(row.return_type as string),
      args_snapshot: tryParseJson(row.args_snapshot as string),
    }));

    res.json({ errors: parsed, total: result.total });
  } catch (err) {
    console.error("List errors error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id — get single error with full context
router.get("/:id", (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid error id" });
      return;
    }

    const errorRow = getError(db, id);
    if (!errorRow) {
      res.status(404).json({ error: "Error not found" });
      return;
    }

    // Find the associated type snapshot if type_hash is available
    let snapshot: Record<string, unknown> | undefined;
    if (errorRow.type_hash && errorRow.function_id) {
      const stmt = db.prepare(`
        SELECT * FROM type_snapshots
        WHERE function_id = ? AND type_hash = ?
        ORDER BY observed_at DESC
        LIMIT 1
      `);
      snapshot = stmt.get(errorRow.function_id, errorRow.type_hash) as Record<string, unknown> | undefined;
    }

    res.json({
      error: {
        ...errorRow,
        args_type: tryParseJson(errorRow.args_type as string),
        return_type: tryParseJson(errorRow.return_type as string),
        args_snapshot: tryParseJson(errorRow.args_snapshot as string),
      },
      snapshot: snapshot
        ? {
            ...snapshot,
            args_type: tryParseJson(snapshot.args_type as string),
            return_type: tryParseJson(snapshot.return_type as string),
          }
        : null,
    });
  } catch (err) {
    console.error("Get error error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

function tryParseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export default router;
