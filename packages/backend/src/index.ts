import { app } from "./server";
import { db } from "./db/connection";
import { runMigrations } from "./db/migrations";
import { runCloudMigrations } from "./db/cloud-migrations";

runMigrations(db);
runCloudMigrations(db);

const PORT = parseInt(process.env.PORT || "4888", 10);

app.listen(PORT, () => {
  console.log(`[trickle] Backend listening on http://localhost:${PORT}`);
  if (process.env.NODE_ENV === "production") {
    console.log(`[trickle] Production mode enabled`);
  }
});

// ── Data retention — periodic cleanup of expired data ──

const RETENTION_DAYS = parseInt(process.env.TRICKLE_RETENTION_DAYS || "30", 10);
const CLEANUP_INTERVAL_MS = 6 * 3600_000; // Every 6 hours

function runDataRetention(): void {
  try {
    // Delete expired share links
    const expiredLinks = db.prepare(
      "DELETE FROM share_links WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
    ).run();

    // Delete old push history (keep last 30 days)
    const oldHistory = db.prepare(
      `DELETE FROM push_history WHERE pushed_at < datetime('now', '-${RETENTION_DAYS} days')`
    ).run();

    // Delete stale project data (not updated in retention period)
    const staleData = db.prepare(
      `DELETE FROM project_data WHERE pushed_at < datetime('now', '-${RETENTION_DAYS} days')`
    ).run();

    const total = (expiredLinks.changes || 0) + (oldHistory.changes || 0) + (staleData.changes || 0);
    if (total > 0) {
      console.log(`[trickle] Data retention: cleaned ${total} rows (${RETENTION_DAYS}d retention)`);
      // Reclaim space
      try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
    }
  } catch (err: any) {
    console.error("[trickle] Data retention error:", err.message);
  }
}

// Run retention on startup and periodically
setTimeout(runDataRetention, 10_000); // 10s after startup
setInterval(runDataRetention, CLEANUP_INTERVAL_MS);
