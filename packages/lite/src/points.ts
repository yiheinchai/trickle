/** Observation points, shared by the instrumenter and the (TypeScript-free) runtime. */

export type Kind = 'v' | 'p' | 'r';

/** One observation point. Lines are 1-based, columns 0-based. */
export interface Point {
  i: number;
  k: Kind;
  /** Variable or parameter name; for returns, the function name. */
  n: string;
  l: number;
  c: number;
  /** Where to show the hint. */
  hl: number;
  hc: number;
  /** Enclosing function. */
  fn?: string;
  /** Return of an async function: record the resolved value. */
  a?: 1;
  /** The source declares this type explicitly. */
  ann?: 1;
}

/** Decode the metadata emitted into instrumented files. */
export function decodePoints(meta: unknown[][]): Point[] {
  return meta.map((m, i) => {
    const [k, n, l, c, hl, hc, fn, flags] = m as [Kind, string, number, number, number, number, string, number];
    const p: Point = { i, k, n, l, c, hl, hc };
    if (fn) p.fn = fn;
    if (flags & 1) p.a = 1;
    if (flags & 2) p.ann = 1;
    return p;
  });
}
