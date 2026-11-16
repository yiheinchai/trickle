// Exercises the bundled VS Code extension against a stub of the `vscode` API (no editor needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { runFixture, PKG } from './helpers.mjs';
import { check } from '../dist/check.js';

const bundle = path.join(PKG, 'vscode', 'dist', 'extension.js');
const skip = !fs.existsSync(bundle) && 'run `npm run vscode:build` first';

function stubVscode(root) {
  const registered = { inlay: null, hover: null, actions: null, commands: {}, diagnostics: new Map(), status: null };
  class EventEmitter { constructor() { this.l = []; this.event = (f) => this.l.push(f); } fire(v) { this.l.forEach((f) => f(v)); } dispose() {} }
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range { constructor(a, b, c, d) { this.start = new Position(a, b); this.end = new Position(c, d); } }
  class MarkdownString { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } appendCodeblock(s, l) { this.value += '```' + l + '\n' + s + '\n```\n'; return this; } }
  const disposable = { dispose() {} };
  const config = { get: (k) => ({ 'hints.enabled': true, 'hints.annotated': false })[k] };
  return {
    registered,
    api: {
      EventEmitter, Position, Range, MarkdownString,
      InlayHint: class { constructor(position, label, kind) { this.position = position; this.label = label; this.kind = kind; } },
      InlayHintKind: { Type: 1 },
      Hover: class { constructor(contents, range) { this.contents = contents; this.range = range; } },
      Diagnostic: class { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } },
      DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
      Uri: { file: (fsPath) => ({ fsPath, with: () => ({}) }) },
      RelativePattern: class {},
      StatusBarAlignment: { Left: 1 },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: root } }],
        getConfiguration: () => config,
        createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
        onDidSaveTextDocument: () => disposable,
        onDidChangeConfiguration: () => disposable,
      },
      window: {
        createStatusBarItem: () => (registered.status = { show() {}, hide() {}, dispose() {} }),
      },
      languages: {
        createDiagnosticCollection: () => ({ clear: () => registered.diagnostics.clear(), set: (uri, list) => registered.diagnostics.set(uri.fsPath, list), dispose() {} }),
        registerInlayHintsProvider: (_s, p) => ((registered.inlay = p), disposable),
        registerHoverProvider: (_s, p) => ((registered.hover = p), disposable),
      },
      commands: { registerCommand: (id, f) => ((registered.commands[id] = f), disposable) },
    },
  };
}

function doc(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  return {
    uri: { fsPath: file }, getText: (r) => (r ? lines[r.start.line].slice(r.start.character, r.end.character) : text),
    getWordRangeAtPosition(pos) {
      const line = lines[pos.line];
      let s = pos.character, e = pos.character;
      while (s > 0 && /[\w$]/.test(line[s - 1])) s--;
      while (e < line.length && /[\w$]/.test(line[e])) e++;
      return s === e ? undefined : { start: { line: pos.line, character: s }, end: { line: pos.line, character: e } };
    },
  };
}

test('inline hints, hovers and drift diagnostics', { skip }, async () => {
  const { dir } = runFixture();
  await check(dir);
  const { api, registered } = stubVscode(dir);
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? api : load.call(this, request, ...rest); };
  const subscriptions = [];
  try {
    const ext = createRequire(import.meta.url)(bundle);
    ext.activate({ subscriptions, asAbsolutePath: (p) => path.join(PKG, 'vscode', p) });
    const file = path.join(dir, 'src', 'lib.ts');
    const d = doc(file);
    const hints = registered.inlay.provideInlayHints(d, new api.Range(0, 0, 1000, 0));
    const labels = hints.map((h) => `${h.position.line + 1}:${h.label}`);
    const has = (re) => assert.ok(labels.some((l) => re.test(l)), `${re}\n${labels.join('\n')}`);
    has(/^5:⚠ : \{ id: "a" \| "b"; tags: null; kind: "skill"; extra: number \}/); // `data`, drifting
    has(/^6:: "a" \| "b"$/); // destructured `id`
    has(/^6:⚠ : null \| "a"\[\]$/); // destructured `tags`: null at runtime, string[] declared
    has(/^4:⚠ ⇒ /); // annotated return of parse: shown because it drifts
    has(/^8:: number$/); // `n = n + 1`
    assert.ok(!labels.some((l) => l.startsWith('7:')), 'annotated `let n: number` without drift is not repeated');

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const line = lines.findIndex((l) => l.includes('const data ='));
    const hover = registered.hover.provideHover(d, new api.Position(line, lines[line].indexOf('data') + 1));
    assert.match(hover.contents.value, /Runtime type\*\* of `data`, seen 4×/);
    assert.match(hover.contents.value, /Drift from the declared type/);

    const diags = registered.diagnostics.get(file);
    assert.ok(diags.some((x) => x.severity === 1 && /^data: tags: runtime null/.test(x.message)), diags.map((x) => x.message).join('\n'));
    assert.ok(diags.some((x) => x.severity === 3 && /^parameter x: declared as any; at runtime it is \{ value: number \}/.test(x.message)));
  } finally {
    Module._load = load;
    for (const s of subscriptions) s.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
