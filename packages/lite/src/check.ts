/**
 * Drift: compare what ran with what was declared.
 *
 * For every observed point, a shadow copy of the source gets an assertion that
 * the observed runtime type is assignable to the declared type, written in the
 * same scope as the value, e.g. after `const lesson = parse(raw)`:
 *
 *   ;{const __tc4: typeof lesson = null as unknown as ({ id: string; tags: null });}
 *
 * Then the project's own `tsc` runs over the shadow copy. Any error it reports on
 * an assertion is a place where the type contract and reality disagree, explained
 * in TypeScript's own words. Errors in the original code are ignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import MagicString from 'magic-string';
import { analyze, type Kind, type Site } from './instrument.js';
import { Store, locate, type Observation } from './store.js';
import { syncShadow } from './shadow.js';
import { commonProps, isObjectOnly, render } from './types.js';
import { dataDir, DRIFT_FILE, ensureDataDir, hashText } from './common.js';

export type Severity = 'drift' | 'any';

export interface Drift {
  file: string;
  /** 1-based line and 0-based column of the name, in the file as it is now. */
  line: number;
  col: number;
  kind: Kind;
  name: string;
  fn?: string;
  severity: Severity;
  /** One line, for a diagnostic. */
  message: string;
  /** TypeScript's full explanation. */
  detail: string;
  /** The observed runtime type, shortened. */
  runtime: string;
  count: number;
}

export interface Report {
  version: 1;
  root: string;
  generatedAt: string;
  ms: number;
  observedFiles: number;
  checkedPoints: number;
  projects: string[];
  drifts: Drift[];
  /** Things that stopped a project being checked. */
  problems: string[];
  /**
   * Files whose current source was never observed (edited since, or observed from another version elsewhere).
   * Only values at positions that are unchanged were checked in them.
   */
  staleFiles?: string[];
}

// Declared at the end of each checked file. Type aliases and `declare var` are hoisted, so every check can use them.
//  - __TrickleProp / __TrickleEl: the declared type of a property / array element, across the members of a
//    union that have it (null and undefined have none); unknown when none do.
//  - __TrickleS / __TrickleN / __TrickleBo: a string, number or boolean whose value was not kept is trusted to be whichever string or
//    number types the declaration allows (literals, enums, template literals); it is drift only if none are allowed.
//  - __TrickleFit / __TrickleV<n>: an object holding such a string is read against each variant of a declared union in
//    turn (the string then takes that variant's value), and fits if it fits one; see render() in types.ts.
//  - __TrickleB: a built-in instance (Date, Map, typed arrays...) is trusted to match a declared type of that class.
//  - __TrickleO: any other class instance is trusted to be whichever object type is declared (plain objects are
//    checked in full).
//  - __TrickleA: an array checked against a declared tuple is trusted as that tuple.
const HELPERS = '\n;type __TrickleP1<T, K extends PropertyKey> = T extends null | undefined ? never : K extends keyof T ? T[K] : never;' +
  'type __TrickleProp<T, K extends PropertyKey> = [__TrickleP1<T, K>] extends [never] ? unknown : __TrickleP1<T, K>;' +
  'type __TrickleE1<T> = T extends readonly (infer E)[] ? E : never;' +
  'type __TrickleEl<T> = [__TrickleE1<T>] extends [never] ? unknown : __TrickleE1<T>;' +
  'type __TrickleS<D> = [Extract<D, string>] extends [never] ? string : Extract<D, string>;' +
  'type __TrickleBo<D> = [Extract<D, boolean>] extends [never] ? boolean : Extract<D, boolean>;' +
  'type __TrickleN<D> = [Extract<D, number>] extends [never] ? number : Extract<D, number>;' +
  'type __TrickleB<D, C> = [Extract<D, C>] extends [never] ? C : Extract<D, C>;' +
  'type __TrickleO<D, S> = [Extract<D, object>] extends [never] ? S : Extract<D, object>;' +
  'type __TrickleA<D, E> = [Extract<D, readonly unknown[]>] extends [never] ? E[] : number extends Extract<D, readonly unknown[]>["length"] ? E[] : Extract<D, readonly unknown[]>;' +
  'type __TrickleX<D, E> = [Extract<D, RegExpMatchArray>] extends [never] ? __TrickleA<D, E> : Extract<D, RegExpMatchArray>;' +
  'type __TrickleNotAny<T> = 0 extends (1 & T) ? "declared-any" : 0;' +
  'type __TrickleFit<R, F> = [R] extends [never] ? F : R;' +
  'declare var __tt_q: boolean;\n';

