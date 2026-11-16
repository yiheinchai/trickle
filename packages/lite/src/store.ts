/**
 * Read the observations log (appended to by any number of processes)
 * into one merged view per observation point. Reading is incremental, so a
 * watcher can call `update()` whenever the file grows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { mergeTy, type Ty } from './types.js';
import type { Point } from './points.js';
import { dataDir, hashText, OBS_FILE } from './common.js';

export interface Observation {
  file: string;
  /** Hash of the file's source when it was observed. */
  hash: string;
  point: Point;
  ty: Ty;
  count: number;
  at: number;
}

interface Rec {
  w: string; f: string; h: string; i: number; k: Point['k']; n: string; l: number; c: number; hl: number; hc: number;
  fn?: string; a?: 1; ann?: 1; x: number; at: number; t: Ty;
}

export class Store {
  readonly path: string;
  private offset = 0;
  private ino = 0;
  private partial = '';
  /** file -> hash -> point index -> writer -> latest record */
  private readonly recs = new Map<string, Map<string, Map<number, Map<string, Rec>>>>();
  /** file -> hash of the most recent observation */
  private readonly latest = new Map<string, { hash: string; at: number }>();
  private cache = new Map<string, Observation[]>();

  constructor(private readonly root: string) {
    this.path = path.join(dataDir(root), OBS_FILE);
  }

  /** Read anything appended since the last call. Returns the files whose observations changed. */
  update(): Set<string> {
    const changed = new Set<string>();
    let size = 0, ino = 0;
    try { const st = fs.statSync(this.path); size = st.size; ino = st.ino; } catch { /* none yet */ }
    if (size < this.offset || (this.ino && ino !== this.ino)) this.reset(changed); // cleared or replaced
    this.ino = ino;
    if (size === this.offset) return changed;
    const fd = fs.openSync(this.path, 'r');
    try {
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const text = this.partial + buf.toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        let r: Rec;
        try { r = JSON.parse(line); } catch { continue; }
        if (!r || typeof r.f !== 'string' || typeof r.i !== 'number') continue;
        this.add(r);
        changed.add(r.f);
      }
    } finally {
      fs.closeSync(fd);
    }
    if (changed.size) for (const k of [...this.cache.keys()]) if (changed.has(k.slice(0, k.lastIndexOf('#')))) this.cache.delete(k);
    return changed;
  }

  private reset(changed: Set<string>) {
    for (const f of this.recs.keys()) changed.add(f);
    this.recs.clear();
    this.latest.clear();
    this.cache.clear();
    this.offset = 0;
    this.partial = '';
  }

  private add(r: Rec) {
    let byHash = this.recs.get(r.f);
    if (!byHash) this.recs.set(r.f, (byHash = new Map()));
    let byPoint = byHash.get(r.h);
    if (!byPoint) byHash.set(r.h, (byPoint = new Map()));
    let byWriter = byPoint.get(r.i);
    if (!byWriter) byPoint.set(r.i, (byWriter = new Map()));
    const prev = byWriter.get(r.w);
    if (!Array.isArray(r.t)) {
      // A count refresh: applies to the full record this writer already wrote.
      if (prev && prev.at <= r.at) byWriter.set(r.w, { ...prev, x: r.x, at: r.at });
      return;
    }
    if (!prev || prev.at <= r.at) byWriter.set(r.w, r);
    const l = this.latest.get(r.f);
    if (!l || l.at <= r.at) this.latest.set(r.f, { hash: r.h, at: r.at });
  }

  /**
   * Rewrite the log as one record per point (merged across writers), keeping each file's latest version and the
   * version that matches its source on disk now. Only safe when nothing is writing, e.g. after `trickle-lite run`.
   */
  compact(): void {
    this.update();
    const lines: string[] = [];
    for (const file of this.files()) {
      let source: string | undefined;
      try { source = fs.readFileSync(path.join(this.root, file), 'utf8'); } catch { /* gone */ }
      const latest = this.get(file);
      const kept = [latest];
      const current = source === undefined ? undefined : hashText(source);
      if (current !== undefined && current !== latest[0]?.hash && this.recs.get(file)?.has(current)) kept.push(this.get(file, source));
      for (const o of kept.flat()) {
        const p = o.point;
        const rec: Record<string, unknown> = { w: 'merged', f: file, h: o.hash, i: p.i, k: p.k, n: p.n, l: p.l, c: p.c, hl: p.hl, hc: p.hc, x: o.count, at: o.at, t: o.ty };
        if (p.fn) rec.fn = p.fn;
        if (p.a) rec.a = 1;
        if (p.ann) rec.ann = 1;
        lines.push(JSON.stringify(rec));
      }
    }
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '');
    fs.renameSync(tmp, this.path);
    const changed = new Set<string>();
    this.reset(changed);
    this.update();
  }

  files(): string[] {
    return [...this.recs.keys()].sort();
  }

  /**
   * Observations for a file. Given the file's current source, they come from the version observed with exactly
   * that source when there is one: observations from several machines or deploys can mix versions of a file,
   * and positions are only meaningful in the version they were taken from. Otherwise (or without a source),
   * from the most recently observed version; its positions may no longer match (see `locate`).
   */
  get(file: string, source?: string): Observation[] {
    const versions = this.recs.get(file);
    const current = source === undefined ? undefined : hashText(source);
    const hash = current !== undefined && versions?.has(current) ? current : this.latest.get(file)?.hash;
    const cacheKey = file + '#' + hash;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const byPoint = hash === undefined ? undefined : versions?.get(hash);
    const out: Observation[] = [];
    if (byPoint && hash !== undefined) {
      for (const byWriter of byPoint.values()) {
        let ty: Ty = [];
        let count = 0;
        let at = 0;
        let last: Rec | undefined;
        for (const r of byWriter.values()) {
          ty = mergeTy(ty, r.t);
          count += r.x;
          if (r.at >= at) { at = r.at; last = r; }
        }
        if (!last) continue;
        const point: Point = { i: last.i, k: last.k, n: last.n, l: last.l, c: last.c, hl: last.hl, hc: last.hc };
        if (last.fn) point.fn = last.fn;
        if (last.a) point.a = 1;
        if (last.ann) point.ann = 1;
        out.push({ file, hash, point, ty, count, at });
      }
    }
    out.sort((a, b) => a.point.l - b.point.l || a.point.c - b.point.c);
    this.cache.set(cacheKey, out);
    return out;
  }
}

/**
 * Find where an observed point is in the current text of its file, which may have been edited since.
 * Returns the 1-based line and 0-based column of the name, or undefined if it can no longer be found.
 */
export function locate(lines: string[], p: Point): { line: number; col: number; exact: boolean } | undefined {
  const at = lines[p.l - 1];
  const name = p.n.split('.').pop()!;
  if (p.n === '(anonymous)') return at !== undefined ? { line: p.l, col: p.c, exact: true } : undefined;
  if (at !== undefined && at.startsWith(name, p.c) && !/[\w$]/.test(at[p.c + name.length] ?? '')) {
    return { line: p.l, col: p.c, exact: true };
  }
  const re = new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, '\\$')}(?![\\w$])`);
  for (let d = 0; d <= 40; d++) {
    for (const line of d === 0 ? [p.l] : [p.l - d, p.l + d]) {
      const text = lines[line - 1];
      if (text === undefined) continue;
      const m = re.exec(text);
      if (m) return { line, col: m.index, exact: false };
    }
  }
  return undefined;
}
