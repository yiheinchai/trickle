#!/usr/bin/env node
/**
 * trickle-lite: real-time runtime types for TypeScript, and where they drift from the declared ones.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, type Drift, type Report } from './check.js';
import { Store, locate } from './store.js';
import { render } from './types.js';
import { dataDir, DRIFT_FILE, ensureDataDir, findRoot, OBS_FILE, toKey } from './common.js';

const HOME = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const HELP = `trickle-lite — runtime types for TypeScript, and where they drift from the declared ones

Usage:
  trickle-lite run <command...>   run a command observed locally (node, tsx, vitest), then check for drift
  trickle-lite check [--json]     check observed types against declared types
  trickle-lite show <file>        print a file with the observed type of each value beside it
  trickle-lite clear              delete this project's trickle-lite data

Deployed code (Cloudflare Workers), types only:
  trickle-lite worker <command>   run e.g. \`npx wrangler deploy\` on an instrumented copy of the repository
  trickle-lite serve              the store for deployed observations (DATABASE_URL, TRICKLE_INGEST_TOKEN, TRICKLE_READ_TOKEN)
  trickle-lite pull               fetch them (TRICKLE_SERVER, TRICKLE_READ_TOKEN, TRICKLE_PROJECT), then check/show as usual

Data is kept outside the project, in ~/.cache/trickle-lite/.

Environment: TRICKLE_INCLUDE / TRICKLE_EXCLUDE (comma-separated path fragments), TRICKLE_TESTS=1 (observe tests too)
`;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c(2, s), yellow = (s: string) => c(33, s), red = (s: string) => c(31, s), cyan = (s: string) => c(36, s);

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const root = findRoot();
  switch (cmd) {
    case 'run': return run(root, rest);
    case 'check': return runCheck(root, rest);
    case 'show': return show(root, rest);
    case 'worker': return (await import('./worker.js')).worker(rest[0] === '--' ? rest.slice(1) : rest);
    case 'serve': await (await import('./server.js')).serve(); return new Promise<number>(() => {});
    case 'pull': return pull(root);
    case 'clear':
      fs.rmSync(dataDir(root), { recursive: true, force: true });
      console.log(`cleared ${dataDir(root)}`);
      return 0;
    case undefined: case '-h': case '--help': case 'help':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

async function run(root: string, args: string[]): Promise<number> {
  const command = args[0] === '--' ? args.slice(1) : args;
  if (!command.length) { process.stderr.write('trickle-lite run: no command given\n'); return 2; }
  fs.rmSync(path.join(dataDir(root), OBS_FILE), { force: true });
  const register = pathToFileURL(path.join(HOME, 'dist', 'register.js')).href;
  const env = { ...process.env, TRICKLE_ROOT: root, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${register}`.trim() };
  const code: number = await new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', env, shell: process.platform === 'win32' });
    child.on('error', (e) => { process.stderr.write(`trickle-lite: ${e.message}\n`); resolve(127); });
    child.on('close', (code) => resolve(code ?? 1));
  });
  const store = new Store(root);
  try { store.compact(); } catch { /* nothing recorded */ }
  if (store.files().length) printReport(await check(root), root);
  else console.log(dim('\ntrickle-lite: nothing was observed (is the code TypeScript inside this repository?)'));
  return code;
}

async function runCheck(root: string, args: string[]): Promise<number> {
  const json = args.includes('--json');
  const report = await check(root);
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printReport(report, root);
  return report.drifts.some((d) => d.severity === 'drift') ? 1 : 0;
}