const MARKER = /^__t([cpa])(\d+)(?:_(\d+))?/;
const IGNORE = [
  /Cannot find name/, /used before its declaration/, /could be instantiated with/,
  /is private in type/, /is protected in type/, /private identifier/i, /Duplicate identifier '__/,
  // "Weak type" detection: an object with none of an all-optional type's properties still conforms to it.
  /has no properties in common with type/,
  /Cannot redeclare block-scoped variable '__/,
];

interface Planned {
  obs: Observation;
  site: Site;
  line: number;
  col: number;
  props: string[];
}

interface FilePlan {
  file: string;
  abs: string;
  text: string; // shadow text
  planned: Map<number, Planned>; // check number -> point
}

export interface CheckOptions {
  log?: (msg: string) => void;
  /** Only check these files (relative to root). */
  files?: string[];
}

export async function check(root: string, options: CheckOptions = {}): Promise<Report> {
  const started = Date.now();
  const log = options.log ?? (() => {});
  const store = new Store(root);
  store.update();
  const problems: string[] = [];
  const staleFiles: string[] = [];
  let files = store.files().filter((f) => fs.existsSync(path.join(root, f)));
  if (options.files) files = files.filter((f) => options.files!.includes(f));

  const plans: FilePlan[] = [];
  let n = 0;
  let checkedPoints = 0;
  for (const file of files) {
    const abs = path.join(root, file);
    const source = fs.readFileSync(abs, 'utf8');
    let analysis;
    try { analysis = analyze(source, abs); } catch (e) { problems.push(`${file}: could not parse (${(e as Error).message})`); continue; }
    const lines = source.split('\n');
    const observed = store.get(file, source);
    const sameVersion = observed[0]?.hash === hashText(source);
    if (!sameVersion && observed.length) staleFiles.push(file);
    const byKey = new Map(analysis.sites.map((s) => [`${s.point.k}|${s.point.n}|${s.point.l}|${s.point.c}`, s]));
    const s = new MagicString(source);
    const planned = new Map<number, Planned>();
    const arrowChecks = new Map<number, { end: number; text: string[] }>();
    for (const obs of observed) {
      const p = obs.point;
      let site = sameVersion ? analysis.sites[p.i] : undefined;
      if (site && (site.point.k !== p.k || site.point.n !== p.n)) site = undefined;
      if (!site) {
        // From another version of the file: a same-named value nearby may be a different one, so only an
        // unchanged position is trusted (a drift there would otherwise be false).
        const loc = locate(lines, p);
        if (!loc || (!sameVersion && !loc.exact)) continue;
        site = byKey.get(`${p.k}|${p.n}|${loc.line}|${loc.col}`);
        if (!site) continue;
      }
      if (site.check.at === 'none' || obs.ty.length === 0 || !site.ref) continue;
      const id = n++;
      const ref = site.ref;
      const stmts: string[] = [];
      const props: string[] = [];
      const decls: string[] = [];
      stmts.push(`const __tc${id}: ${ref} = null as unknown as (${render(obs.ty, { mode: 'ts', ctx: ref, decls })});`);
      // Per property too: TypeScript reports only the first mismatch of an object.
      if (isObjectOnly(obs.ty)) {
        Object.entries(commonProps(obs.ty)).forEach(([key, ty], j) => {
          const sub = `__TrickleProp<${ref}, ${JSON.stringify(key)}>`;
          props.push(key);
          stmts.push(`const __tp${id}_${j}: ${sub} = null as unknown as (${render(ty, { mode: 'ts', ctx: sub, decls })});`);
        });
      }
      if (site.point.k !== 'r') stmts.push(`const __ta${id}: __TrickleNotAny<${ref}> = 0;`);
      stmts.unshift(...decls);
      planned.set(id, { obs, site, line: site.point.l, col: site.point.c, props });
      checkedPoints++;
      const block = stmts.join(' ');
      if (site.check.at === 'insert') s.appendLeft(site.check.pos, `;{${block}}`);
      else {
        const a = arrowChecks.get(site.check.start) ?? { end: site.check.end, text: [] };
        a.text.push(`{${block}}`);
        arrowChecks.set(site.check.start, a);
      }
    }
    for (const [start, a] of arrowChecks) {
      s.appendRight(start, `{${a.text.join(' ')} return (`);
      s.prependLeft(a.end, '); }');
    }
    if (planned.size === 0) continue;
    s.append(HELPERS);
    plans.push({ file, abs, text: s.toString(), planned });
  }

  // Each file is checked by the nearest tsconfig.json above it.
  const projects = new Map<string, FilePlan[]>();
  for (const plan of plans) {
    const cfg = nearestTsconfig(path.dirname(plan.abs), root);
    if (!cfg) { problems.push(`${plan.file}: no tsconfig.json found`); continue; }
    const list = projects.get(cfg) ?? [];
    list.push(plan);
    projects.set(cfg, list);
  }

  const drifts: Drift[] = [];
  if (projects.size) {
    let shadow = path.join(dataDir(root), 'shadow');
    syncShadow(root, shadow, new Map(plans.map((p) => [p.file, p.text])));
    // tsc prints paths relative to its working directory, resolved through symlinks; give it the real path so
    // they come out relative (the cache can sit under a symlink, e.g. macOS's /var -> /private/var).
    try { shadow = fs.realpathSync(shadow); } catch { /* keep */ }
    const byFile = new Map(plans.map((p) => [p.file, p]));
    const queue = [...projects.keys()];
    const run = async () => {
      for (let cfg = queue.shift(); cfg; cfg = queue.shift()) {
        const rel = path.relative(root, cfg);
        log(`checking ${rel}`);
        try {
          const out = await runTsc(cfg, path.join(shadow, rel), shadow);
          // An error with no file (a missing type library, a broken tsconfig) means nothing was really checked.
          const global = out.split(/\r?\n/).filter((l) => /^error TS\d+:/.test(l));
          if (global.length) problems.push(`${rel}: tsc could not check it: ${global.slice(0, 3).join('; ')}`);
          drifts.push(...parseTsc(out, byFile));
        } catch (e) {
          problems.push(`${rel}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all([run(), run(), run()]);
  }

  const seen = new Set<string>();
  const unique = drifts.filter((d) => {
    const key = `${d.file}|${d.line}|${d.col}|${d.kind}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);

  const report: Report = {
    version: 1, root, generatedAt: new Date().toISOString(), ms: Date.now() - started,
    observedFiles: files.length, checkedPoints, projects: [...projects.keys()].map((p) => path.relative(root, p)),
    drifts: unique, problems,
  };
  if (staleFiles.length) report.staleFiles = staleFiles;
  fs.writeFileSync(path.join(ensureDataDir(root), DRIFT_FILE), JSON.stringify(report, null, 1));
  return report;
}

function nearestTsconfig(dir: string, root: string): string | undefined {
  for (;;) {
    const p = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(p)) return p;
    if (dir === root || path.dirname(dir) === dir) return undefined;
    dir = path.dirname(dir);
  }
}

// ── Shadow copy ────────────────────────────────────────────────────────────

// ── Running tsc ────────────────────────────────────────────────────────────

function findTsc(fromDir: string): string {
  const req = createRequire(path.join(fromDir, 'noop.js'));
  const pkgPath = req.resolve('typescript/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsc;
  if (!bin) throw new Error('the installed typescript has no tsc');
  return path.join(path.dirname(pkgPath), bin);
}

function runTsc(realConfig: string, shadowConfig: string, cwd: string): Promise<string> {
  const tsc = findTsc(path.dirname(realConfig));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, '-p', shadowConfig, '--noEmit', '--pretty', 'false'], {
      cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && code !== 1 && code !== 2 && !out) reject(new Error(`tsc exited with ${code}: ${err.slice(0, 500)}`));
      else resolve(out);
    });
  });
}

