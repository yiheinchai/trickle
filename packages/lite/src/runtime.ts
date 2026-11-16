/**
 * The Node runtime: installs a recorder that appends to this project's local observations log
 * (see dataDir). Loaded by `--import trickle-lite/register` and by the Vitest plugin's setup file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { Recorder } from './recorder.js';
import { dataDir, ensureDataDir, findRoot, OBS_FILE } from './common.js';

if (!globalThis.__trickle && process.env.TRICKLE_DISABLE !== '1') {
  const root = findRoot();
  process.env.TRICKLE_ROOT ??= root;
  const out = path.join(dataDir(root), OBS_FILE);
  let scheduled = false;
  let ready = false;
  const flush = (countMs: number) => {
    scheduled = false;
    const recs = recorder.take(countMs);
    if (!recs.length) return;
    try {
      if (!ready) { ensureDataDir(root); ready = true; }
      fs.appendFileSync(out, recs.map((r) => { const { dx: _, ...rest } = r; return JSON.stringify(rest); }).join('\n') + '\n');
    } catch { /* read-only filesystem: drop */ }
  };
  const recorder = new Recorder({
    writer: `${process.pid}-${threadId}-${Math.random().toString(36).slice(2, 7)}`,
    // A point's first type is written at the end of the current task, so it shows up at once and survives a
    // test worker killed between tests; later refinements wait for the timer, so a settling type is written once.
    onFirst: () => { if (!scheduled) { scheduled = true; queueMicrotask(() => flush(3000)); } },
  });
  const timer = setInterval(() => flush(3000), 1000);
  timer.unref?.();
  process.on('exit', () => flush(0));
  globalThis.__trickle = recorder;
}

export {};
