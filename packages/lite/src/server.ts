/**
 * `trickle-lite serve`: the store for runtime types observed in deployed code, on its own Postgres.
 *
 *   POST /v1/observations   write token   { project, records }   from Workers (see worker-runtime.ts)
 *   GET  /v1/observations   read token    ?project=               for `trickle-lite pull`, the editor, checks
 *
 * Environment: DATABASE_URL, TRICKLE_INGEST_TOKEN, TRICKLE_READ_TOKEN, PORT (default 4889).
 *
 * Whatever a client sends, only types are stored: every type is passed through typesOnly(), every other field
 * is validated against a narrow pattern, and anything else is dropped. Bodies over 1 MB are refused.
 */
import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import postgres from 'postgres';
import { mergeTy, shrink, typesOnly, type Ty } from './types.js';

const MAX_BODY = 1 << 20;
const MAX_RECORDS = 5000;
const PROJECT_RE = /^[\w.-]{1,64}$/;
const FILE_RE = /^(?!.*\.\.)[\w@.+-]+(\/[\w@.+-]+)*\.[cm]?tsx?$/;
const NAME_RE = /^[\w$.#()-]{1,120}$/;
const int = (v: unknown, max = 1e7) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : undefined);

function tokenOk(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith('Bearer ')) return false;
  const a = createHash('sha256').update(header.slice(7)).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

interface Clean { f: string; h: string; i: number; dx: number; meta?: Record<string, unknown>; t?: Ty }

/** Keep only what is allowed: paths, hashes, positions, code names, counts, and types. */
function clean(r: Record<string, unknown>): Clean | undefined {
  const f = typeof r.f === 'string' && r.f.length <= 300 && FILE_RE.test(r.f) ? r.f : undefined;
  const h = typeof r.h === 'string' && /^[a-z0-9]{1,16}$/.test(r.h) ? r.h : undefined;
  const i = int(r.i, 1e6);
  if (!f || !h || i === undefined) return undefined;
  const out: Clean = { f, h, i, dx: int(r.dx) ?? 0 };
  if (r.t !== undefined) {
    if (!['v', 'p', 'r'].includes(r.k as string) || typeof r.n !== 'string' || !NAME_RE.test(r.n)) return undefined;
    const meta: Record<string, unknown> = { k: r.k, n: r.n };
    for (const key of ['l', 'c', 'hl', 'hc']) meta[key] = int(r[key], 1e6) ?? 0;
    if (typeof r.fn === 'string' && NAME_RE.test(r.fn)) meta.fn = r.fn;
    if (r.a === 1) meta.a = 1;
    if (r.ann === 1) meta.ann = 1;
    out.meta = meta;
    out.t = typesOnly(r.t);
  }
  return out;
}

export async function serve(): Promise<void> {
  const { DATABASE_URL, TRICKLE_INGEST_TOKEN, TRICKLE_READ_TOKEN } = process.env;
  if (!DATABASE_URL || !TRICKLE_INGEST_TOKEN || !TRICKLE_READ_TOKEN) {
    throw new Error('trickle-lite serve needs DATABASE_URL, TRICKLE_INGEST_TOKEN and TRICKLE_READ_TOKEN');
  }
  if (TRICKLE_INGEST_TOKEN === TRICKLE_READ_TOKEN) throw new Error('use different ingest and read tokens');
  const sql = postgres(DATABASE_URL, { max: 5, onnotice: () => {} });
  await sql`create table if not exists trickle_observations (
    project text not null, file text not null, hash text not null, point integer not null,
    meta jsonb not null, ty jsonb not null, count bigint not null default 0,
    updated_at timestamptz not null default now(),
    primary key (project, file, hash, point))`;

  async function ingest(project: string, records: Clean[]) {
    await sql.begin(async (tx) => {
      for (const r of records) {
        if (r.t && r.meta) {
          const [row] = await tx`select ty from trickle_observations
            where project = ${project} and file = ${r.f} and hash = ${r.h} and point = ${r.i} for update`;
          const ty = shrink(mergeTy((row?.ty as Ty | undefined) ?? [], r.t));
          await tx`insert into trickle_observations (project, file, hash, point, meta, ty, count)
            values (${project}, ${r.f}, ${r.h}, ${r.i}, ${tx.json(r.meta as never)}, ${tx.json(ty as never)}, ${r.dx})
            on conflict (project, file, hash, point) do update
            set meta = excluded.meta, ty = excluded.ty, count = trickle_observations.count + excluded.count, updated_at = now()`;
        } else if (r.dx) {
          await tx`update trickle_observations set count = count + ${r.dx}, updated_at = now()
            where project = ${project} and file = ${r.f} and hash = ${r.h} and point = ${r.i}`;
        }
      }
    });
  }

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/health') return send(200, { ok: true });
      if (url.pathname !== '/v1/observations') return send(404, { error: 'not_found' });

      if (req.method === 'POST') {
        if (!tokenOk(req.headers.authorization, TRICKLE_INGEST_TOKEN)) return send(401, { error: 'unauthorized' });
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_BODY) return send(413, { error: 'too_large' });
          chunks.push(chunk as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const project = typeof body?.project === 'string' && PROJECT_RE.test(body.project) ? body.project : undefined;
        if (!project || !Array.isArray(body.records) || body.records.length > MAX_RECORDS) return send(400, { error: 'bad_request' });
        const records = body.records.map(clean).filter((r: Clean | undefined): r is Clean => !!r);
        await ingest(project, records);
        return send(200, { stored: records.length });
      }

      if (req.method === 'GET') {
        if (!tokenOk(req.headers.authorization, TRICKLE_READ_TOKEN)) return send(401, { error: 'unauthorized' });
        const project = url.searchParams.get('project') ?? 'default';
        if (!PROJECT_RE.test(project)) return send(400, { error: 'bad_request' });
        const rows = await sql`select file, hash, point, meta, ty, count, updated_at from trickle_observations where project = ${project}`;
        const records = rows.map((r) => ({
          w: 'cloud', f: r.file, h: r.hash, i: r.point, ...(r.meta as object), x: Number(r.count),
          at: new Date(r.updated_at as string).getTime(), t: r.ty,
        }));
        return send(200, { records });
      }
      return send(405, { error: 'method_not_allowed' });
    } catch {
      return send(400, { error: 'bad_request' });
    }
  });
  const port = Number(process.env.PORT ?? 4889);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`trickle-lite server on :${port}`);
}
