/**
 * The runtime type model: infer a type from a value, merge observations into a
 * union, and render it as TypeScript text.
 *
 * A type is a list of union members. Members are small JSON objects, so they
 * can be written to the observations log and read back unchanged.
 */

export type Member =
  | { k: 'undefined' }
  | { k: 'null' }
  | { k: 'string'; lits?: string[] } // lits: short enum-like values seen; absent once widened
  | { k: 'number' }
  | { k: 'boolean'; lits?: boolean[] }
  | { k: 'bigint' }
  | { k: 'symbol' }
  | { k: 'function'; ctor?: true }
  | { k: 'array'; el: Ty; re?: true } // el = [] for an empty array; re: a RegExp match (index, input, groups)
  | { k: 'object'; cls?: string; props: Record<string, Ty>; opt?: string[]; methods?: string[]; more?: true; dict?: Ty } // dict: keys not kept, values' type
  | { k: 'instance'; cls: string; args?: Ty[] } // Date, Map<K, V>, Promise, ...
  | { k: 'any'; why?: string }; // depth/budget cut, cycles, proxies, getters

export type Ty = Member[];

const MAX_LITERALS = 6;
const MAX_OBJECT_SHAPES = 8;
const MAX_PROPS = 40;
const MAX_ARRAY_SAMPLE = 16;
const MAX_DEPTH = 5;
const MAX_METHODS = 30;

// Short, enum-like strings only: no spaces or @, so names, emails and prose are never kept.
const LITERAL_RE = /^[A-Za-z0-9_\-.:/]{1,24}$/;
const SENSITIVE_KEY_RE = /token|secret|passw|apikey|api_key|auth|cookie|session|email|credential|private|signature|card/i;

const BUILTIN_CLASSES = new Set([
  'Date', 'RegExp', 'Promise', 'URL', 'URLSearchParams', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Uint8ClampedArray', 'Buffer', 'WeakMap', 'WeakSet',
  'WeakRef', 'AbortController', 'AbortSignal', 'Headers', 'Request', 'Response', 'ReadableStream',
  'WritableStream', 'TextEncoder', 'TextDecoder', 'Blob', 'FormData',
]);

let isProxy: (v: unknown) => boolean = () => false;
try {
  // node:util is available in Node and in VS Code's extension host; guarded for other hosts.
  const util = (globalThis as any).process?.getBuiltinModule?.('node:util');
  if (util?.types?.isProxy) isProxy = util.types.isProxy;
} catch { /* not Node */ }

interface InferState { budget: number; seen: WeakSet<object>; typesOnly: boolean }

// In types-only mode a property name is kept only if it looks like code (an identifier), not data.
const CODE_KEY_RE = /^[A-Za-z_$][A-Za-z_$]*[0-9]{0,2}[A-Za-z_$]*$/;
const isCodeKey = (k: string) => k.length <= 40 && CODE_KEY_RE.test(k);

/**
 * Infer the runtime type of a value. `budget` bounds the work per value. With `typesOnly`, nothing
 * derived from a value's content is kept: no string or boolean literals, and objects whose keys do not
 * look like identifiers (IDs, emails, file names) become `{ [key: string]: T }` with the keys dropped.
 */
export function infer(value: unknown, budget = 400, typesOnly = false): Ty {
  return [inferMember(value, { budget, seen: new WeakSet(), typesOnly }, 0, '')];
}

/** The cheap top-level kind of a value, used to notice new variants on hot paths without full inference. */
export function quickKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t !== 'object') return t;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? 'object' : 'object:' + (proto?.constructor?.name ?? '?');
}

