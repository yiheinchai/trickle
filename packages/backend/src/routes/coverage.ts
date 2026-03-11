import { Router, Request, Response } from "express";
import { db } from "../db/connection";

const router = Router();

/**
 * GET /api/coverage — Type observation coverage report.
 *
 * Returns per-function stats: snapshot count, variant count,
 * freshness, error count, and an overall health score.
 */
router.get("/", (req: Request, res: Response) => {
  try {
    const { env, stale_hours } = req.query;
    const staleThresholdHours = stale_hours ? parseInt(stale_hours as string, 10) : 24;

    // Get all functions
    let functionsQuery = `SELECT * FROM functions`;
    const params: unknown[] = [];
    if (env) {
      functionsQuery += ` WHERE environment = ?`;
      params.push(env);
    }
    functionsQuery += ` ORDER BY last_seen_at DESC`;

    const functions = db.prepare(functionsQuery).all(...params) as Array<{
      id: number;
      function_name: string;
      module: string;
      language: string;
      environment: string;
      first_seen_at: string;
      last_seen_at: string;
    }>;

    // Per-function stats
    const snapshotCountStmt = db.prepare(
      `SELECT COUNT(*) as count FROM type_snapshots WHERE function_id = ?`,
    );
    const variantCountStmt = db.prepare(
      `SELECT COUNT(DISTINCT type_hash) as count FROM type_snapshots WHERE function_id = ?`,
    );
    const errorCountStmt = db.prepare(
      `SELECT COUNT(*) as count FROM errors WHERE function_id = ?`,
    );
    const latestSnapshotStmt = db.prepare(
      `SELECT observed_at FROM type_snapshots WHERE function_id = ? ORDER BY observed_at DESC LIMIT 1`,
    );

    const now = new Date();
    const staleThreshold = new Date(now.getTime() - staleThresholdHours * 60 * 60 * 1000);

    const entries = functions.map((fn) => {
      const snapshots = (snapshotCountStmt.get(fn.id) as { count: number }).count;
      const variants = (variantCountStmt.get(fn.id) as { count: number }).count;
      const errors = (errorCountStmt.get(fn.id) as { count: number }).count;
      const latestRow = latestSnapshotStmt.get(fn.id) as { observed_at: string } | undefined;

      const lastObserved = latestRow ? latestRow.observed_at : fn.last_seen_at;
      const lastObservedDate = new Date(lastObserved);
      const isStale = lastObservedDate < staleThreshold;
      const hasTypes = snapshots > 0;
      const hasMultipleVariants = variants > 1;
      const hasErrors = errors > 0;

      // Per-function health: 0-100
      let health = 0;
      if (hasTypes) health += 60; // Has type observations
      if (!isStale) health += 20; // Recently observed
      if (!hasErrors) health += 10; // No errors
      if (!hasMultipleVariants) health += 10; // Consistent types (single variant)

      return {
        functionName: fn.function_name,
        module: fn.module,
        language: fn.language,
        environment: fn.environment,
        firstSeen: fn.first_seen_at,
        lastObserved,
        snapshots,
        variants,
        errors,
        isStale,
        hasTypes,
        health,
      };
    });

    // Aggregate stats
    const total = entries.length;
    const withTypes = entries.filter((e) => e.hasTypes).length;
    const staleCount = entries.filter((e) => e.isStale).length;
    const freshCount = entries.filter((e) => !e.isStale).length;
    const withErrors = entries.filter((e) => e.errors > 0).length;
    const withMultipleVariants = entries.filter((e) => e.variants > 1).length;
    const overallHealth = total > 0
      ? Math.round(entries.reduce((sum, e) => sum + e.health, 0) / total)
      : 0;

    res.json({
      summary: {
        total,
        withTypes,
        withoutTypes: total - withTypes,
        fresh: freshCount,
        stale: staleCount,
        withErrors,
        withMultipleVariants,
        health: overallHealth,
        staleThresholdHours,
      },
      entries,
    });
  } catch (err) {
    console.error("Coverage error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
