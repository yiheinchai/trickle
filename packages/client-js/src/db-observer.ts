/**
 * Database query observer — patches popular database drivers to capture
 * SQL queries, execution time, and result shapes.
 *
 * Currently supports:
 * - pg (node-postgres) — used by Prisma, Knex, Sequelize, TypeORM
 *
 * Captured data is written to .trickle/queries.jsonl as:
 *   { query: "SELECT ...", params: [...], durationMs: 2.5, rowCount: 42, columns: [...] }
 */

import * as fs from 'fs';
import * as path from 'path';

interface QueryRecord {
  kind: 'query';
  query: string;
  params?: unknown[];
  durationMs: number;
  rowCount: number;
  columns?: string[];
  error?: string;
  timestamp: number;
}

let queriesFile: string | null = null;
let debugMode = false;
const MAX_QUERY_LENGTH = 500;
const MAX_QUERIES = 500;
let queryCount = 0;

function getQueriesFile(): string {
  if (queriesFile) return queriesFile;
  const dir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  queriesFile = path.join(dir, 'queries.jsonl');
  // Clear previous
  try { fs.writeFileSync(queriesFile, ''); } catch {}
  return queriesFile;
}

function writeQuery(record: QueryRecord): void {
  if (queryCount >= MAX_QUERIES) return;
  queryCount++;
  try {
    fs.appendFileSync(getQueriesFile(), JSON.stringify(record) + '\n');
  } catch {}
}

/**
 * Patch pg (node-postgres) to capture queries.
 * Called from observe-register when pg is required.
 */
export function patchPg(pgModule: any, debug: boolean): void {
  debugMode = debug;

  // Patch Client.prototype.query
  const Client = pgModule.Client;
  if (!Client || !Client.prototype) return;

  const originalQuery = Client.prototype.query;
  if ((originalQuery as any).__trickle_patched) return;

  Client.prototype.query = function patchedQuery(...args: any[]): any {
    const startTime = performance.now();

    // Extract query text and params
    let queryText = '';
    let params: unknown[] | undefined;
    if (typeof args[0] === 'string') {
      queryText = args[0];
      params = Array.isArray(args[1]) ? args[1] : undefined;
    } else if (args[0] && typeof args[0] === 'object' && args[0].text) {
      queryText = args[0].text;
      params = args[0].values;
    }

    const truncatedQuery = queryText.length > MAX_QUERY_LENGTH
      ? queryText.substring(0, MAX_QUERY_LENGTH) + '...'
      : queryText;

    // Call original
    const result = originalQuery.apply(this, args);

    // Handle promise-based queries
    if (result && typeof result.then === 'function') {
      return result.then(
        (res: any) => {
          const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
          const columns = res.fields?.map((f: any) => f.name) || [];
          writeQuery({
            kind: 'query',
            query: truncatedQuery,
            params: params?.slice(0, 5),
            durationMs,
            rowCount: res.rowCount || 0,
            columns: columns.length > 0 ? columns : undefined,
            timestamp: Date.now(),
          });
          if (debugMode) {
            console.log(`[trickle/db] ${truncatedQuery.substring(0, 60)}... (${durationMs}ms, ${res.rowCount} rows)`);
          }
          return res;
        },
        (err: any) => {
          const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
          writeQuery({
            kind: 'query',
            query: truncatedQuery,
            params: params?.slice(0, 5),
            durationMs,
            rowCount: 0,
            error: err.message?.substring(0, 200),
            timestamp: Date.now(),
          });
          throw err;
        },
      );
    }

    return result;
  };

  (Client.prototype.query as any).__trickle_patched = true;

  // Also patch Pool if available
  if (pgModule.Pool) {
    const Pool = pgModule.Pool;
    const origPoolQuery = Pool.prototype.query;
    if (origPoolQuery && !(origPoolQuery as any).__trickle_patched) {
      Pool.prototype.query = function patchedPoolQuery(...args: any[]): any {
        const startTime = performance.now();
        let queryText = '';
        let params: unknown[] | undefined;
        if (typeof args[0] === 'string') {
          queryText = args[0];
          params = Array.isArray(args[1]) ? args[1] : undefined;
        } else if (args[0] && typeof args[0] === 'object' && args[0].text) {
          queryText = args[0].text;
          params = args[0].values;
        }

        const truncatedQuery = queryText.length > MAX_QUERY_LENGTH
          ? queryText.substring(0, MAX_QUERY_LENGTH) + '...'
          : queryText;

        const result = origPoolQuery.apply(this, args);
        if (result && typeof result.then === 'function') {
          return result.then(
            (res: any) => {
              const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
              writeQuery({
                kind: 'query',
                query: truncatedQuery,
                params: params?.slice(0, 5),
                durationMs,
                rowCount: res.rowCount || 0,
                columns: res.fields?.map((f: any) => f.name),
                timestamp: Date.now(),
              });
              return res;
            },
            (err: any) => {
              writeQuery({
                kind: 'query',
                query: truncatedQuery,
                durationMs: Math.round((performance.now() - startTime) * 100) / 100,
                rowCount: 0,
                error: err.message?.substring(0, 200),
                timestamp: Date.now(),
              });
              throw err;
            },
          );
        }
        return result;
      };
      (Pool.prototype.query as any).__trickle_patched = true;
    }
  }

  if (debugMode) {
    console.log('[trickle/db] PostgreSQL query tracing enabled');
  }
}