function inferMember(v: unknown, st: InferState, depth: number, key: string): Member {
  st.budget--;
  switch (typeof v) {
    case 'undefined': return { k: 'undefined' };
    case 'number': return { k: 'number' };
    case 'bigint': return { k: 'bigint' };
    case 'symbol': return { k: 'symbol' };
    case 'boolean': return st.typesOnly ? { k: 'boolean' } : { k: 'boolean', lits: [v] };
    case 'string':
      return !st.typesOnly && LITERAL_RE.test(v) && !SENSITIVE_KEY_RE.test(key) ? { k: 'string', lits: [v] } : { k: 'string' };
    case 'function': {
      let src = '';
      try { src = Function.prototype.toString.call(v); } catch { /* native */ }
      return src.startsWith('class') ? { k: 'function', ctor: true } : { k: 'function' };
    }
  }
  if (v === null) return { k: 'null' };
  const obj = v as object;
  if (isProxy(obj)) return { k: 'any', why: 'proxy' };
  if (st.seen.has(obj)) return { k: 'any', why: 'cycle' };
  if (depth >= MAX_DEPTH || st.budget <= 0) return { k: 'any', why: 'depth' };
  st.seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const re = Object.prototype.hasOwnProperty.call(obj, 'index') && Object.prototype.hasOwnProperty.call(obj, 'input');
      let el: Ty = [];
      const n = obj.length;
      const idx: number[] = [];
      for (let i = 0; i < Math.min(n, MAX_ARRAY_SAMPLE); i++) idx.push(i);
      if (n > MAX_ARRAY_SAMPLE) idx.push(n - 1);
      for (const i of idx) {
        if (st.budget <= 0) { el = mergeTy(el, [{ k: 'any', why: 'budget' }]); break; }
        el = mergeTy(el, [inferMember(obj[i], st, depth + 1, key)]);
      }
      return re ? { k: 'array', el, re: true } : { k: 'array', el };
    }
    const proto = Object.getPrototypeOf(obj);
    const ctorName: string | undefined = proto && proto !== Object.prototype ? safeName(proto) : undefined;
    if (ctorName === 'Map' || ctorName === 'Set') {
      let a: Ty = [], b: Ty = [];
      let i = 0;
      for (const entry of obj as Map<unknown, unknown> | Set<unknown>) {
        if (i++ >= MAX_ARRAY_SAMPLE || st.budget <= 0) break;
        if (ctorName === 'Map') {
          const [ek, ev] = entry as [unknown, unknown];
          a = mergeTy(a, [inferMember(ek, st, depth + 1, '')]);
          b = mergeTy(b, [inferMember(ev, st, depth + 1, '')]);
        } else a = mergeTy(a, [inferMember(entry, st, depth + 1, '')]);
      }
      return { k: 'instance', cls: ctorName, args: ctorName === 'Map' ? [a, b] : [a] };
    }
    if (ctorName && BUILTIN_CLASSES.has(ctorName)) return { k: 'instance', cls: ctorName };
    if (obj instanceof Error) return { k: 'instance', cls: 'Error' };
    const keys = Object.keys(obj);
    // Nothing enumerable but own properties all the same (defined non-enumerable): its shape is not visible.
    if (keys.length === 0 && Object.getOwnPropertyNames(obj).length > 0) return { k: 'any', why: 'opaque' };
    if (st.typesOnly && !keys.every(isCodeKey)) {
      let dict: Ty = [];
      for (const name of keys.slice(0, MAX_ARRAY_SAMPLE)) {
        const d = Object.getOwnPropertyDescriptor(obj, name);
        dict = mergeTy(dict, [d && 'value' in d ? inferMember(d.value, st, depth + 1, '') : { k: 'any', why: 'getter' }]);
      }
      const m: Member = { k: 'object', props: {}, dict };
      if (ctorName) m.cls = ctorName;
      return m;
    }
    const props: Record<string, Ty> = {};
    let count = 0, more = false;
    for (const name of keys) {
      if (count++ >= MAX_PROPS) { more = true; break; }
      const d = Object.getOwnPropertyDescriptor(obj, name);
      if (!d) continue;
      // Never call getters: reading them can have side effects.
      props[name] = 'value' in d ? [inferMember(d.value, st, depth + 1, name)] : [{ k: 'any', why: 'getter' }];
    }
    const m: Member = { k: 'object', props };
    if (ctorName) {
      m.cls = ctorName;
      const methods = protoMethods(proto);
      if (methods.length) m.methods = methods;
    }
    if (more) m.more = true;
    return m;
  } finally {
    st.seen.delete(obj);
  }
}

function safeName(proto: object): string | undefined {
  try {
    const c = (proto as { constructor?: { name?: unknown } }).constructor;
    return typeof c?.name === 'string' && c.name ? c.name : 'Object';
  } catch { return undefined; }
}

function protoMethods(proto: object | null): string[] {
  const out = new Set<string>();
  while (proto && proto !== Object.prototype && out.size < MAX_METHODS) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (d && (typeof d.value === 'function' || d.get)) out.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...out].sort();
}

// ── Merging ────────────────────────────────────────────────────────────────

