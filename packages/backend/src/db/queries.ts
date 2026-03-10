import type Database from "better-sqlite3";

// --- Functions ---

export function upsertFunction(
  db: Database.Database,
  params: { functionName: string; module: string; environment: string; language: string }
) {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO functions (function_name, module, environment, language)
    VALUES (@functionName, @module, @environment, @language)
  `);
  const updateStmt = db.prepare(`
    UPDATE functions
    SET last_seen_at = datetime('now'), environment = @environment
    WHERE function_name = @functionName AND module = @module AND language = @language
  `);
  const selectStmt = db.prepare(`
    SELECT * FROM functions
    WHERE function_name = @functionName AND module = @module AND language = @language
  `);

  insertStmt.run(params);
  updateStmt.run(params);
  return selectStmt.get(params) as Record<string, unknown>;
}

// --- Type Snapshots ---

export function findSnapshotByHash(
  db: Database.Database,
  functionId: number,
  typeHash: string,
  env: string
) {
  const stmt = db.prepare(`
    SELECT * FROM type_snapshots
    WHERE function_id = ? AND type_hash = ? AND env = ?
  `);
  return stmt.get(functionId, typeHash, env) as Record<string, unknown> | undefined;
}

export function insertSnapshot(
  db: Database.Database,
  params: {
    functionId: number;
    typeHash: string;
    argsType: string;
    returnType: string;
    variablesType?: string;
    sampleInput?: string;
    sampleOutput?: string;
    env: string;
  }
) {
  const stmt = db.prepare(`
    INSERT INTO type_snapshots (function_id, type_hash, args_type, return_type, variables_type, sample_input, sample_output, env)
    VALUES (@functionId, @typeHash, @argsType, @returnType, @variablesType, @sampleInput, @sampleOutput, @env)
  `);
  const result = stmt.run(params);
  return { id: result.lastInsertRowid, ...params };
}

// --- Errors ---

export function insertError(
  db: Database.Database,
  params: {
    functionId: number;
    errorType: string;
    errorMessage: string;
    stackTrace?: string;
    argsType?: string;
    returnType?: string;
    variablesType?: string;
    argsSnapshot?: string;
    typeHash?: string;
    env: string;
  }
) {
  const stmt = db.prepare(`
    INSERT INTO errors (function_id, error_type, error_message, stack_trace, args_type, return_type, variables_type, args_snapshot, type_hash, env)
    VALUES (@functionId, @errorType, @errorMessage, @stackTrace, @argsType, @returnType, @variablesType, @argsSnapshot, @typeHash, @env)
  `);
  const result = stmt.run(params);

  const selectStmt = db.prepare(`SELECT * FROM errors WHERE id = ?`);
  return selectStmt.get(result.lastInsertRowid) as Record<string, unknown>;
}

// --- List / Get Functions ---

export function listFunctions(
  db: Database.Database,
  params: { search?: string; env?: string; language?: string; limit?: number; offset?: number }
) {
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (params.search) {
    conditions.push("(function_name LIKE ? OR module LIKE ?)");
    bindings.push(`%${params.search}%`, `%${params.search}%`);
  }
  if (params.env) {
    conditions.push("environment = ?");
    bindings.push(params.env);
  }
  if (params.language) {
    conditions.push("language = ?");
    bindings.push(params.language);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const stmt = db.prepare(`
    SELECT * FROM functions ${where}
    ORDER BY last_seen_at DESC
    LIMIT ? OFFSET ?
  `);
  bindings.push(limit, offset);

  const countStmt = db.prepare(`SELECT COUNT(*) as total FROM functions ${where}`);
  const countBindings = bindings.slice(0, bindings.length - 2);

  const rows = stmt.all(...bindings) as Record<string, unknown>[];
  const total = (countStmt.get(...countBindings) as { total: number }).total;

  return { rows, total };
}

export function getFunction(db: Database.Database, id: number) {
  const stmt = db.prepare(`SELECT * FROM functions WHERE id = ?`);
  return stmt.get(id) as Record<string, unknown> | undefined;
}

export function getFunctionByName(db: Database.Database, functionName: string) {
  const stmt = db.prepare(`SELECT * FROM functions WHERE function_name LIKE ?`);
  return stmt.all(`%${functionName}%`) as Record<string, unknown>[];
}

// --- List / Get Snapshots ---

export function listSnapshots(
  db: Database.Database,
  params: { functionId: number; env?: string; limit?: number }
) {
  const conditions: string[] = ["function_id = ?"];
  const bindings: unknown[] = [params.functionId];

  if (params.env) {
    conditions.push("env = ?");
    bindings.push(params.env);
  }

  const limit = params.limit ?? 50;
  const where = conditions.join(" AND ");

  const stmt = db.prepare(`
    SELECT * FROM type_snapshots
    WHERE ${where}
    ORDER BY observed_at DESC
    LIMIT ?
  `);
  bindings.push(limit);

  return stmt.all(...bindings) as Record<string, unknown>[];
}

export function getLatestSnapshot(db: Database.Database, functionId: number, env?: string) {
  if (env) {
    const stmt = db.prepare(`
      SELECT * FROM type_snapshots
      WHERE function_id = ? AND env = ?
      ORDER BY observed_at DESC
      LIMIT 1
    `);
    return stmt.get(functionId, env) as Record<string, unknown> | undefined;
  }

  const stmt = db.prepare(`
    SELECT * FROM type_snapshots
    WHERE function_id = ?
    ORDER BY observed_at DESC
    LIMIT 1
  `);
  return stmt.get(functionId) as Record<string, unknown> | undefined;
}

// --- List / Get Errors ---

export function listErrors(
  db: Database.Database,
  params: {
    functionId?: number;
    functionName?: string;
    env?: string;
    since?: string;
    limit?: number;
    offset?: number;
  }
) {
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (params.functionId) {
    conditions.push("e.function_id = ?");
    bindings.push(params.functionId);
  }
  if (params.functionName) {
    conditions.push("f.function_name LIKE ?");
    bindings.push(`%${params.functionName}%`);
  }
  if (params.env) {
    conditions.push("e.env = ?");
    bindings.push(params.env);
  }
  if (params.since) {
    conditions.push("e.occurred_at >= ?");
    bindings.push(params.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const stmt = db.prepare(`
    SELECT e.*, f.function_name, f.module, f.language
    FROM errors e
    JOIN functions f ON f.id = e.function_id
    ${where}
    ORDER BY e.occurred_at DESC
    LIMIT ? OFFSET ?
  `);
  bindings.push(limit, offset);

  const countStmt = db.prepare(`
    SELECT COUNT(*) as total
    FROM errors e
    JOIN functions f ON f.id = e.function_id
    ${where}
  `);
  const countBindings = bindings.slice(0, bindings.length - 2);

  const rows = stmt.all(...bindings) as Record<string, unknown>[];
  const total = (countStmt.get(...countBindings) as { total: number }).total;

  return { rows, total };
}

export function getError(db: Database.Database, id: number) {
  const stmt = db.prepare(`
    SELECT e.*, f.function_name, f.module, f.language
    FROM errors e
    JOIN functions f ON f.id = e.function_id
    WHERE e.id = ?
  `);
  return stmt.get(id) as Record<string, unknown> | undefined;
}
