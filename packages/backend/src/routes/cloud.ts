/**
 * Cloud API routes — /api/v1/*
 *
 * Provides multi-tenant cloud observability:
 *   POST /api/v1/push       — Upload .trickle/ data for a project
 *   GET  /api/v1/pull       — Download project data
 *   GET  /api/v1/projects   — List projects for authenticated user
 *   POST /api/v1/projects   — Create a new project
 *   POST /api/v1/keys       — Generate a new API key
 *   POST /api/v1/share      — Create a shareable dashboard link
 *   GET  /api/v1/shared/:id — View shared dashboard data (no auth required)
 *   GET  /api/v1/dashboard/:projectId — Get dashboard data for a project
 */

import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { db } from "../db/connection";

const router = Router();

// ── Helpers ──

function generateId(): string {
  return crypto.randomBytes(12).toString("hex");
}

function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `tk_${crypto.randomBytes(24).toString("hex")}`;
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  const prefix = key.slice(0, 7);
  return { key, hash, prefix };
}

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

// ── Auth middleware ──

interface AuthedRequest extends Request {
  keyId?: string;
  keyName?: string;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header. Use: Bearer <api-key>" });
    return;
  }

  const token = authHeader.slice(7);
  const tokenHash = hashKey(token);

  const key = db.prepare(
    "SELECT id, name, revoked FROM api_keys WHERE key_hash = ?"
  ).get(tokenHash) as any;

  if (!key) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  if (key.revoked) {
    res.status(403).json({ error: "API key has been revoked" });
    return;
  }

  // Update last_used_at
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(key.id);

  req.keyId = key.id;
  req.keyName = key.name;
  next();
}

// ── POST /api/v1/keys — Generate a new API key ──

router.post("/keys", (req: Request, res: Response) => {
  const { name, email } = req.body || {};
  const { key, hash, prefix } = generateApiKey();
  const id = generateId();

  db.prepare(
    "INSERT INTO api_keys (id, key_hash, key_prefix, name, owner_email) VALUES (?, ?, ?, ?, ?)"
  ).run(id, hash, prefix, name || "default", email || null);

  res.status(201).json({
    id,
    key, // Only returned once — user must save it
    prefix,
    name: name || "default",
    message: "Save this key — it cannot be retrieved later.",
  });
});

// ── POST /api/v1/push — Upload project data ──

router.post("/push", requireAuth, (req: AuthedRequest, res: Response) => {
  const { project, files, timestamp } = req.body;

  if (!project || typeof project !== "string") {
    res.status(400).json({ error: "project name required" });
    return;
  }
  if (!files || typeof files !== "object") {
    res.status(400).json({ error: "files object required" });
    return;
  }

  const projectId = `${req.keyId}:${project}`;

  // Upsert project
  db.prepare(`
    INSERT INTO projects (id, name, owner_key_id, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')
  `).run(projectId, project, req.keyId);

  // Upsert each file
  const upsertFile = db.prepare(`
    INSERT INTO project_data (project_id, filename, content, size_bytes, pushed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, filename) DO UPDATE SET
      content = excluded.content,
      size_bytes = excluded.size_bytes,
      pushed_at = datetime('now')
  `);

  let totalBytes = 0;
  let fileCount = 0;

  const insertMany = db.transaction(() => {
    for (const [filename, content] of Object.entries(files)) {
      if (typeof content !== "string") continue;
      const bytes = Buffer.byteLength(content, "utf-8");
      upsertFile.run(projectId, filename, content, bytes);
      totalBytes += bytes;
      fileCount++;
    }
  });
  insertMany();

  // Record push history
  db.prepare(
    "INSERT INTO push_history (project_id, key_id, file_count, total_bytes) VALUES (?, ?, ?, ?)"
  ).run(projectId, req.keyId, fileCount, totalBytes);

  const dashboardUrl = `${req.protocol}://${req.get("host")}/api/v1/dashboard/${encodeURIComponent(projectId)}`;

  res.json({
    ok: true,
    project: projectId,
    files: fileCount,
    bytes: totalBytes,
    url: dashboardUrl,
  });
});

// ── GET /api/v1/pull — Download project data ──

