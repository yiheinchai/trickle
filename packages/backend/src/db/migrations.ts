import type Database from "better-sqlite3";

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS functions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      function_name TEXT NOT NULL,
      module TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'unknown',
      language TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(function_name, module, language)
    );

    CREATE TABLE IF NOT EXISTS type_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      function_id INTEGER NOT NULL REFERENCES functions(id),
      type_hash TEXT NOT NULL,
      args_type TEXT NOT NULL,
      return_type TEXT NOT NULL,
      variables_type TEXT,
      sample_input TEXT,
      sample_output TEXT,
      env TEXT NOT NULL DEFAULT 'unknown',
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(function_id, type_hash, env)
    );

    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      function_id INTEGER NOT NULL REFERENCES functions(id),
      error_type TEXT NOT NULL,
      error_message TEXT NOT NULL,
      stack_trace TEXT,
      args_type TEXT,
      return_type TEXT,
      variables_type TEXT,
      args_snapshot TEXT,
      type_hash TEXT,
      env TEXT NOT NULL DEFAULT 'unknown',
      occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_function_id ON type_snapshots(function_id);
    CREATE INDEX IF NOT EXISTS idx_errors_function_id ON errors(function_id);
    CREATE INDEX IF NOT EXISTS idx_errors_occurred_at ON errors(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_errors_env ON errors(env);
  `);
}
