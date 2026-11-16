export interface Lesson { id: string; tags: string[]; kind: "skill" | "rule"; score?: number }
export type Op = { op: "append"; text: string } | { op: "file"; path: string; content: string | null };

export function parse(raw: string): Lesson {
  const data = JSON.parse(raw) as Lesson;
  const { id, tags } = data;
  let n: number = tags?.length ?? 0;
  n = n + 1;
  return data;
}

export const double = (x: number): number => x * 2;

export async function load(ids: string[]): Promise<Lesson[]> {
  const out: Lesson[] = [];
  for (const id of ids) out.push(parse(`{"id":"${id}","tags":null,"kind":"skill","extra":1}`));
  for (const id of ids) {
    const l = parse(`{"id":"${id}","tags":["a"],"kind":"guide"}`);
    out.push(l);
  }
  return out;
}

export function first<T extends { id: string }>(items: T[]): T | undefined {
  const it = items[0];
  return it;
}

export function apply(ops: Op[]): number {
  let total = 0;
  for (const op of ops) total += op.op === "append" ? op.text.length : op.path.length;
  return total;
}

export const LIMIT = 500;
export const MARKER = "<!-- with spaces -->";
export function untyped(x: any) {
  const y = x.value;
  return y;
}
export function dated(d: Date, m: Map<string, number>): number {
  return d.getTime() + m.size;
}
export function firstWord(s: string): string {
  const m = /^(\w+)( \w+)?/.exec(s);
  const second: string = m![2] as string;
  return second;
}
