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
import { dataDir, DRIFT_FILE, findRoot, OBS_FILE, toKey } from './common.js';

const HOME = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const HELP = `trickle-lite — runtime types for TypeScript, and where they drift from the declared ones

Usage:
  trickle-lite run [--keep] [--no-check] [--no-node-hook] -- <command...>
      Run a command with observation on (node, tsx, vitest via the plugin), then check for drift.
      Observations from earlier runs are cleared first unless --keep. --no-node-hook leaves NODE_OPTIONS
      alone, for runs that only need the Vitest plugin.
  trickle-lite check [--json] [--file <path>]
      Compare observed runtime types with the declared types using the project's own tsc.
      Writes .trickle/drift.json.
  trickle-lite show <file> [--all]
      Print a file with the runtime type of each observed value beside it.
  trickle-lite watch
      Re-check whenever new observations arrive (the VS Code extension does this for you).
  trickle-lite clear
      Delete everything under .trickle/.

Environment:
  TRICKLE_ROOT       project root (default: nearest directory with .git)
  TRICKLE_INCLUDE    comma-separated path fragments to observe (default: all project TypeScript)
  TRICKLE_EXCLUDE    comma-separated path fragments to skip
  TRICKLE_TESTS=1    also observe test files
  TRICKLE_DISABLE=1  turn observation off
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
    case 'watch': return watch(root);
    case 'clear':
      fs.rmSync(dataDir(root), { recursive: true, force: true });
      console.log(`cleared ${path.relative(process.cwd(), dataDir(root)) || '.trickle'}`);
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
  const sep = args.indexOf('--');
  const flags = sep >= 0 ? args.slice(0, sep) : args.filter((a) => a.startsWith('--'));
  const command = sep >= 0 ? args.slice(sep + 1) : args.filter((a) => !a.startsWith('--'));
  if (!command.length) { process.stderr.write('trickle-lite run: no command given\n'); return 2; }
  if (!flags.includes('--keep')) fs.rmSync(path.join(dataDir(root), OBS_FILE), { force: true });
  const register = pathToFileURL(path.join(HOME, 'dist', 'register.js')).href;
  const env: NodeJS.ProcessEnv = { ...process.env, TRICKLE_ROOT: root, TRICKLE_LITE_HOME: HOME };
  // The loader hook observes node/tsx processes. Test runs that only use the Vitest plugin can leave it out,
  // so the node processes their tests spawn start exactly as they normally do.
  if (!flags.includes('--no-node-hook')) env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import ${register}`.trim();
  const code: number = await new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', env, shell: process.platform === 'win32' });
    child.on('error', (e) => { process.stderr.write(`trickle-lite: ${e.message}\n`); resolve(127); });
    child.on('close', (code) => resolve(code ?? 1));
  });
  const store = new Store(root);
  try { store.compact(); } catch { /* nothing recorded */ }
  if (!flags.includes('--no-check')) {
    if (store.files().length) {
      const report = await check(root);
      printReport(report, false);
    } else {
      console.log(dim('\ntrickle-lite: nothing was observed. Is the code TypeScript under this repository, and (for Vitest) is the plugin in the config?'));
    }
  }
  return code;
}

async function runCheck(root: string, args: string[]): Promise<number> {
  const json = args.includes('--json');
  const fileIdx = args.indexOf('--file');
  const files = fileIdx >= 0 && args[fileIdx + 1] ? [toKey(root, path.resolve(args[fileIdx + 1]!))] : undefined;
  const report = await check(root, { log: json ? undefined : (m) => console.error(dim(m)), files });
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else printReport(report, true);
  return report.drifts.some((d) => d.severity === 'drift') ? 1 : 0;
}

function printReport(r: Report, verbose: boolean) {
  const drift = r.drifts.filter((d) => d.severity === 'drift');
  const excess = r.drifts.filter((d) => d.severity === 'excess');
  const any = r.drifts.filter((d) => d.severity === 'any');
  console.log(`\n${cyan('trickle-lite')} checked ${r.checkedPoints} observed values in ${r.observedFiles} files against their declared types (${(r.ms / 1000).toFixed(1)}s)`);
  const line = (d: Drift) => {
    const where = `${d.file}:${d.line}:${d.col + 1}`;
    const what = d.kind === 'r' ? `return of ${d.name}` : d.kind === 'p' ? `parameter ${d.name}` : d.name;
    return `  ${where}  ${what}${d.fn && d.kind !== 'r' ? dim(` in ${d.fn}`) : ''}\n    ${d.message} ${dim(`(${d.count}×)`)}`;
  };
  if (drift.length) console.log(`\n${red(`${drift.length} drift${drift.length === 1 ? '' : 's'}`)} — runtime values the declared types do not allow:\n${drift.map(line).join('\n')}`);
  if (excess.length && verbose) console.log(`\n${yellow(`${excess.length} undeclared propert${excess.length === 1 ? 'y set' : 'y sets'}`)} — runtime objects carry fields the type does not mention:\n${excess.map(line).join('\n')}`);
  if (any.length && verbose) console.log(`\n${dim(`${any.length} declared any`)} — no contract, but this is what ran:\n${any.map(line).join('\n')}`);
  if (!verbose && (excess.length || any.length)) console.log(dim(`\n${excess.length} undeclared property sets and ${any.length} any-typed values; \`trickle-lite check\` lists them.`));
  if (!drift.length) console.log(`\n${c(32, 'no drift')}: every observed value fits its declared type.`);
  for (const p of r.problems) console.log(yellow(`  ! ${p}`));
  console.log(dim(`\nDetails: ${path.join(DATA_DIR_REL, DRIFT_FILE)}`));
}
const DATA_DIR_REL = '.trickle';

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
    list.push(`${d.severity === 'drift' ? '⚠ DRIFT' : d.severity === 'excess' ? '± extra' : '~ any'} ${d.name}: ${d.message}`);
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

async function watch(root: string): Promise<number> {
  const file = path.join(dataDir(root), OBS_FILE);
  fs.mkdirSync(dataDir(root), { recursive: true });
  console.log(dim(`watching ${path.relative(process.cwd(), file)}`));
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let again = false;
  const go = async () => {
    if (running) { again = true; return; }
    running = true;
    try { printReport(await check(root), false); } catch (e) { console.error(e); }
    running = false;
    if (again) { again = false; void go(); }
  };
  fs.watchFile(file, { interval: 500 }, () => {
    clearTimeout(timer);
    timer = setTimeout(go, 1000);
  });
  await go();
  return new Promise<number>(() => {});
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  console.error(e);
  process.exitCode = 1;
});
