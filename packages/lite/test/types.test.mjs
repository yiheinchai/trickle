import test from 'node:test';
import assert from 'node:assert/strict';
import { infer, mergeTy, render } from '../dist/types.js';

const short = (v) => render(infer(v), { mode: 'short' });
const ts = (t) => render(t, { mode: 'ts' });

test('primitives, literals and objects', () => {
  assert.equal(short(1), 'number');
  assert.equal(short('draft'), '"draft"');
  assert.equal(short('has spaces and @'), 'string');
  assert.equal(short(null), 'null');
  assert.equal(short({ a: 1, b: [true] }), '{ a: number; b: true[] }');
});

test('sensitive keys never keep string values', () => {
  assert.equal(short({ apiToken: 'abc123', email: 'x' }), '{ apiToken: string; email: string }');
});

test('merging keeps distinct shapes, and makes absent properties optional once collapsed', () => {
  const t = mergeTy(infer({ id: 'a', tags: ['x'] }), infer({ id: 'b' }));
  assert.equal(ts(t), '{ id: "a"; tags: "x"[] } | { id: "b" }');
  let many = [];
  for (let i = 0; i < 10; i++) many = mergeTy(many, infer({ id: i, ['k' + i]: true }));
  assert.ok(many.length <= 2);
  assert.ok(many[0].opt.length >= 9);
  assert.equal(ts(mergeTy(infer(1), infer(undefined))), 'number | undefined');
});

test('arrays of unions are parenthesised', () => {
  assert.equal(ts(infer([1, 'a b'])), '(number | string)[]');
});

test('getters are not called and proxies are not read', () => {
  let called = false;
  const o = { get x() { called = true; return 1; } };
  assert.equal(short(o), '{ x: any }');
  assert.equal(called, false);
  assert.equal(short(new Proxy({}, { get() { throw new Error('read'); } })), 'any');
});

test('cycles terminate', () => {
  const a = { name: 'a' };
  a.self = a;
  assert.equal(ts(infer(a)), '{ name: "a"; self: any }');
});

test('built-ins and class instances', () => {
  assert.equal(short(new Date(0)), 'Date');
  assert.equal(short(new Map([['k', 1]])), 'Map<"k", number>');
  class Box { constructor() { this.v = 1; } get() { return this.v; } }
  assert.equal(short(new Box()), 'Box { v: number }');
  assert.equal(ts(infer(new Box())), '{ v: number; "get": any }');
  assert.equal(short(/(a)(b)?/.exec('a')), 'RegExpMatch ("a" | undefined)[]');
});

test('discriminated unions survive collapsing many shapes', () => {
  let t = [];
  const ops = [
    { op: 'append', text: 'a' }, { op: 'rewrite', text: 'b' }, { op: 'replace', find: 'x', text: 'y' },
    { op: 'create', section: {} }, { op: 'file', path: 'p', content: null }, { op: 'file', path: 'p', content: 'c', mode: 'x' },
    { op: 'param', key: 'k', value: 1 }, { op: 'retire' }, { op: 'situation', text: 's' }, { op: 'append', text: 't', anchor: 'h' },
  ];
  for (const o of ops) t = mergeTy(t, infer(o));
  // Each variant keeps its own shape; variants with identical keys may share one (TypeScript still splits them).
  assert.equal(new Set(t.flatMap((m) => m.props.op[0].lits)).size, 8);
  const file = t.filter((m) => m.props.op[0].lits.includes('file'));
  assert.ok(file.length && file.every((m) => m.props.path && !m.props.text && !m.props.section));
});

test('ctx rendering defers to the declared type where the record is imprecise', () => {
  assert.equal(render(infer({ n: 1, d: new Date(0) }), { mode: 'ts', ctx: 'typeof x' }),
    '{ n: __TrickleN<__TrickleProp<typeof x, "n">>; d: __TrickleB<__TrickleProp<typeof x, "d">, Date> }');
});

test('types-only inference keeps no values and no data-like keys', async () => {
  const { typesOnly } = await import('../dist/types.js');
  const value = {
    email: 'someone@example.com', kind: 'team', ok: true, apiKey: 'sk-live-123',
    byUser: { 'u_8f2a91c3': { name: 'Ada' }, 'someone@example.com': { name: 'Bo' } },
    tags: ['secret-project'],
  };
  const t = infer(value, 400, true);
  const json = JSON.stringify(t);
  for (const leaked of ['example.com', 'team', 'sk-live', 'u_8f2a91c3', 'secret-project', 'Ada', 'lits']) {
    assert.ok(!json.includes(leaked), `${leaked} leaked: ${json}`);
  }
  assert.equal(render(t, { mode: 'short', maxProps: 9 }),
    '{ email: string; kind: string; ok: boolean; apiKey: string; byUser: { [key]: {…} }; tags: string[] }');
  // The server re-applies the same rule to whatever it is sent.
  const sent = [{ k: 'object', props: { 'a@b.com': [{ k: 'string', lits: ['x'] }], ok: [{ k: 'boolean', lits: [true] }] }, evil: 'x' }];
  assert.deepEqual(typesOnly(sent), [{ k: 'object', props: {}, dict: [{ k: 'string' }, { k: 'boolean' }] }]);
  assert.deepEqual(typesOnly([{ k: 'string', lits: ['secret'] }, { k: 'instance', cls: 'bad name!' }, { k: 'nope' }]), [{ k: 'string' }, { k: 'any' }]);
});
