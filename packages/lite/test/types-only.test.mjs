import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runFixture } from './helpers.mjs';
import { check } from '../dist/check.js';
import { typesOnly } from '../dist/types.js';
import { dataDir, OBS_FILE } from '../dist/common.js';

// Records pulled from the shared database carry no string values (`op: string`, not `op: "add"`). Checked against
// a discriminated union, such an object must still fit its own variant, and real drift must still show.
const { dir } = runFixture();
const file = path.join(dataDir(dir), OBS_FILE);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
fs.writeFileSync(file, lines.map((r) => JSON.stringify(r.t ? { ...r, t: typesOnly(r.t) } : r)).join('\n') + '\n');
const report = await check(dir);
const drift = (name) => report.drifts.filter((d) => d.name === name && d.severity === 'drift').map((d) => d.message);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('types-only records: no false drift for discriminated unions', () => {
  for (const name of ['ops', 'op', 'apply']) assert.deepEqual(drift(name), [], name);
});

test('types-only records: real drift is still found', () => {
  assert.ok(drift('data').some((m) => /tags: runtime null is not assignable to declared string\[\]/.test(m)), drift('data').join('\n'));
});
