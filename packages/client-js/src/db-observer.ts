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
const MAX_QUERIES = 100;
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