function memberKey(m: Member): string {
  switch (m.k) {
    case 'object': return 'object:' + (m.cls ?? '') + ':' + shapeKey(m, 3);
    case 'instance': return 'instance:' + m.cls;
    case 'function': return m.ctor ? 'class' : 'function';
    case 'array': return m.re ? 'array:re' : 'array';
    default: return m.k;
  }
}

/** Keys, and the keys of nested objects: objects merge only with the same shape, so correlated variants stay apart. */
function shapeKey(m: Extract<Member, { k: 'object' }>, depth: number): string {
  if (m.dict) return '[dict]';
  return Object.keys(m.props).sort().map((key) => {
    const t = m.props[key]!;
    const inner = depth > 1 && t.length === 1 && t[0]!.k === 'object' ? `{${shapeKey(t[0]!, depth - 1)}}` : '';
    return key + inner;
  }).join(',');
}

/** Union two types. Objects stay separate per key set (so discriminated unions survive) up to a limit. */
export function mergeTy(a: Ty, b: Ty): Ty {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out: Member[] = a.slice();
  for (const m of b) {
    if (m.k === 'any' && out.some((x) => x.k === 'any')) continue;
    const key = memberKey(m);
    const i = out.findIndex((x) => memberKey(x) === key);
    if (i === -1) out.push(m);
    else out[i] = mergeMember(out[i]!, m);
  }
  return collapseObjects(out);
}

function mergeMember(a: Member, b: Member): Member {
  if (a.k === 'string' && b.k === 'string') {
    if (!a.lits || !b.lits) return { k: 'string' };
    const lits = [...new Set([...a.lits, ...b.lits])];
    return lits.length > MAX_LITERALS ? { k: 'string' } : { k: 'string', lits };
  }
  if (a.k === 'boolean' && b.k === 'boolean') {
    const lits = [...new Set([...(a.lits ?? [true, false]), ...(b.lits ?? [true, false])])];
    return lits.length >= 2 ? { k: 'boolean' } : { k: 'boolean', lits };
  }
  if (a.k === 'array' && b.k === 'array') return a.re ? { k: 'array', el: mergeTy(a.el, b.el), re: true } : { k: 'array', el: mergeTy(a.el, b.el) };
  if (a.k === 'instance' && b.k === 'instance' && a.args && b.args) {
    return { k: 'instance', cls: a.cls, args: a.args.map((x, i) => mergeTy(x, b.args![i] ?? [])) };
  }
  if (a.k === 'object' && b.k === 'object') return mergeObjects(a, b);
  return a;
}

function mergeObjects(a: Obj, b: Obj): Member {
  const props: Record<string, Ty> = {};
  const opt = new Set([...(a.opt ?? []), ...(b.opt ?? [])]);
  for (const key of new Set([...Object.keys(a.props), ...Object.keys(b.props)])) {
    const x = a.props[key], y = b.props[key];
    props[key] = x && y ? mergeTy(x, y) : (x ?? y)!;
    if (!x || !y) opt.add(key);
  }
  const m: Member = { k: 'object', props };
  if (a.cls) m.cls = a.cls;
  if (opt.size) m.opt = [...opt].sort();
  const methods = [...new Set([...(a.methods ?? []), ...(b.methods ?? [])])].sort();
  if (methods.length) m.methods = methods;
  if (a.more || b.more) m.more = true;
  if (a.dict || b.dict) m.dict = mergeTy(a.dict ?? [], b.dict ?? []);
  return m;
}

type Obj = Extract<Member, { k: 'object' }>;

/**
 * Too many object shapes of one class: merge them. Objects that share a discriminant (a property whose value is
 * always one string literal, like `kind` or `op`) are merged per discriminant value, so a discriminated union
 * stays a union of its variants; without one, they merge into a single shape with optional properties.
 */