/**
 * Patch mysql2 to capture queries.
 */
export function patchMysql2(mysqlModule: any, debug: boolean): void {
  debugMode = debug;

  // Patch Connection.prototype.query and .execute
  const Connection = mysqlModule.Connection;
  if (!Connection || !Connection.prototype) return;

  for (const method of ['query', 'execute'] as const) {
    const original = Connection.prototype[method];
    if (!original || (original as any).__trickle_patched) continue;

    Connection.prototype[method] = function patchedMethod(...args: any[]): any {
      const startTime = performance.now();
      let queryText = typeof args[0] === 'string' ? args[0] : args[0]?.sql || '';
      const truncated = queryText.length > MAX_QUERY_LENGTH ? queryText.substring(0, MAX_QUERY_LENGTH) + '...' : queryText;

      const result = original.apply(this, args);
      if (result && typeof result.then === 'function') {
        return result.then(
          (res: any) => {
            const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
            const rows = Array.isArray(res) ? res[0] : res;
            writeQuery({
              kind: 'query', query: truncated, durationMs,
              rowCount: Array.isArray(rows) ? rows.length : 0,
              columns: Array.isArray(rows) && rows[0] ? Object.keys(rows[0]) : undefined,
              timestamp: Date.now(),
            });
            return res;
          },
          (err: any) => {
            writeQuery({
              kind: 'query', query: truncated,
              durationMs: Math.round((performance.now() - startTime) * 100) / 100,
              rowCount: 0, error: err.message?.substring(0, 200), timestamp: Date.now(),
            });
            throw err;
          },
        );
      }
      return result;
    };
    (Connection.prototype[method] as any).__trickle_patched = true;
  }

  if (debug) console.log('[trickle/db] MySQL query tracing enabled');
}

/**
 * Patch better-sqlite3 to capture queries.
 */
