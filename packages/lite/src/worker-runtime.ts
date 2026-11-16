/**
 * The Cloudflare Workers runtime, bundled into a Worker by `trickle-lite worker`.
 *
 * Records types only: no string or boolean values, and no object keys that look like data (see infer).
 * After each request the Worker's entry calls `flush(env)` through `ctx.waitUntil`, which sends what changed
 * to the trickle-lite server over HTTPS. The server URL and write-only token are Worker secrets, read from
 * `env` at that moment, never part of the bundle. Nothing here can fail a request.
 */
import { Recorder } from './recorder.js';
import { typesOnly } from './types.js';

export interface TrickleEnv {
  TRICKLE_SERVER?: string;
  TRICKLE_INGEST_TOKEN?: string;
  TRICKLE_PROJECT?: string;
}

// A fixed writer id: Workers forbid random values at module scope, and the server does not use writers.
const recorder = (globalThis.__trickle ??= new Recorder({ writer: 'worker', typesOnly: true }));
const MIN_INTERVAL_MS = 2000;
const COUNT_REFRESH_MS = 60_000;
let last = 0;

/** Send changed types (and counts once a minute). Never throws. */
export async function flush(env: TrickleEnv | undefined): Promise<void> {
  try {
    const server = env?.TRICKLE_SERVER, token = env?.TRICKLE_INGEST_TOKEN;
    if (!server || !token) return;
    const url = new URL('/v1/observations', server);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return; // never send in clear
    const now = Date.now();
    if (now - last < MIN_INTERVAL_MS) return;
    const records = recorder.take(COUNT_REFRESH_MS);
    if (!records.length) return;
    last = now;
    // Belt and braces: whatever the recorder produced, only types leave.
    for (const r of records) if (r.t) r.t = typesOnly(r.t);
    await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project: env?.TRICKLE_PROJECT || 'default', records }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* the server being down must not matter */ }
}
