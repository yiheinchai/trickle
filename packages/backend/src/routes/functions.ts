import { Router, Request, Response } from "express";
import { db } from "../db/connection";
import { listFunctions, getFunction, getLatestSnapshot } from "../db/queries";

const router = Router();

// GET / — list functions
router.get("/", (req: Request, res: Response) => {
  try {
    const { q, env, language, limit, offset } = req.query;

    const result = listFunctions(db, {
      search: q as string | undefined,
      env: env as string | undefined,
      language: language as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    });

    res.json({ functions: result.rows, total: result.total });
  } catch (err) {
    console.error("List functions error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id — get single function with latest snapshots
router.get("/:id", (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid function id" });
      return;
    }

    const func = getFunction(db, id);
    if (!func) {
      res.status(404).json({ error: "Function not found" });
      return;
    }

    // Get latest snapshots per known env
    const envStmt = db.prepare(`
      SELECT DISTINCT env FROM type_snapshots WHERE function_id = ?
    `);
    const envs = (envStmt.all(id) as { env: string }[]).map((r) => r.env);

    const latestSnapshots: Record<string, unknown> = {};
    for (const env of envs) {
      const snapshot = getLatestSnapshot(db, id, env);
      if (snapshot) {
        latestSnapshots[env] = {
          ...snapshot,
          args_type: tryParseJson(snapshot.args_type as string),
          return_type: tryParseJson(snapshot.return_type as string),
        };
      }
    }

    res.json({ function: func, latestSnapshots });
  } catch (err) {
    console.error("Get function error:", err);
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