export function patchBetterSqlite3(dbConstructor: any, debug: boolean): void {
  debugMode = debug;

  // better-sqlite3 returns a Database constructor — patch its prototype
  const origPrepare = dbConstructor.prototype?.prepare;
  if (!origPrepare || (origPrepare as any).__trickle_patched) return;

  dbConstructor.prototype.prepare = function patchedPrepare(sql: string): any {
    const stmt = origPrepare.call(this, sql);
    const truncated = sql.length > MAX_QUERY_LENGTH ? sql.substring(0, MAX_QUERY_LENGTH) + '...' : sql;

    // Patch run, get, all methods on the statement
    for (const method of ['run', 'get', 'all'] as const) {
      const origMethod = stmt[method];
      if (!origMethod) continue;
      stmt[method] = function (...args: any[]): any {
        const startTime = performance.now();
        try {
          const result = origMethod.apply(this, args);
          const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
          const rowCount = method === 'all' ? (Array.isArray(result) ? result.length : 0)
            : method === 'get' ? (result ? 1 : 0)
            : (result?.changes || 0);
          writeQuery({
            kind: 'query', query: truncated, durationMs, rowCount, timestamp: Date.now(),
          });
          return result;
        } catch (err: any) {
          writeQuery({
            kind: 'query', query: truncated,
            durationMs: Math.round((performance.now() - startTime) * 100) / 100,
            rowCount: 0, error: err.message?.substring(0, 200), timestamp: Date.now(),
          });
          throw err;
        }
      };
    }
    return stmt;
  };
  (dbConstructor.prototype.prepare as any).__trickle_patched = true;

  if (debug) console.log('[trickle/db] SQLite query tracing enabled');
}

/**
 * Patch ioredis to capture Redis commands.
 * Called from observe-register when ioredis is required.
 */
export function patchIoredis(ioredisModule: any, debug: boolean): void {
  debugMode = debug;

  const RedisClass = ioredisModule.default || ioredisModule;
  const proto = RedisClass.prototype;
  if (!proto || (proto.sendCommand as any)?.__trickle_patched) return;

  const origSendCommand = proto.sendCommand;
  if (!origSendCommand) return;

  proto.sendCommand = function patchedSendCommand(command: any, ...rest: any[]): any {
    const cmdName = command?.name || 'UNKNOWN';
    const cmdArgs = (command?.args || []).slice(0, 3).map((a: any) =>
      typeof a === 'string' ? (a.length > 50 ? a.substring(0, 50) + '...' : a) : String(a).substring(0, 50)
    );
    const queryStr = `${cmdName.toUpperCase()} ${cmdArgs.join(' ')}`.trim();

    const startTime = performance.now();
    const result = origSendCommand.call(this, command, ...rest);

    // ioredis returns a Promise
    if (result && typeof result.then === 'function') {
      result.then(
        () => {
          writeQuery({
            kind: 'query', query: queryStr.substring(0, MAX_QUERY_LENGTH),
            durationMs: Math.round((performance.now() - startTime) * 100) / 100,
            rowCount: 1, timestamp: Date.now(),
          });
        },
        (err: any) => {
          writeQuery({
            kind: 'query', query: queryStr.substring(0, MAX_QUERY_LENGTH),
            durationMs: Math.round((performance.now() - startTime) * 100) / 100,
            rowCount: 0, error: err?.message?.substring(0, 200), timestamp: Date.now(),
          });
        }
      );
    }
    return result;
  };
  (proto.sendCommand as any).__trickle_patched = true;

  if (debug) console.log('[trickle/db] Redis (ioredis) query tracing enabled');
}

/**
 * Patch @prisma/client to capture queries.
 * Prisma has its own query engine (Rust binary) so patching pg/mysql2 won't work.
 * Instead, we hook into Prisma's $on('query') event and $use() middleware.
 */
