/**
 * Shared storage for observations from anywhere (Cloudflare Workers, test runs on any machine), in a Neon
 * Postgres database of trickle-lite's own, reached over HTTPS with Neon's SQL-over-HTTP endpoint. No Node APIs,
 * so the Worker runtime uses it too.
 *
 * Rows are append-only: each is one observation record (types only), and readers merge them (see Store).
 */
import type { Rec } from './recorder.js';

const SCHEMA = [
  `create table if not exists trickle_records (
     id bigserial primary key, project text not null, created_at timestamptz not null default now(), rec jsonb not null)`,
  `create index if not exists trickle_records_project on trickle_records (project, id)`,
];
const CHUNK = 500;
const ready = new Set<string>();

async function query(url: string, sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`https://${new URL(url).hostname}/sql`, {
    method: 'POST',
    headers: { 'Neon-Connection-String': url, 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Neon query failed (${res.status})`); // the body can echo the connection; never shown
  return ((await res.json()) as { rows: Array<Record<string, unknown>> }).rows;
}

async function ensureSchema(url: string) {
  if (ready.has(url)) return;
  for (const statement of SCHEMA) await query(url, statement);
  ready.add(url);
}

/** Append records for a project. */
export async function insertRecords(url: string, project: string, records: Rec[]): Promise<void> {
  if (!records.length) return;
  await ensureSchema(url);
  for (let i = 0; i < records.length; i += CHUNK) {
    await query(url, 'insert into trickle_records (project, rec) select $1, value from jsonb_array_elements($2::jsonb)',
      [project, JSON.stringify(records.slice(i, i + CHUNK))]);
  }
}

/** Every record for a project, oldest first. */
export async function fetchRecords(url: string, project: string): Promise<unknown[]> {
  await ensureSchema(url);
  const rows = await query(url, 'select rec from trickle_records where project = $1 order by id', [project]);
  return rows.map((r) => (typeof r.rec === 'string' ? JSON.parse(r.rec) : r.rec));
}
