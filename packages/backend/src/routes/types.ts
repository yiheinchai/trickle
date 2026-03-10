import { Router, Request, Response } from "express";
import { db } from "../db/connection";
import { listSnapshots } from "../db/queries";
import { diffTypes } from "../services/type-differ";
import { TypeNode } from "../types";

const router = Router();

// GET /:functionId — get type snapshots for a function
router.get("/:functionId", (req: Request, res: Response) => {
  try {
    const functionId = parseInt(req.params.functionId, 10);
    if (isNaN(functionId)) {
      res.status(400).json({ error: "Invalid functionId" });
      return;
    }

    const { env, limit } = req.query;
    const snapshots = listSnapshots(db, {
      functionId,
      env: env as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
    });

    const parsed = snapshots.map((s) => ({
      ...s,
      args_type: tryParseJson(s.args_type as string),
      return_type: tryParseJson(s.return_type as string),
      sample_input: tryParseJson(s.sample_input as string),
      sample_output: tryParseJson(s.sample_output as string),
    }));

    res.json({ snapshots: parsed });
  } catch (err) {
    console.error("List types error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:functionId/diff — diff between two snapshots or envs
router.get("/:functionId/diff", (req: Request, res: Response) => {
  try {
    const functionId = parseInt(req.params.functionId, 10);
    if (isNaN(functionId)) {
      res.status(400).json({ error: "Invalid functionId" });
      return;
    }

    const { from, to, fromEnv, toEnv } = req.query;

    let fromSnapshot: Record<string, unknown> | undefined;
    let toSnapshot: Record<string, unknown> | undefined;

    if (from && to) {
      // Diff by snapshot IDs
      const stmt = db.prepare(`SELECT * FROM type_snapshots WHERE id = ? AND function_id = ?`);
      fromSnapshot = stmt.get(parseInt(from as string, 10), functionId) as Record<string, unknown> | undefined;
      toSnapshot = stmt.get(parseInt(to as string, 10), functionId) as Record<string, unknown> | undefined;
    } else if (fromEnv && toEnv) {
      // Diff between envs (latest snapshot in each)
      const stmt = db.prepare(`
        SELECT * FROM type_snapshots
        WHERE function_id = ? AND env = ?
        ORDER BY observed_at DESC
        LIMIT 1
      `);
      fromSnapshot = stmt.get(functionId, fromEnv as string) as Record<string, unknown> | undefined;
      toSnapshot = stmt.get(functionId, toEnv as string) as Record<string, unknown> | undefined;
    } else {
      res.status(400).json({ error: "Provide 'from' and 'to' snapshot IDs, or 'fromEnv' and 'toEnv'" });
      return;
    }

    if (!fromSnapshot || !toSnapshot) {
      res.status(404).json({ error: "One or both snapshots not found" });
      return;
    }

    const fromArgs = JSON.parse(fromSnapshot.args_type as string) as TypeNode;
    const toArgs = JSON.parse(toSnapshot.args_type as string) as TypeNode;
    const fromReturn = JSON.parse(fromSnapshot.return_type as string) as TypeNode;
    const toReturn = JSON.parse(toSnapshot.return_type as string) as TypeNode;

    const argsDiff = diffTypes(fromArgs, toArgs, "args");
    const returnDiff = diffTypes(fromReturn, toReturn, "return");

    res.json({
      from: { id: fromSnapshot.id, env: fromSnapshot.env, observed_at: fromSnapshot.observed_at },
      to: { id: toSnapshot.id, env: toSnapshot.env, observed_at: toSnapshot.observed_at },
      diffs: [...argsDiff, ...returnDiff],
    });
  } catch (err) {
    console.error("Type diff error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export default router;