export function patchPrisma(prismaModule: any, debug: boolean): void {
  debugMode = debug;

  const PrismaClient = prismaModule.PrismaClient;
  if (!PrismaClient || (PrismaClient as any).__trickle_patched) return;

  const originalConstructor = PrismaClient;
  const OriginalPrototype = PrismaClient.prototype;

  // Wrap the constructor to inject query logging
  const patchedConstructor = function (this: any, opts: any = {}) {
    // Enable query logging in Prisma
    if (!opts.log) opts.log = [];
    const logEntries = Array.isArray(opts.log) ? opts.log : [];

    // Add query event if not already present
    const hasQueryLog = logEntries.some((entry: any) =>
      (typeof entry === 'string' && entry === 'query') ||
      (typeof entry === 'object' && entry.emit === 'event' && entry.level === 'query')
    );
    if (!hasQueryLog) {
      logEntries.push({ emit: 'event', level: 'query' });
    }
    opts.log = logEntries;

    // Call original constructor
    const instance = new originalConstructor(opts);

    // Subscribe to query events
    try {
      instance.$on('query', (e: any) => {
        const queryText = (e.query || '').substring(0, MAX_QUERY_LENGTH);
        const params = e.params ? (() => { try { return JSON.parse(e.params).slice(0, 5); } catch { return undefined; } })() : undefined;
        writeQuery({
          kind: 'query',
          query: queryText,
          params,
          durationMs: e.duration || 0,
          rowCount: 0, // Prisma query events don't include row count
          timestamp: Date.now(),
        });
        if (debugMode) {
          console.log(`[trickle/db] Prisma: ${queryText.substring(0, 60)}... (${e.duration}ms)`);
        }
      });
    } catch { /* $on may not be available on all Prisma versions */ }

    return instance;
  };

  // Copy prototype chain
  patchedConstructor.prototype = OriginalPrototype;
  Object.setPrototypeOf(patchedConstructor, originalConstructor);

  // Copy static properties
  for (const key of Object.getOwnPropertyNames(originalConstructor)) {
    if (key !== 'prototype' && key !== 'length' && key !== 'name') {
      try {
        Object.defineProperty(patchedConstructor, key, Object.getOwnPropertyDescriptor(originalConstructor, key)!);
      } catch {}
    }
  }

  prismaModule.PrismaClient = patchedConstructor;
  (prismaModule.PrismaClient as any).__trickle_patched = true;

  if (debug) console.log('[trickle/db] Prisma query tracing enabled');
}

/**
 * Patch Drizzle ORM to capture queries.
 * Drizzle exposes a logger option in its constructor.
 * We patch the db object's execute method to capture queries.
 */
export function patchDrizzle(drizzleModule: any, debug: boolean): void {
  debugMode = debug;

  // drizzle-orm exports various dialect-specific functions
  // The common pattern is drizzle(client, { logger: true })
  // We patch by wrapping the module's default export or named exports

  for (const key of Object.keys(drizzleModule)) {
    const fn = drizzleModule[key];
    if (typeof fn !== 'function') continue;
    if ((fn as any).__trickle_patched) continue;

    // Only patch functions that look like drizzle constructors
    // (they take a client + config object)
    drizzleModule[key] = function patchedDrizzle(...args: any[]): any {
      // Inject a custom logger into the config
      const config = args[1] && typeof args[1] === 'object' ? { ...args[1] } : (args.length > 1 ? args[1] : {});

      if (typeof config === 'object' && config !== null) {
        const origLogger = config.logger;
        config.logger = {
          logQuery(query: string, params: unknown[]): void {
            const startTime = performance.now();
            writeQuery({
              kind: 'query',
              query: query.substring(0, MAX_QUERY_LENGTH),
              params: Array.isArray(params) ? params.slice(0, 5) : undefined,
              durationMs: 0, // Drizzle logger doesn't provide timing
              rowCount: 0,
              timestamp: Date.now(),
            });
            // Call original logger if present
            if (origLogger && typeof origLogger === 'object' && 'logQuery' in origLogger) {
              (origLogger as any).logQuery(query, params);
            }
          },
        };
        args[1] = config;
      }

      return fn.apply(this, args);
    };
    (drizzleModule[key] as any).__trickle_patched = true;
  }

  if (debug) console.log('[trickle/db] Drizzle ORM query tracing enabled');
}

/**
 * Patch Knex to capture queries.
 * Knex emits 'query' and 'query-response' events on the knex instance.
 */