interface TscError { file: string; line: number; col: number; code: string; lines: string[] }

function parseErrors(out: string): TscError[] {
  const errors: TscError[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(raw);
    if (m) errors.push({ file: m[1]!.split(path.sep).join('/'), line: +m[2]!, col: +m[3]!, code: m[4]!, lines: [m[5]!] });
    else if (/^\s+\S/.test(raw) && errors.length) errors[errors.length - 1]!.lines.push(raw.trim());
  }
  return errors;
}

function parseTsc(out: string, plans: Map<string, FilePlan>): Drift[] {
  const drifts: Drift[] = [];
  const lineCache = new Map<string, string[]>();
  for (const e of parseErrors(out)) {
    const plan = plans.get(e.file);
    if (!plan) continue;
    let lines = lineCache.get(e.file);
    if (!lines) lineCache.set(e.file, (lines = plan.text.split('\n')));
    const at = (lines[e.line - 1] ?? '').slice(e.col - 1);
    const m = MARKER.exec(at);
    if (!m) continue;
    const all = e.lines.join('\n');
    if (IGNORE.some((re) => re.test(all))) continue;
    // The declared side depends on a type parameter (or still mentions a helper because of one): no concrete contract.
    const target = /to type '(.*)'\.?$/.exec(e.lines[0]!)?.[1] ?? '';
    if (target.includes('__Trickle')) continue;
    const planned = plan.planned.get(+m[2]!);
    if (!planned) continue;
    const { obs, site } = planned;
    if (site.tps?.some((tp) => new RegExp(`(^|[^\\w$.])${tp.replace(/\$/g, '\\$')}([^\\w$]|$)`).test(target))) continue;
    const kind = m[1]!;
    const runtime = render(obs.ty, { mode: 'short' });
    let severity: Severity = 'drift';
    let message: string;
    if (kind === 'a') {
      severity = 'any';
      message = `declared as any; at runtime it is ${runtime}`;
    } else {
      const prop = kind === 'p' && m[3] !== undefined ? planned.props[+m[3]] : undefined;
      message = summarize(e.lines.map(cleanHelpers), prop);
    }
    const d: Drift = {
      file: plan.file, line: planned.line, col: planned.col, kind: site.point.k, name: site.point.n, severity,
      message, detail: e.lines.map(cleanHelpers).join('\n'), runtime, count: obs.count,
    };
    if (site.point.fn) d.fn = site.point.fn;
    drifts.push(d);
  }
  return drifts;
}

