import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Keep tests away from this machine's trickle-lite data and Neon connection (~/.cache, ~/.config).
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trickle-lite-home-'));
process.env.XDG_CACHE_HOME = path.join(process.env.HOME, '.cache');
delete process.env.TRICKLE_DATABASE_URL;

export const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const dist = (f) => path.join(PKG, 'dist', f);

/** Copy the fixture project somewhere outside this package (which is never instrumented) and run it observed. */
export function runFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trickle-lite-'));
  fs.cpSync(path.join(PKG, 'test', 'fixture'), dir, { recursive: true });
  // The node_modules that holds typescript: this package's own, or the workspace root's when npm hoisted it.
  const modules = path.dirname(path.dirname(createRequire(path.join(PKG, 'package.json')).resolve('typescript/package.json')));
  fs.symlinkSync(modules, path.join(dir, 'node_modules'), 'junction');
  fs.mkdirSync(path.join(dir, '.git')); // marks the project root
  const out = execFileSync(process.execPath, ['--import', dist('register.js'), 'src/main.ts'], {
    cwd: dir, env: { ...process.env, TRICKLE_ROOT: dir }, encoding: 'utf8',
  });
  return { dir, out };
}