export function patchKnex(knexModule: any, debug: boolean): void {
  debugMode = debug;

  const origKnex = knexModule.default || knexModule;
  if (typeof origKnex !== 'function' || (origKnex as any).__trickle_patched) return;

  const wrapped = function patchedKnex(this: any, ...args: any[]): any {
    const instance = origKnex.apply(this, args);

    // Track query start times
    const queryTimers = new Map<string, number>();

    try {
      instance.on('query', (data: any) => {
        queryTimers.set(data.__knexQueryUid || '', performance.now());
      });

      instance.on('query-response', (_response: any, data: any) => {
        const startTime = queryTimers.get(data.__knexQueryUid || '');
        const durationMs = startTime ? Math.round((performance.now() - startTime) * 100) / 100 : 0;
        queryTimers.delete(data.__knexQueryUid || '');

        writeQuery({
          kind: 'query',
          query: (data.sql || '').substring(0, MAX_QUERY_LENGTH),
          params: Array.isArray(data.bindings) ? data.bindings.slice(0, 5) : undefined,
          durationMs,
          rowCount: 0,
          timestamp: Date.now(),
        });
      });

      instance.on('query-error', (error: any, data: any) => {
        const startTime = queryTimers.get(data.__knexQueryUid || '');
        const durationMs = startTime ? Math.round((performance.now() - startTime) * 100) / 100 : 0;
        queryTimers.delete(data.__knexQueryUid || '');

        writeQuery({
          kind: 'query',
          query: (data.sql || '').substring(0, MAX_QUERY_LENGTH),
          durationMs,
          rowCount: 0,
          error: error?.message?.substring(0, 200),
          timestamp: Date.now(),
        });
      });
    } catch { /* query events not available */ }

    return instance;
  };

  // Copy properties
  Object.setPrototypeOf(wrapped, origKnex);
  for (const key of Object.getOwnPropertyNames(origKnex)) {
    if (key !== 'length' && key !== 'name') {
      try { Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(origKnex, key)!); } catch {}
    }
  }

  if (knexModule.default) {
    knexModule.default = wrapped;
  } else {
    // knex exports the function directly via module.exports
    // We can't replace module.exports from here, but observe-register handles that
  }

  (wrapped as any).__trickle_patched = true;
  if (debug) console.log('[trickle/db] Knex query tracing enabled');
}

/**
 * Patch mongoose to capture MongoDB operations.
 * Called from observe-register when mongoose is required.
 */
export function patchMongoose(mongooseModule: any, debug: boolean): void {
  debugMode = debug;

  const Model = mongooseModule.Model;
  if (!Model || (Model as any).__trickle_patched) return;

  const methodsToWrap = [
    'find', 'findOne', 'findById', 'findOneAndUpdate', 'findOneAndDelete',
    'create', 'insertMany', 'updateOne', 'updateMany',
    'deleteOne', 'deleteMany', 'countDocuments', 'aggregate',
  ];

  for (const method of methodsToWrap) {
    const orig = Model[method];
    if (!orig || (orig as any).__trickle_patched) continue;

    Model[method] = function patchedMethod(this: any, ...args: any[]): any {
      const collName = this.modelName || this.collection?.name || '?';
      let filterStr = '';
      if (args[0] && typeof args[0] === 'object') {
        try { filterStr = ' ' + JSON.stringify(args[0]).substring(0, 200); } catch {}
      }
      const queryStr = `db.${collName}.${method}(${filterStr.trim()})`;

      const startTime = performance.now();
      const result = orig.apply(this, args);

      // Mongoose methods return Query objects (thenables) or Promises
      if (result && typeof result.then === 'function') {
        result.then(
          (res: any) => {
            const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
            const rowCount = Array.isArray(res) ? res.length : (res ? 1 : 0);
            writeQuery({
              kind: 'query', query: queryStr.substring(0, MAX_QUERY_LENGTH),
              durationMs, rowCount, timestamp: Date.now(),
            });
          },
          (err: any) => {
            writeQuery({
              kind: 'query', query: queryStr.substring(0, MAX_QUERY_LENGTH),
              durationMs: Math.round((performance.now() - startTime) * 100) / 100,
              rowCount: 0, error: err?.message?.substring(0, 200), timestamp: Date.now(),
            });
          }
        );
      }
      return result;
    };
    (Model[method] as any).__trickle_patched = true;
  }
  (Model as any).__trickle_patched = true;

  if (debug) console.log('[trickle/db] MongoDB (mongoose) query tracing enabled');
}
