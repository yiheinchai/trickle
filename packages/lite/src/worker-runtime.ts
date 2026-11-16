/**
 * The Cloudflare Workers runtime, bundled into a Worker by `trickle-lite worker`.
 *
 * Records types only: no string or boolean values, and no object keys that look like data (see infer).
 * After each request the Worker's entry calls `flush(env, project)` through `ctx.waitUntil`, which appends what
 * changed to trickle-lite's Neon database over HTTPS. The connection string is the Worker secret
 * TRICKLE_DATABASE_URL, read from `env` at that moment, never part of the bundle. Nothing here can fail a request.
 */
import { Recorder } from './recorder.js';
import { typesOnly } from './types.js';
import { insertRecords } from './neon.js';

export interface TrickleEnv {
  TRICKLE_DATABASE_URL?: string;
}

// Workers forbid random values at module scope, so the writer id is set at the first flush.
const recorder = (globalThis.__trickle ??= new Recorder({ writer: '', typesOnly: true }));
const MIN_INTERVAL_MS = 2000;
const COUNT_REFRESH_MS = 60_000;
let last = 0;

/** Send changed types (and counts once a minute). Never throws. */
export async function flush(env: TrickleEnv | undefined, project: string): Promise<void> {
  try {
    const url = env?.TRICKLE_DATABASE_URL;
    if (!url) return;
    const now = Date.now();
    if (now - last < MIN_INTERVAL_MS) return;
    if (!recorder.writer) recorder.writer = `worker-${crypto.randomUUID().slice(0, 8)}`;
    const records = recorder.take(COUNT_REFRESH_MS);
    if (!records.length) return;
    last = now;
    // Belt and braces: whatever the recorder produced, only types leave.
    for (const r of records) if (r.t) r.t = typesOnly(r.t);
    await insertRecords(url, project, records);
  } catch { /* the database being unreachable must not matter */ }
}
