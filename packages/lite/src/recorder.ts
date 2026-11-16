/**
 * The recorder core, shared by the Node runtime (which appends to a local log) and the Workers runtime
 * (which sends to a trickle-lite server). Instrumented code calls `globalThis.__trickle.f(...)` once per
 * module and then `o(point, value)` with each value; the recorder infers its type and merges it with what
 * it has seen at that point.
 *
 * It must never change what the program does: every value is passed straight back, getters are never
 * called, and any failure inside the recorder is swallowed. No Node APIs here.
 */
import { infer, mergeTy, quickKind, shrink, tyHash, type Ty } from './types.js';
import { decodePoints, type Point } from './points.js';

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

export interface Rec {
  w: string; f: string; h: string; i: number; x: number; at: number;
  /** Only on full records (the type changed). */
  k?: Point['k']; n?: string; l?: number; c?: number; hl?: number; hc?: number; fn?: string; a?: 1; ann?: 1; t?: Ty;
  /** Calls since this writer's previous record for the point (x is the running total). */
  dx?: number;
}

export interface RecorderOptions {
  writer: string;
  /** Keep nothing derived from values' content (see infer). */
  typesOnly?: boolean;
  /** Called when a point's first type is ready, so the sink can write it promptly. */
  onFirst?: () => void;
}

export class Recorder {
  readonly writer: string;
  private readonly files = new Map<string, Slot[]>();
  private readonly all: Slot[] = [];
  private readonly dirty = new Set<Slot>();
  private busy = false;

  constructor(private readonly opts: RecorderOptions) {
    this.writer = opts.writer;
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
        const ty = shrink(mergeTy(slot.ty, infer(v, 400, this.opts.typesOnly)));
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
    if (first) this.opts.onFirst?.();
  }

  /** Records for changed types, and refreshed counts older than `countMs` (all counts when 0). */
  take(countMs: number): Rec[] {
    const now = Date.now();
    const out: Rec[] = [];
    const emit = (s: Slot, full: boolean) => {
      const p = s.point;
      const rec: Rec = { w: this.writer, f: s.file, h: s.hash, i: p.i, x: s.count, dx: s.count - s.written, at: now };
      if (full) {
        Object.assign(rec, { k: p.k, n: p.n, l: p.l, c: p.c, hl: p.hl, hc: p.hc, t: s.ty });
        if (p.fn) rec.fn = p.fn;
        if (p.a) rec.a = 1;
        if (p.ann) rec.ann = 1;
      }
      out.push(rec);
      s.written = s.count;
      s.writtenAt = now;
    };
    for (const s of this.dirty) emit(s, true);
    this.dirty.clear();
    for (const s of this.all) {
      if (s.count !== s.written && s.ty.length && now - s.writtenAt >= countMs) emit(s, false);
    }
    return out;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __trickle: Recorder | undefined;
}
