import type Database from "better-sqlite3";

export function runCloudMigrations(db: Database.Database): void {
  db.exec(`
    -- Projects table: each project is an isolated workspace
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_key_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      settings TEXT DEFAULT '{}'
    );

    -- API keys for authentication
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'default',
      owner_email TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked INTEGER NOT NULL DEFAULT 0
    );

    -- Project data: stores all JSONL/JSON files per project
    CREATE TABLE IF NOT EXISTS project_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      filename TEXT NOT NULL,
      content TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      pushed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, filename)
    );

    -- Push history for audit trail
    CREATE TABLE IF NOT EXISTS push_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      key_id TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      total_bytes INTEGER NOT NULL,
      pushed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Shared dashboards (public read-only links)
    CREATE TABLE IF NOT EXISTS share_links (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      created_by TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_project_data_project ON project_data(project_id);
    CREATE INDEX IF NOT EXISTS idx_push_history_project ON push_history(project_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
  `);
}
