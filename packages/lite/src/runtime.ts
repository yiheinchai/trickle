/**
 * The in-process recorder. Instrumented code calls `globalThis.__trickle.o(...)`
 * with each observed value; the recorder infers its type, merges it with what it
 * has seen at that point, and appends changes to its observations log (see dataDir).
 *
 * It must never change what the program does: every value is passed straight
 * back, getters are never called, and any failure inside the recorder is swallowed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { infer, mergeTy, quickKind, shrink, tyHash, type Ty } from './types.js';
import { decodePoints, type Point } from './points.js';
import { dataDir, ensureDataDir, findRoot, OBS_FILE } from './common.js';

interface Slot {
  file: string;
  hash: string;
  point: Point;
  ty: Ty;
  tyHash: string;
  kinds: Set<string>;
  count: number;
  written: number; // count at last write
  writtenAt: number;
}

const FULL_INFER_CALLS = 300;
const SAMPLE_EVERY = 16;
const COUNT_REFRESH_MS = 3000;

class Recorder {
  readonly writer = `${process.pid}-${threadId}-${Math.random().toString(36).slice(2, 7)}`;
  private readonly files = new Map<string, Slot[]>();
  private readonly all: Slot[] = [];
  private readonly dirty = new Set<Slot>();
  private scheduled = false;
  private busy = false;
  private readonly out: string;
  private ready = false;

  constructor(private readonly root: string) {
    this.out = path.join(dataDir(root), OBS_FILE);
    const timer = setInterval(() => this.flush(false), 1000);
    timer.unref?.();
    process.on('exit', () => this.flush(true));
  }

  /**
   * Called once per instrumented module (and module instance). Returns the module's handle, whose
   * `o(point, value)` instrumented code calls with each observed value.
   */
  f(file: string, hash: string, meta: () => unknown[][]): { o(i: number, v: unknown): unknown } {
    const key = file + '#' + hash;
    let slots = this.files.get(key);
    if (!slots) {
      slots = decodePoints(meta()).map((point) => ({
        file, hash, point, ty: [], tyHash: '', kinds: new Set<string>(), count: 0, written: 0, writtenAt: 0,
      }));
      this.files.set(key, slots);
      this.all.push(...slots);
    }
    const s = slots;
    return { o: (i, v) => this.o(s[i], v) };
  }

  private o(slot: Slot | undefined, v: unknown): unknown {
    if (this.busy || !slot) return v;
    this.busy = true;
    try {
      if (slot.point.a && v !== null && typeof v === 'object' && typeof (v as PromiseLike<unknown>).then === 'function') {
        // The resolved value of an async function's `return`. The async function's own promise adopts
        // `v` anyway, so handling it here changes nothing the caller can observe.
        (v as Promise<unknown>).then((r) => this.observe(slot, r), () => {}).catch(() => {});
      } else this.observe(slot, v);
    } catch { /* never let observation break the program */ }
    this.busy = false;
    return v;
  }

  private observe(slot: Slot, v: unknown) {
    const wasBusy = this.busy;
    this.busy = true;
    try {
      slot.count++;
      const kind = quickKind(v);
      // Every value's top-level kind is checked, so a rare undefined or null is never missed; full inference
      // runs for the first calls and then on a thinning sample.
      const n = slot.count;
      const full = n <= FULL_INFER_CALLS || !slot.kinds.has(kind) ||
        (n & (n < 10_000 ? SAMPLE_EVERY - 1 : n < 1_000_000 ? 255 : 4095)) === 0;
      if (full) {
        slot.kinds.add(kind);
        const ty = shrink(mergeTy(slot.ty, infer(v)));
        const h = tyHash(ty);
        if (h !== slot.tyHash) {
          slot.ty = ty;
          slot.tyHash = h;
          this.markDirty(slot);
        }
      }
    } catch { /* ignore */ }
    this.busy = wasBusy;
  }

  private markDirty(slot: Slot) {
    const first = slot.writtenAt === 0 && !this.dirty.has(slot);
    this.dirty.add(slot);
    // A point's first type is written at the end of the current task, so it shows up at once and survives a
    // worker that is killed between tests; later refinements wait for the next timer tick, so a type that is
    // still settling (new literals, new shapes) is written once rather than once per change.
    if (first && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => this.flush(false));
    }
  }

  /** Append changed types, and refreshed counts every few seconds (or always, when `all`). */
  flush(all: boolean) {
    this.scheduled = false;
    const now = Date.now();
    const lines: string[] = [];
    const emit = (s: Slot, full: boolean) => {
      const p = s.point;
      // A changed type is written in full; a count refresh only carries the count.
      const rec: Record<string, unknown> = full
        ? { w: this.writer, f: s.file, h: s.hash, i: p.i, k: p.k, n: p.n, l: p.l, c: p.c, hl: p.hl, hc: p.hc, x: s.count, at: now, t: s.ty }
        : { w: this.writer, f: s.file, h: s.hash, i: p.i, x: s.count, at: now };
      if (full) {
        if (p.fn) rec.fn = p.fn;
        if (p.a) rec.a = 1;
        if (p.ann) rec.ann = 1;
      }
      lines.push(JSON.stringify(rec));
      s.written = s.count;
      s.writtenAt = now;
    };
    for (const s of this.dirty) emit(s, true);
    this.dirty.clear();
    for (const s of this.all) {
      if (s.count !== s.written && s.ty.length && (all || now - s.writtenAt > COUNT_REFRESH_MS)) emit(s, false);
    }
    if (!lines.length) return;
    try {
      if (!this.ready) {
        ensureDataDir(this.root);
        this.ready = true;
      }
      fs.appendFileSync(this.out, lines.join('\n') + '\n');
    } catch { /* read-only filesystem: drop */ }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __trickle: Recorder | undefined;
}

if (!globalThis.__trickle && process.env.TRICKLE_DISABLE !== '1') {
  const root = findRoot();
  process.env.TRICKLE_ROOT ??= root;
  globalThis.__trickle = new Recorder(root);
}

export {};