function printReport(r: Report, root: string) {
  const drift = r.drifts.filter((d) => d.severity === 'drift');
  const any = r.drifts.filter((d) => d.severity === 'any');
  console.log(`\n${cyan('trickle-lite')} checked ${r.checkedPoints} observed values in ${r.observedFiles} files against their declared types`);
  const line = (d: Drift) => {
    const what = d.kind === 'r' ? `return of ${d.name}` : d.kind === 'p' ? `parameter ${d.name}` : d.name;
    return `  ${d.file}:${d.line}:${d.col + 1}  ${what}\n    ${d.message} ${dim(`(${d.count}×)`)}`;
  };
  if (drift.length) console.log(`\n${red(`${drift.length} drift${drift.length === 1 ? '' : 's'}`)} — runtime values the declared types do not allow:\n${drift.map(line).join('\n')}`);
  else console.log(`\n${c(32, 'no drift')}: every observed value fits its declared type.`);
  if (any.length) console.log(dim(`\n${any.length} values are declared any; ${path.join(dataDir(root), DRIFT_FILE)} has what they were at runtime.`));
  for (const p of r.problems) console.log(yellow(`  ! ${p}`));
}

/** Replace the local observations with what deployed code reported to the trickle-lite server. */
async function pull(root: string): Promise<number> {
  const { TRICKLE_SERVER, TRICKLE_READ_TOKEN, TRICKLE_PROJECT } = process.env;
  if (!TRICKLE_SERVER || !TRICKLE_READ_TOKEN) { process.stderr.write('trickle-lite pull needs TRICKLE_SERVER and TRICKLE_READ_TOKEN\n'); return 2; }
  const url = new URL('/v1/observations', TRICKLE_SERVER);
  url.searchParams.set('project', TRICKLE_PROJECT || 'default');
  const res = await fetch(url, { headers: { authorization: `Bearer ${TRICKLE_READ_TOKEN}` }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) { process.stderr.write(`trickle-lite pull: ${res.status} from ${url.origin}\n`); return 1; }
  const { records } = (await res.json()) as { records: unknown[] };
  const file = path.join(ensureDataDir(root), OBS_FILE);
  fs.writeFileSync(file + '.tmp', records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  fs.renameSync(file + '.tmp', file);
  console.error(`trickle-lite: ${records.length} observed values from ${url.origin}`);
  return 0;
}

function show(root: string, args: string[]): number {
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { process.stderr.write('trickle-lite show <file>\n'); return 2; }
  const abs = path.resolve(target);
  const key = toKey(root, abs);
  const store = new Store(root);
  store.update();
  const obs = store.get(key);
  if (!obs.length) { console.log(`no observations for ${key}`); return 1; }
  let drifts: Drift[] = [];
  try {
    const report: Report = JSON.parse(fs.readFileSync(path.join(dataDir(root), DRIFT_FILE), 'utf8'));
    drifts = report.drifts.filter((d) => d.file === key);
  } catch { /* not checked yet */ }
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const notes = new Map<number, string[]>();
  for (const o of obs) {
    const loc = locate(lines, o.point);
    if (!loc) continue;
    const p = o.point;
    const label = p.k === 'r' ? `${p.n.split('.').pop()}() ⇒` : p.n + ':';
    const list = notes.get(loc.line) ?? [];
    list.push(`${label} ${render(o.ty, { mode: 'short' })}`);
    notes.set(loc.line, list);
  }
  for (const d of drifts) {
    const list = notes.get(d.line) ?? [];
    list.push(`${d.severity === 'drift' ? '⚠ DRIFT' : '~ any'} ${d.name}: ${d.message}`);
    notes.set(d.line, list);
  }
  const width = String(lines.length).length;
  lines.forEach((text, i) => {
    const note = notes.get(i + 1);
    if (!note && !args.includes('--all') && !nearNote(notes, i + 1)) return;
    console.log(`${dim(String(i + 1).padStart(width))}  ${text}${note ? '  ' + cyan('// ' + note.join(' · ')) : ''}`);
  });
  return 0;
}

function nearNote(notes: Map<number, string[]>, line: number): boolean {
  return notes.has(line - 1) || notes.has(line + 1);
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  console.error(e);
  process.exitCode = 1;
});
