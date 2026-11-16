import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep trickle-lite's data for test projects out of the real ~/.cache.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'trickle-lite-cache-'));

export const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const dist = (f) => path.join(PKG, 'dist', f);

/** Copy the fixture project somewhere outside this package (which is never instrumented) and run it observed. */
export function runFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trickle-lite-'));
  fs.cpSync(path.join(PKG, 'test', 'fixture'), dir, { recursive: true });
  fs.symlinkSync(path.join(PKG, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  fs.mkdirSync(path.join(dir, '.git')); // marks the project root
  const out = execFileSync(process.execPath, ['--import', dist('register.js'), 'src/main.ts'], {
    cwd: dir, env: { ...process.env, TRICKLE_ROOT: dir }, encoding: 'utf8',
  });
  return { dir, out };
}
