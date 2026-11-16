/**
 * A copy of the project in trickle-lite's data folder, with some files replaced: the checker type-checks one
 * (with assertions added), and `trickle-lite worker` deploys one (instrumented). node_modules are linked, not
 * copied; links between workspace packages stay inside the copy, so their sources are the copied ones.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hashText } from './common.js';

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/;

function listSources(root: string): string[] {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { maxBuffer: 256 << 20 });
    return out.toString('utf8').split('\0').filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', '.next'].includes(e.name)) continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) walk(rel);
        else out.push(rel);
      }
    };
    walk('');
    return out;
  }
}

/**
 * Link each entry of a node_modules directory, keeping relative (workspace, pnpm store) links relative. Runs on
 * every sync: an install since the last one can add packages or move a link to another version.
 */
function linkModules(real: string, link: string) {
  fs.mkdirSync(link, { recursive: true });
  for (const e of fs.readdirSync(real, { withFileTypes: true })) {
    const from = path.join(real, e.name), to = path.join(link, e.name);
    if (e.name.startsWith('@') && e.isDirectory()) { linkModules(from, to); continue; }
    const target = e.isSymbolicLink() ? fs.readlinkSync(from) : '';
    const want = target && !path.isAbsolute(target) ? target : from;
    try {
      if (fs.readlinkSync(to) === want) continue;
      fs.rmSync(to, { force: true });
    } catch { /* missing, or not a link */ }
    try { fs.symlinkSync(want, to, 'junction'); } catch { /* something else is there */ }
  }
}

/** Mirror the project into `shadow` (code files, or every file with `allFiles`), applying `overrides`. */
export function syncShadow(root: string, shadow: string, overrides: Map<string, string>, allFiles = false) {
  const manifestPath = path.join(shadow, '.manifest.json');
  let manifest: Record<string, string> = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* first run */ }
  const next: Record<string, string> = {};
  const dirs = new Set<string>(['']);
  const files = new Set(listSources(root).filter((rel) => allFiles || CODE_EXT.test(rel)));
  for (const rel of overrides.keys()) files.add(rel);
  for (const rel of files) {
    const src = path.join(root, rel);
    const dst = path.join(shadow, rel);
    let stamp: string;
    const override = overrides.get(rel);
    if (override !== undefined) stamp = 'o:' + hashText(override);
    else {
      try { const st = fs.statSync(src); if (!st.isFile()) continue; stamp = `${st.size}:${st.mtimeMs}`; } catch { continue; }
    }
    next[rel] = stamp;
    if (rel.endsWith('package.json')) dirs.add(path.dirname(rel) === '.' ? '' : path.dirname(rel));
    if (manifest[rel] === stamp && fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (override !== undefined) fs.writeFileSync(dst, override);
    else fs.copyFileSync(src, dst);
  }
  for (const rel of Object.keys(manifest)) {
    if (!(rel in next)) fs.rmSync(path.join(shadow, rel), { force: true });
  }
  for (const dir of dirs) {
    const real = path.join(root, dir, 'node_modules');
    if (fs.existsSync(real)) linkModules(real, path.join(shadow, dir, 'node_modules'));
  }
  fs.writeFileSync(manifestPath, JSON.stringify(next));
}
