import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runFixture } from './helpers.mjs';
import { check } from '../dist/check.js';
import { Store } from '../dist/store.js';
import { dataDir } from '../dist/common.js';

const { dir, out } = runFixture();
const report = await check(dir);
const at = (name, kind) => report.drifts.filter((d) => d.name === name && (!kind || d.kind === kind));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the observed program behaves the same', () => {
  assert.equal(out.trim(), '4 500 20 4');
});

test('observations are recorded per point', () => {
  const store = new Store(dir);
  store.update();
  const lib = store.get('src/lib.ts');
  const raw = lib.find((o) => o.point.n === 'raw');
  assert.equal(raw.count, 4);
  assert.deepEqual(raw.ty, [{ k: 'string' }]);
});

test('drift: values the declared types do not allow', () => {
  const data = at('data').filter((d) => d.severity === 'drift').map((d) => d.message);
  assert.ok(data.some((m) => /^tags: runtime null is not assignable to declared string\[\]/.test(m)), data.join('\n'));
  assert.ok(data.some((m) => /^kind: runtime "guide" is not assignable to declared "skill" \| "rule"/.test(m)), data.join('\n'));
  assert.ok(at('parse', 'r').some((d) => d.severity === 'drift'), 'return of parse');
  assert.ok(at('second').some((d) => d.severity === 'drift' && /undefined/.test(d.message)), 'regex group typed string');
});

test('values declared any are reported with what they were', () => {
  assert.ok(at('x').some((d) => d.severity === 'any' && /\{ value: number \}/.test(d.message)));
});

test('no false drift for literal constants, built-ins, generics or discriminated unions', () => {
  for (const name of ['LIMIT', 'MARKER', 'd', 'm', 'it', 'items', 'first', 'ops', 'op', 'apply', 'n', 'double', 'x']) {
    const bad = at(name).filter((d) => d.severity === 'drift');
    assert.deepEqual(bad.map((d) => d.message), [], name);
  }
});

test('drift.json is written for the editor', () => {
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir(dir), 'drift.json'), 'utf8'));
  assert.equal(saved.drifts.length, report.drifts.length);
  assert.deepEqual(report.problems, []);
  assert.ok(!fs.existsSync(path.join(dir, '.trickle')), 'nothing is written into the project');
});
