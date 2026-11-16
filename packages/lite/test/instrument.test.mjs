import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { instrument, analyze } from '../dist/instrument.js';

/** Instrument, compile and run `src`, recording what __tt sees. */
function run(src, ret = 'result') {
  const r = instrument(src, 'x.ts', 'x.ts');
  assert.equal(r.code.split('\n').length, src.split('\n').length, 'line count is preserved');
  const js = ts.transpileModule(r.code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const seen = [];
  const points = new Map();
  globalThis.__trickle = { f: (file, hash, meta) => { meta().forEach((m, i) => points.set(i, m)); return { o: (i, v) => { seen.push([points.get(i)[0], points.get(i)[1], v]); return v; } }; } };
  try {
    const module = { exports: {} };
    new Function('module', 'exports', js + `\nmodule.exports.__r = typeof ${ret} === 'undefined' ? undefined : ${ret};`)(module, module.exports);
    return { seen, value: module.exports.__r, code: r.code };
  } finally {
    delete globalThis.__trickle;
  }
}

test('records parameters, variables, destructuring, returns and catch', () => {
  const { seen, value } = run(`
function add(a: number, { b }: { b: number }): number {
  const s = a + b;
  let t = s;
  t = t * 2;
  try { JSON.parse("{"); } catch (e) { void e; }
  return t;
}
const result = add(1, { b: 2 });`);
  assert.equal(value, 6);
  const names = seen.map(([k, n]) => k + ':' + n);
  for (const n of ['p:a', 'p:b', 'v:s', 'v:t', 'v:e', 'r:add', 'v:result']) assert.ok(names.includes(n), n);
});

test('function and class names survive (initializers that are functions are not wrapped)', () => {
  const { value } = run(`const fn = () => 1; class K {} const C = class {}; const result = [fn.name, K.name, C.name].join(",");`);
  assert.equal(value, 'fn,K,C');
});

test('expression arrows, comma returns and object-literal bodies', () => {
  const { value, seen } = run(`
const pair = (x: number) => ({ x, y: x + 1 });
function seq() { let i = 0; return (i++, i++, i); }
const result = [pair(1).y, seq()].join(",");`);
  assert.equal(value, '2,2');
  assert.ok(seen.some(([k, n, v]) => k === 'r' && n === 'pair' && v.y === 2));
});

test('derived constructors record after super(), directives stay first', () => {
  const { value } = run(`"use strict";
class A { constructor(public a: number) {} }
class B extends A { constructor(a: number, public b: string) { super(a); } }
const result = new B(1, "z").b;`);
  assert.equal(value, 'z');
});

test('async returns record the resolved value', async () => {
  const { seen, value } = run(`async function get(): Promise<number> { return 42; } const result = get();`);
  assert.equal(await value, 42);
  assert.ok(seen.some(([k, n, v]) => k === 'r' && n === 'get' && v === 42));
});

test('analyze gives declared-type references for checks', () => {
  const a = analyze(`function f<T>(x: T, n: number): Promise<string> { const y = n; return Promise.resolve(""); }`, 'x.ts');
  const ret = a.sites.find((s) => s.point.k === 'r');
  assert.equal(ret.ref, '(Promise<string>)');
  assert.deepEqual(a.sites.find((s) => s.point.n === 'x').tps, ['T']);
  assert.equal(a.sites.find((s) => s.point.n === 'y').ref, 'typeof y');
});
