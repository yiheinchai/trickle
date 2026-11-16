import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './helpers.mjs'; // isolates HOME and the cache
import { Store } from '../dist/store.js';
import { dataDir, hashText, OBS_FILE } from '../dist/common.js';

// Observations of one file from two versions of its source, as when a deployed Worker and a laptop run
// different commits and both upload to the shared database.
const current = 'export function f(a: number) {\n  return a;\n}\n';
const other = '// moved down a line\nexport function f(a: string) {\n  return a;\n}\n';
const rec = (source, at, ty, l) =>
  ({ w: 'x', f: 'src/a.ts', h: hashText(source), i: 0, k: 'p', n: 'a', l, c: 18, hl: l, hc: 19, x: 1, at, t: [ty] });

function project() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trickle-lite-store-')));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.ts'), current);
  fs.mkdirSync(dataDir(dir), { recursive: true });
  // The other version was observed more recently.
  const lines = [rec(current, 1000, { k: 'number' }, 1), rec(other, 2000, { k: 'string' }, 2)];
  fs.writeFileSync(path.join(dataDir(dir), OBS_FILE), lines.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

test('observations come from the version that matches the current source', () => {
  const dir = project();
  const store = new Store(dir);
  store.update();
  assert.deepEqual(store.get('src/a.ts', current).map((o) => o.ty), [[{ k: 'number' }]]);
  assert.equal(store.get('src/a.ts', current)[0].hash, hashText(current));
  // Without the source, or for a source never observed: the most recent version.
  assert.deepEqual(store.get('src/a.ts').map((o) => o.ty), [[{ k: 'string' }]]);
  assert.deepEqual(store.get('src/a.ts', current + '// edited\n').map((o) => o.ty), [[{ k: 'string' }]]);
});

test('compacting keeps the version that matches the file on disk', () => {
  const dir = project();
  new Store(dir).compact();
  const store = new Store(dir);
  store.update();
  assert.deepEqual(store.get('src/a.ts', current).map((o) => o.ty), [[{ k: 'number' }]]);
  assert.deepEqual(store.get('src/a.ts').map((o) => o.ty), [[{ k: 'string' }]]);
});