/** Show the helper types in TypeScript's messages as the runtime types they stand for. */
export function cleanHelpers(text: string): string {
  for (let guard = 0; guard < 200; guard++) {
    const m = /__Trickle(Bo|S|N|B|A|X|O|Prop|El|NotAny|Fit|V\d+)</.exec(text);
    if (!m) return text;
    const open = m.index + m[0].length;
    const args: string[] = [];
    let depth = 0, start = open, i = open, quote = '';
    for (; i < text.length; i++) {
      const ch = text[i]!;
      if (quote) { if (ch === quote) quote = ''; continue; }
      if (ch === "'") break; // end of the quoted type in the message (TypeScript truncated it)
      if (ch === '"') quote = ch;
      else if ('<([{'.includes(ch)) depth++;
      else if (ch === '>' && text[i - 1] === '=') continue;
      else if ('>)]}'.includes(ch)) {
        if (depth === 0) { args.push(text.slice(start, i).trim()); break; }
        depth--;
      } else if (ch === ',' && depth === 0) { args.push(text.slice(start, i).trim()); start = i + 1; }
    }
    const closed = i < text.length && text[i] === '>';
    if (!closed && start < i) args.push(text.slice(start, i).trim());
    const end = closed ? i + 1 : i;
    const kind = m[1];
    const el = args[1] ?? 'unknown';
    const out = kind === 'S' ? 'string' : kind === 'Bo' ? 'boolean' : kind === 'N' ? 'number' : kind === 'B' || kind === 'O' ? (args[1] ?? 'object')
      : kind === 'A' || kind === 'X' ? (/[|&]/.test(el) ? `(${el})[]` : `${el}[]`)
      : kind === 'Prop' ? `${args[0]}[${args[1]}]` : kind === 'Fit' ? (args[1] ?? 'object')
      : kind!.startsWith('V') ? 'object' : (args[0] ?? '');
    text = text.slice(0, m.index) + out + text.slice(end);
  }
  return text;
}

function short(t: string, max = 60): string {
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Turn TypeScript's assignability explanation into one line about runtime vs declared. */
export function summarize(lines: string[], prop?: string): string {
  const pathParts: string[] = prop ? [prop] : [];
  let last = lines[0]!;
  for (const line of lines) {
    const m = /^Types of property '(.+)' are incompatible\.$/.exec(line);
    if (m) pathParts.push(m[1]!);
    else last = line;
  }
  let text: string;
  let m: RegExpExecArray | null;
  if ((m = /^Property '(.+)' is missing in type '.*' but required in type '(.*)'\.$/.exec(last))) {
    pathParts.push(m[1]!);
    text = `missing at runtime, but required by ${short(m[2]!)}`;
  } else if ((m = /^Type '.*' is missing the following properties from type '(.*)': (.*)$/.exec(last))) {
    text = `missing ${m[2]!.replace(/\.$/, '')} at runtime, but required by ${short(m[1]!)}`;
  } else if ((m = /^Property '(.+)' is optional in type '.*' but required in type '(.*)'\.$/.exec(last))) {
    pathParts.push(m[1]!);
    text = `sometimes missing at runtime, but required by ${short(m[2]!)}`;
  } else if ((m = /^Type '(.*)' is not assignable to type '(.*)'\.$/.exec(last))) {
    text = `runtime ${short(m[1]!)} is not assignable to declared ${short(m[2]!)}`;
  } else if ((m = /^Type '(.*)' has no properties in common with type '(.*)'\.$/.exec(last))) {
    text = `runtime ${short(m[1]!)} has nothing in common with declared ${short(m[2]!)}`;
  } else {
    text = last.replace(/'([^']{61,})'/g, (_, t: string) => `'${short(t)}'`);
  }
  return (pathParts.length ? pathParts.join('.') + ': ' : '') + text;
}