router.get("/pull", requireAuth, (req: AuthedRequest, res: Response) => {
  const project = req.query.project as string;
  if (!project) {
    res.status(400).json({ error: "project query parameter required" });
    return;
  }

  const projectId = `${req.keyId}:${project}`;

  const rows = db.prepare(
    "SELECT filename, content FROM project_data WHERE project_id = ?"
  ).all(projectId) as any[];

  if (rows.length === 0) {
    res.status(404).json({ error: "No data found for this project" });
    return;
  }

  const files: Record<string, string> = {};
  for (const row of rows) {
    files[row.filename] = row.content;
  }

  res.json({ project, files, fileCount: rows.length });
});

// ── GET /api/v1/projects — List projects ──

router.get("/projects", requireAuth, (req: AuthedRequest, res: Response) => {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.created_at, p.updated_at,
      (SELECT COUNT(*) FROM project_data pd WHERE pd.project_id = p.id) as file_count,
      (SELECT SUM(pd.size_bytes) FROM project_data pd WHERE pd.project_id = p.id) as total_bytes
    FROM projects p
    WHERE p.owner_key_id = ?
    ORDER BY p.updated_at DESC
  `).all(req.keyId) as any[];

  res.json({
    projects: rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      files: r.file_count || 0,
      size: r.total_bytes || 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

// ── POST /api/v1/projects — Create project ──

router.post("/projects", requireAuth, (req: AuthedRequest, res: Response) => {
  const { name } = req.body;
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }

  const projectId = `${req.keyId}:${name}`;

  db.prepare(`
    INSERT INTO projects (id, name, owner_key_id)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(projectId, name, req.keyId);

  res.status(201).json({ id: projectId, name });
});

// ── POST /api/v1/share — Create shareable link ──

router.post("/share", requireAuth, (req: AuthedRequest, res: Response) => {
  const { project, expiresInHours } = req.body;
  if (!project) {
    res.status(400).json({ error: "project name required" });
    return;
  }

  const projectId = `${req.keyId}:${project}`;

  // Verify project exists
  const proj = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  if (!proj) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const shareId = generateId();
  const expiresAt = expiresInHours
    ? new Date(Date.now() + expiresInHours * 3600000).toISOString()
    : null;

  db.prepare(
    "INSERT INTO share_links (id, project_id, created_by, expires_at) VALUES (?, ?, ?, ?)"
  ).run(shareId, projectId, req.keyId!, expiresAt);

  const shareUrl = `${req.protocol}://${req.get("host")}/api/v1/shared/${shareId}`;

  res.status(201).json({
    shareId,
    url: shareUrl,
    expiresAt,
  });
});

// ── GET /api/v1/shared/:id — View shared data (no auth) ──

router.get("/shared/:id", (req: Request, res: Response) => {
  const link = db.prepare(`
    SELECT sl.project_id, sl.expires_at, p.name as project_name
    FROM share_links sl
    JOIN projects p ON p.id = sl.project_id
    WHERE sl.id = ?
  `).get(req.params.id) as any;

  if (!link) {
    res.status(404).json({ error: "Share link not found" });
    return;
  }

  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    res.status(410).json({ error: "Share link has expired" });
    return;
  }

  const rows = db.prepare(
    "SELECT filename, content FROM project_data WHERE project_id = ?"
  ).all(link.project_id) as any[];

  const files: Record<string, string> = {};
  for (const row of rows) {
    files[row.filename] = row.content;
  }

  // If request accepts HTML, serve dashboard
  if (req.accepts("html")) {
    res.send(generateDashboardHtml(link.project_name, files));
    return;
  }

  res.json({ project: link.project_name, files, fileCount: rows.length });
});

// ── GET /api/v1/dashboard/:projectId — Authenticated dashboard ──