function collapseObjects(ms: Member[]): Member[] {
  const byClass = new Map<string, Obj[]>();
  for (const m of ms) if (m.k === 'object') byClass.set(m.cls ?? '', [...(byClass.get(m.cls ?? '') ?? []), m]);
  if (![...byClass.values()].some((list) => list.length > MAX_OBJECT_SHAPES)) return ms;
  const out: Member[] = ms.filter((m) => m.k !== 'object' || (byClass.get(m.cls ?? '')?.length ?? 0) <= MAX_OBJECT_SHAPES);
  for (const list of byClass.values()) {
    if (list.length <= MAX_OBJECT_SHAPES) continue;
    const disc = Object.keys(list[0]!.props).find((key) => list.every((o) => {
      const t = o.props[key];
      return t?.length === 1 && t[0]!.k === 'string' && !!t[0]!.lits?.length;
    }));
    const groups = new Map<string, Obj>();
    for (const o of list) {
      // An object whose discriminant already holds several values stands for one variant per value.
      const values = disc ? (o.props[disc]![0] as { lits: string[] }).lits : [''];
      for (const value of values) {
        const variant: Obj = disc ? { ...o, props: { ...o.props, [disc]: [{ k: 'string', lits: [value] }] } } : o;
        const prev = groups.get(value);
        groups.set(value, prev ? (mergeObjects(prev, variant) as Obj) : variant);
      }
    }
    if (groups.size > MAX_OBJECT_SHAPES * 2) out.push(list.reduce((a, b) => mergeObjects(a, b) as Obj));
    else out.push(...groups.values());
  }
  return out;
}

const MAX_TYPE_CHARS = 6000;

/** Keep a recorded type small: past MAX_TYPE_CHARS of JSON, cut nested structure at shallower depths. */
export function shrink(t: Ty): Ty {
  for (let depth = 4; depth >= 1 && JSON.stringify(t).length > MAX_TYPE_CHARS; depth--) t = cut(t, depth);
  return t;
}

function cut(t: Ty, depth: number): Ty {
  return t.map((m): Member => {
    if (m.k === 'array') return depth <= 0 ? { k: 'any', why: 'size' } : { ...m, el: cut(m.el, depth - 1) };
    if (m.k === 'object') {
      if (depth <= 0) return { k: 'any', why: 'size' };
      const props: Record<string, Ty> = {};
      for (const [key, v] of Object.entries(m.props)) props[key] = cut(v, depth - 1);
      return { ...m, props };
    }
    return m;
  }).filter((m, i, all) => m.k !== 'any' || all.findIndex((x) => x.k === 'any') === i);
}

/** A stable fingerprint, used to notice when a point's type has changed. */
export function tyHash(t: Ty): string {
  const s = JSON.stringify(t);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + s.length.toString(36);
}

// ── Rendering ──────────────────────────────────────────────────────────────

export interface RenderOptions {
  /** 'ts' renders a type that TypeScript can check; 'short' a one-line hint; 'pretty' an indented hover. */
  mode: 'ts' | 'short' | 'pretty';
  maxDepth?: number;
  maxProps?: number;
  /**
   * In 'ts' mode, a type expression for the declared type at this position (e.g. `typeof lesson`).
   * Where the runtime record is less precise than the declaration (a string whose value was not kept,
   * a Date, an array that may be a tuple), the declared type is trusted for that part only, through
   * helper types that check.ts declares.
   */
  ctx?: string;
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

type Opts = Required<Omit<RenderOptions, 'ctx'>>;

export function render(t: Ty, opts: RenderOptions): string {
  const o: Opts = { maxDepth: opts.mode === 'short' ? 2 : 6, maxProps: opts.mode === 'short' ? 4 : 1000, ...opts };
  return renderTy(t, o, 0, 0, opts.mode === 'ts' ? opts.ctx : undefined);
}

function renderTy(t: Ty, o: Opts, depth: number, indent: number, ctx: string | undefined): string {
  if (t.length === 0) return 'never';
  const parts: string[] = [];
  for (const m of t) {
    if (m.k === 'string' && m.lits && o.mode !== 'ts' && m.lits.length > 3) parts.push('string');
    else if (m.k === 'string' && m.lits) parts.push(...m.lits.map((s) => JSON.stringify(s)));
    else if (m.k === 'boolean' && m.lits && m.lits.length === 1) parts.push(String(m.lits[0]));
    else parts.push(renderMember(m, o, depth, indent, ctx));
  }
  const uniq = [...new Set(parts)];
  if (o.mode === 'short' && uniq.length > 5) return uniq.slice(0, 4).join(' | ') + ' | …';
  return uniq.join(' | ');
}

/** Parenthesise a type that has a top-level union or function arrow, so `T[]` binds correctly. */
function wrap(s: string): string {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if ('{[(<'.includes(ch)) depth++;
    else if ('}])>'.includes(ch) && !(ch === '>' && s[i - 1] === '=')) depth--;
    else if (depth === 0 && (ch === '|' || ch === '&' || (ch === '=' && s[i + 1] === '>'))) return `(${s})`;
  }
  return s;
}

