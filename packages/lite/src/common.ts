import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = '.trickle';
export const OBS_FILE = 'observations.jsonl';
export const DRIFT_FILE = 'drift.json';

/** The project root: TRICKLE_ROOT, else the nearest directory above `from` with a .git or workspace marker. */
export function findRoot(from = process.cwd()): string {
  if (process.env.TRICKLE_ROOT) return path.resolve(process.env.TRICKLE_ROOT);
  let dir = path.resolve(from);
  let fallback: string | undefined;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (!fallback && fs.existsSync(path.join(dir, 'package.json'))) fallback = dir;
    const up = path.dirname(dir);
    if (up === dir) return fallback ?? path.resolve(from);
    dir = up;
  }
}

export function dataDir(root: string): string {
  return path.join(root, DATA_DIR);
}

/** Create .trickle/, ignored by git without the project having to say so. */
export function ensureDataDir(root: string): string {
  const dir = dataDir(root);
  if (!fs.existsSync(path.join(dir, '.gitignore'))) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  }
  return dir;
}

export function toKey(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

const TS_EXT = /\.(ts|tsx|mts|cts)$/;
const TEST_RE = /(\.(test|spec)\.[cm]?tsx?$)|(\/(test|tests|__tests__|__mocks__|fixtures)\/)/;
// This package's own directory, never instrumented. Empty when bundled somewhere import.meta is unavailable.
let SELF = '';
try { SELF = path.dirname(path.dirname(fileURLToPath(import.meta.url))); } catch { /* bundled */ }

function list(env: string | undefined): string[] {
  return (env ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Whether a file is project source that should be observed. */
export function shouldInstrument(file: string, root: string): boolean {
  if (!TS_EXT.test(file) || file.endsWith('.d.ts')) return false;
  const rel = toKey(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (rel.includes('node_modules/') || rel.startsWith(DATA_DIR + '/') || (SELF !== '' && file.startsWith(SELF + path.sep))) return false;
  if (/(^|\/)(dist|build|out|\.next)\//.test(rel)) return false;
  if (process.env.TRICKLE_TESTS !== '1' && TEST_RE.test('/' + rel)) return false;
  const include = list(process.env.TRICKLE_INCLUDE);
  if (include.length && !include.some((p) => rel.includes(p))) return false;
  if (list(process.env.TRICKLE_EXCLUDE).some((p) => rel.includes(p))) return false;
  return true;
}

/** FNV-1a, short. Used to tell which version of a file an observation came from. */
export function hashText(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