router.get("/dashboard/:projectId", requireAuth, (req: AuthedRequest, res: Response) => {
  const projectId = decodeURIComponent(req.params.projectId);

  // Verify ownership
  const proj = db.prepare(
    "SELECT name FROM projects WHERE id = ? AND owner_key_id = ?"
  ).get(projectId, req.keyId) as any;

  if (!proj) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const rows = db.prepare(
    "SELECT filename, content FROM project_data WHERE project_id = ?"
  ).all(projectId) as any[];

  const files: Record<string, string> = {};
  for (const row of rows) {
    files[row.filename] = row.content;
  }

  if (req.accepts("html")) {
    res.send(generateDashboardHtml(proj.name, files));
    return;
  }

  res.json({ project: proj.name, files, fileCount: rows.length });
});

// ── Dashboard HTML generator ──

function generateDashboardHtml(projectName: string, files: Record<string, string>): string {
  // Parse data files
  const parseJsonl = (content: string) =>
    content.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const observations = files["observations.jsonl"] ? parseJsonl(files["observations.jsonl"]) : [];
  const variables = files["variables.jsonl"] ? parseJsonl(files["variables.jsonl"]) : [];
  const calltrace = files["calltrace.jsonl"] ? parseJsonl(files["calltrace.jsonl"]) : [];
  const queries = files["queries.jsonl"] ? parseJsonl(files["queries.jsonl"]) : [];
  const errors = files["errors.jsonl"] ? parseJsonl(files["errors.jsonl"]) : [];
  const alerts = files["alerts.jsonl"] ? parseJsonl(files["alerts.jsonl"]) : [];
  const profile = files["profile.jsonl"] ? parseJsonl(files["profile.jsonl"]) : [];
  let environment: any = {};
  try { if (files["environment.json"]) environment = JSON.parse(files["environment.json"]); } catch {}

  const criticalAlerts = alerts.filter((a: any) => a.severity === "critical");
  const warningAlerts = alerts.filter((a: any) => a.severity === "warning");
  const endProfile = profile.find((p: any) => p.event === "end");

  const status = criticalAlerts.length > 0 ? "critical" :
    errors.length > 0 ? "error" :
    warningAlerts.length > 0 ? "warning" : "healthy";

  const statusColors: Record<string, string> = {
    healthy: "#22c55e", warning: "#eab308", error: "#ef4444", critical: "#dc2626",
  };

  const slowFuncs = observations
    .filter((o: any) => o.durationMs && o.durationMs > 10)
    .sort((a: any, b: any) => (b.durationMs || 0) - (a.durationMs || 0))
    .slice(0, 10);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${projectName} — trickle dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e5e7eb; line-height: 1.5; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
  h2 { font-size: 18px; font-weight: 600; margin: 24px 0 12px; color: #9ca3af; }
  .subtitle { color: #6b7280; font-size: 14px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #1f2937; border-radius: 8px; padding: 16px; border: 1px solid #374151; }
  .card-label { font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; }
  .card-value { font-size: 28px; font-weight: 700; margin-top: 4px; }
  .status-badge { display: inline-block; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px 12px; font-size: 12px; color: #9ca3af; text-transform: uppercase; border-bottom: 1px solid #374151; }
  td { padding: 8px 12px; border-bottom: 1px solid #1f2937; font-size: 14px; }
  .mono { font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 13px; }
  .bar { height: 8px; border-radius: 4px; background: #3b82f6; display: inline-block; min-width: 4px; }
  .alert-critical { border-left: 3px solid #ef4444; }
  .alert-warning { border-left: 3px solid #eab308; }
  .error-card { background: #1f2937; border-left: 3px solid #ef4444; padding: 12px; margin-bottom: 8px; border-radius: 4px; }
  .section { background: #1f2937; border-radius: 8px; padding: 16px; border: 1px solid #374151; margin-bottom: 16px; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; background: #374151; color: #9ca3af; margin-right: 4px; }
  footer { text-align: center; padding: 24px; color: #4b5563; font-size: 12px; }
  a { color: #3b82f6; text-decoration: none; }
</style>
</head>
<body>
<div class="container">
  <h1>${projectName}</h1>
  <div class="subtitle">
    <span class="status-badge" style="background: ${statusColors[status]}20; color: ${statusColors[status]}">${status.toUpperCase()}</span>
    ${environment.node ? `<span class="tag">Node ${environment.node.version}</span>` : ""}
    ${environment.python ? `<span class="tag">Python ${environment.python}</span>` : ""}
    ${endProfile ? `<span class="tag">${Math.round((endProfile.rssKb || 0) / 1024)}MB RSS</span>` : ""}
  </div>

  <div class="grid">
    <div class="card">
      <div class="card-label">Functions</div>
      <div class="card-value">${observations.length}</div>
    </div>
    <div class="card">
      <div class="card-label">Variables</div>
      <div class="card-value">${variables.length}</div>
    </div>
    <div class="card">
      <div class="card-label">DB Queries</div>
      <div class="card-value">${queries.length}</div>
    </div>
    <div class="card">
      <div class="card-label">Call Trace</div>
      <div class="card-value">${calltrace.length}</div>
    </div>
    <div class="card">
      <div class="card-label">Errors</div>
      <div class="card-value" style="color: ${errors.length > 0 ? "#ef4444" : "#22c55e"}">${errors.length}</div>
    </div>
    <div class="card">
      <div class="card-label">Alerts</div>
      <div class="card-value" style="color: ${criticalAlerts.length > 0 ? "#ef4444" : warningAlerts.length > 0 ? "#eab308" : "#22c55e"}">${alerts.length}</div>
    </div>
  </div>

  ${alerts.length > 0 ? `
  <h2>Alerts</h2>
  <div class="section">
    ${alerts.map((a: any) => `
      <div class="card ${a.severity === "critical" ? "alert-critical" : "alert-warning"}" style="margin-bottom: 8px;">
        <strong>${a.severity === "critical" ? "CRITICAL" : "WARNING"}</strong>: ${escapeHtml(a.message || "")}
        ${a.suggestion ? `<div style="color: #9ca3af; font-size: 13px; margin-top: 4px;">Fix: ${escapeHtml(a.suggestion)}</div>` : ""}
      </div>
    `).join("")}
  </div>` : ""}

  ${errors.length > 0 ? `
  <h2>Errors</h2>
  <div class="section">
    ${errors.slice(0, 10).map((e: any) => `
      <div class="error-card">
        <strong class="mono">${escapeHtml(e.type || "Error")}</strong>: ${escapeHtml((e.message || "").substring(0, 200))}
        ${e.function ? `<div style="color: #6b7280; font-size: 12px;">in ${escapeHtml(e.function)}</div>` : ""}
      </div>
    `).join("")}
  </div>` : ""}

  ${slowFuncs.length > 0 ? `
  <h2>Performance Hotspots</h2>
  <div class="section">
    <table>
      <thead><tr><th>Function</th><th>Module</th><th>Duration</th><th></th></tr></thead>
      <tbody>
        ${slowFuncs.map((f: any) => {
          const pct = Math.round((f.durationMs / slowFuncs[0].durationMs) * 100);
          return `<tr>
            <td class="mono">${escapeHtml(f.functionName || "?")}</td>
            <td>${escapeHtml(f.module || "?")}</td>
            <td>${f.durationMs?.toFixed(0)}ms</td>
            <td><div class="bar" style="width: ${pct}%"></div></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  </div>` : ""}

  ${observations.length > 0 ? `
  <h2>Observed Functions</h2>
  <div class="section">
    <table>
      <thead><tr><th>Function</th><th>Module</th><th>Duration</th></tr></thead>
      <tbody>
        ${observations.slice(0, 30).map((o: any) => `<tr>
          <td class="mono">${escapeHtml(o.functionName || "?")}</td>
          <td>${escapeHtml(o.module || "?")}</td>
          <td>${o.durationMs ? o.durationMs.toFixed(0) + "ms" : "-"}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>` : ""}

  ${queries.length > 0 ? `
  <h2>Database Queries</h2>
  <div class="section">
    <table>
      <thead><tr><th>Query</th><th>Duration</th></tr></thead>
      <tbody>
        ${queries.slice(0, 20).map((q: any) => `<tr>
          <td class="mono" style="max-width: 600px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml((q.query || q.sql || "?").substring(0, 100))}</td>
          <td>${q.durationMs ? q.durationMs.toFixed(1) + "ms" : "-"}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>` : ""}
</div>
<footer>Powered by <a href="https://github.com/yiheinchai/trickle">trickle</a> — runtime observability</footer>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default router;