const BINARY = new Set(['Buffer', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Uint8ClampedArray', 'Blob']);

const INSTANCE_TS: Record<string, string> = { Promise: 'Promise<any>', Map: 'Map<any, any>', Set: 'Set<any>', WeakMap: 'WeakMap<any, any>', WeakSet: 'WeakSet<any>', WeakRef: 'WeakRef<any>' };

function renderMember(m: Member, o: Opts, depth: number, indent: number, ctx: string | undefined): string {
  switch (m.k) {
    case 'string':
      return ctx ? `__TrickleS<${ctx}>` : 'string';
    case 'number':
      return ctx ? `__TrickleN<${ctx}>` : 'number';
    case 'boolean':
      return ctx ? `__TrickleBo<${ctx}>` : 'boolean';
    case 'undefined': case 'null': case 'bigint': case 'symbol':
      return m.k;
    case 'any':
      return 'any';
    case 'function':
      if (o.mode !== 'ts') return m.ctor ? 'class' : 'Function';
      return m.ctor ? '(abstract new (...args: any) => any)' : '((...args: any[]) => any)';
    case 'array': {
      if (o.mode !== 'ts') {
        if (m.re) return 'RegExpMatch ' + (depth >= o.maxDepth || !m.el.length ? '[…]' : wrap(renderTy(m.el, o, depth + 1, indent, undefined)) + '[]');
        if (m.el.length === 0) return '[]';
        if (depth >= o.maxDepth) return '[…]';
        return wrap(renderTy(m.el, o, depth + 1, indent, undefined)) + '[]';
      }
      const el = m.el.length === 0 ? 'never' : depth >= o.maxDepth ? 'any'
        : renderTy(m.el, o, depth + 1, indent, ctx && `__TrickleEl<${ctx}>`);
      // An array declared as a RegExp match is trusted (lib.d.ts types unmatched groups as string, and
      // String#match with /g as a match); declared as anything else, e.g. string[], its elements are checked.
      if (ctx) return `__TrickleX<${ctx}, ${el}>`;
      return m.re ? 'RegExpExecArray' : wrap(el) + '[]';
    }
    case 'instance': {
      if (o.mode === 'ts') {
        const cls = INSTANCE_TS[m.cls] ?? m.cls;
        // Binary data (Buffer, typed arrays) is accepted by many declared types (BodyInit, ArrayBufferView...)
        // that its lib.d.ts type is not formally assignable to; trust any object type declared for it.
        if (ctx && BINARY.has(m.cls)) return `__TrickleO<${ctx}, ${cls}>`;
        return ctx ? `__TrickleB<${ctx}, ${cls}>` : cls;
      }
      if (m.cls === 'Map' || m.cls === 'Set') {
        const args = (m.args ?? []).map((a) => (a.length && depth < o.maxDepth ? renderTy(a, o, depth + 1, indent, undefined) : 'unknown'));
        return `${m.cls}<${args.join(', ')}>`;
      }
      return m.cls;
    }
    case 'object': {
      if (m.dict) {
        // Keys were not kept: as a check, trusted to be whatever object type is declared.
        const v = depth >= o.maxDepth ? 'any' : renderTy(m.dict.length ? m.dict : [{ k: 'any' }], o, depth + 1, indent, undefined);
        if (o.mode !== 'ts') return `${m.cls ? m.cls + ' ' : ''}{ [key]: ${v} }`;
        return ctx ? `__TrickleO<${ctx}, { [key: string]: ${v} }>` : `{ [key: string]: ${v} }`;
      }
      const keys = Object.keys(m.props);
      if (depth >= o.maxDepth) return o.mode === 'ts' ? 'any' : (m.cls ?? '{…}');
      const opt = new Set(m.opt ?? []);
      const entries: string[] = [];
      const shown = keys.slice(0, o.maxProps);
      for (const key of shown) {
        const name = IDENT_RE.test(key) ? key : JSON.stringify(key);
        const sub = ctx && `__TrickleProp<${ctx}, ${JSON.stringify(key)}>`;
        entries.push(`${name}${opt.has(key) ? '?' : ''}: ${renderTy(m.props[key]!, o, depth + 1, indent + 1, sub)}`);
      }
      if (o.mode === 'ts') {
        for (const name of m.methods ?? []) if (!(name in m.props)) entries.push(`${JSON.stringify(name)}: any`);
        if (m.more) entries.push('[key: string]: any');
      } else if (keys.length > shown.length || m.more) entries.push('…');
      const prefix = o.mode !== 'ts' && m.cls ? m.cls + ' ' : '';
      if (o.mode === 'ts' && (m.cls || m.more) && ctx) {
        // A class instance: its declared type may have type-only members (Zod's _output, Drizzle's $inferSelect)
        // and members on the prototype we cannot see, so it is trusted to be any object type the declaration allows.
        // So is an object with too many keys to record (process.env): the missing ones may be among those not kept.
        return `__TrickleO<${ctx}, ${entries.length ? `{ ${entries.join('; ')} }` : '{}'}>`;
      }
      if (entries.length === 0) return prefix + '{}';
      if (o.mode === 'pretty') {
        const pad = '  '.repeat(indent + 1);
        return `${prefix}{\n${entries.map((e) => pad + e + ';').join('\n')}\n${'  '.repeat(indent)}}`;
      }
      return `${prefix}{ ${entries.join('; ')} }`;
    }
  }
}

/** Whether a type is only plain objects (so per-property checks make sense). */
export function isObjectOnly(t: Ty): boolean {
  return t.length > 0 && t.every((m) => m.k === 'object' && !m.cls);
}

/** Properties shared by every object member, for per-property checks. */
export function commonProps(t: Ty): Record<string, Ty> {
  const objs = t.filter((m): m is Extract<Member, { k: 'object' }> => m.k === 'object');
  if (objs.length !== t.length || objs.length === 0) return {};
  const out: Record<string, Ty> = {};
  for (const key of Object.keys(objs[0]!.props)) {
    if (objs.every((o) => key in o.props)) {
      out[key] = objs.reduce<Ty>((acc, o) => mergeTy(acc, o.props[key]!), []);
    }
  }
  return out;
}

const KINDS = new Set(['undefined', 'null', 'string', 'number', 'boolean', 'bigint', 'symbol', 'function', 'array', 'object', 'instance', 'any']);
const CLASS_RE = /^[A-Za-z_$][\w$]{0,60}$/;

/**
 * Reduce a type received from elsewhere to types only, whatever the sender did: drop literals, drop keys that
 * do not look like code, drop anything unrecognised. Used by the server before storing, and by the Worker
 * recorder before sending.
 */
export function typesOnly(t: unknown, depth = 0): Ty {
  if (!Array.isArray(t) || depth > 8) return [{ k: 'any' }];
  const out: Member[] = [];
  for (const m of t.slice(0, 16) as Array<Record<string, unknown>>) {
    const k = m?.k;
    if (typeof k !== 'string' || !KINDS.has(k)) continue;
    const cls = typeof m.cls === 'string' && CLASS_RE.test(m.cls) ? m.cls : undefined;
    switch (k) {
      case 'function': out.push(m.ctor ? { k, ctor: true } : { k }); break;
      case 'array': out.push({ k, el: typesOnly(m.el, depth + 1) }); break;
      case 'instance': out.push(cls ? { k, cls } : { k: 'any' }); break;
      case 'object': {
        const props = m.props && typeof m.props === 'object' ? (m.props as Record<string, unknown>) : {};
        const keys = Object.keys(props);
        const obj: Obj = { k, props: {} };
        if (cls) obj.cls = cls;
        if (m.dict !== undefined || !keys.every(isCodeKey)) {
          obj.dict = keys.reduce<Ty>((acc, key) => mergeTy(acc, typesOnly(props[key], depth + 1)), m.dict !== undefined ? typesOnly(m.dict, depth + 1) : []);
        } else {
          for (const key of keys.slice(0, MAX_PROPS)) obj.props[key] = typesOnly(props[key], depth + 1);
          const opt = Array.isArray(m.opt) ? m.opt.filter((x): x is string => typeof x === 'string' && x in obj.props) : [];
          if (opt.length) obj.opt = opt;
          const methods = Array.isArray(m.methods) ? m.methods.filter((x): x is string => typeof x === 'string' && isCodeKey(x)).slice(0, MAX_METHODS) : [];
          if (methods.length) obj.methods = methods;
          if (m.more) obj.more = true;
        }
        out.push(obj);
        break;
      }
      default: out.push({ k } as Member);
    }
  }
  return out;
}
