/**
 * trickle lite for VS Code.
 *
 * Reads `.trickle/observations.jsonl` as it grows (written by code running under trickle-lite) and shows:
 *  - the observed runtime type of each value, inline;
 *  - a hover with the full type, how often it was seen, and any drift;
 *  - diagnostics where the runtime type does not fit the declared type (from `.trickle/drift.json`,
 *    which the bundled checker rewrites whenever observations change or a TypeScript file is saved).
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Store, locate, type Observation } from '../../src/store.js';
import { render } from '../../src/types.js';
import { DATA_DIR, DRIFT_FILE, OBS_FILE, toKey } from '../../src/common.js';
import type { Drift, Report } from '../../src/check.js';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'typescript', scheme: 'file' },
  { language: 'typescriptreact', scheme: 'file' },
];

export function activate(context: vscode.ExtensionContext) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const root = folder.uri.fsPath;
  const out = vscode.window.createOutputChannel('trickle lite');
  const store = new Store(root);
  const diagnostics = vscode.languages.createDiagnosticCollection('trickle');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'trickleLite.report';
  const hintsChanged = new vscode.EventEmitter<void>();
  let report: Report | undefined;
  let hintsOn = true;
  const config = () => vscode.workspace.getConfiguration('trickleLite');

  // ── Observations ────────────────────────────────────────────────────────
  const refresh = () => {
    let changed: Set<string>;
    try { changed = store.update(); } catch (e) { out.appendLine(`read failed: ${e}`); return; }
    if (changed.size) {
      hintsChanged.fire();
      scheduleCheck();
    }
    updateStatus();
  };

  // ── Drift ───────────────────────────────────────────────────────────────
  const loadReport = () => {
    try {
      report = JSON.parse(fs.readFileSync(path.join(root, DATA_DIR, DRIFT_FILE), 'utf8'));
    } catch {
      report = undefined;
    }
    publishDiagnostics();
    hintsChanged.fire();
    updateStatus();
  };

  const publishDiagnostics = () => {
    diagnostics.clear();
    if (!report) return;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of report.drifts) {
      if (d.severity === 'excess' && !config().get('diagnostics.undeclaredProperties')) continue;
      if (d.severity === 'any' && !config().get('diagnostics.declaredAny')) continue;
      const name = d.name.split('.').pop()!;
      const range = new vscode.Range(d.line - 1, d.col, d.line - 1, d.col + name.length);
      const what = d.kind === 'r' ? `return of ${d.name}` : d.kind === 'p' ? `parameter ${d.name}` : d.name;
      const sev = d.severity === 'drift' ? vscode.DiagnosticSeverity.Warning
        : d.severity === 'excess' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Hint;
      const diag = new vscode.Diagnostic(range, `${what}: ${d.message} (seen ${d.count}×)`, sev);
      diag.source = 'trickle';
      diag.code = d.severity === 'drift' ? 'runtime-drift' : d.severity === 'excess' ? 'undeclared-properties' : 'declared-any';
      const list = byFile.get(d.file) ?? [];
      list.push(diag);
      byFile.set(d.file, list);
    }
    for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(path.join(root, file)), list);
  };

  let checkTimer: NodeJS.Timeout | undefined;
  let checking = false;
  let again = false;
  const scheduleCheck = (delay = 1500) => {
    if (!config().get('check.enabled')) return;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(runCheck, delay);
  };
  const runCheck = () => {
    if (checking) { again = true; return; }
    if (!store.files().length) return;
    checking = true;
    updateStatus();
    const cli = context.asAbsolutePath(path.join('dist', 'cli.mjs'));
    const started = Date.now();
    execFile(process.execPath, [cli, 'check', '--json'], {
      cwd: root, maxBuffer: 64 << 20,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRICKLE_ROOT: root, NO_COLOR: '1' },
    }, (err, stdout, stderr) => {
      checking = false;
      if (stderr) out.appendLine(stderr.trim());
      if (err && !stdout) out.appendLine(`check failed: ${err.message}`);
      else out.appendLine(`checked in ${Date.now() - started}ms`);
      loadReport();
      if (again) { again = false; scheduleCheck(200); }
    });
  };

  const updateStatus = () => {
    const files = store.files();
    if (!files.length) { status.hide(); return; }
    const values = files.reduce((n, f) => n + store.get(f).length, 0);
    const drifts = report?.drifts.filter((d) => d.severity === 'drift').length ?? 0;
    status.text = `${checking ? '$(sync~spin)' : '$(pulse)'} ${values} runtime types${drifts ? ` · $(warning) ${drifts} drift${drifts === 1 ? '' : 's'}` : ''}`;
    status.tooltip = `trickle lite: ${values} observed values in ${files.length} files.` +
      (report ? ` ${drifts} drifts from declared types (checked ${new Date(report.generatedAt).toLocaleTimeString()}).` : '') +
      '\nClick for the drift report.';
    status.show();
  };

  // ── Inline hints ────────────────────────────────────────────────────────
  const driftsAt = (file: string, o: Observation, line: number) =>
    report?.drifts.filter((d) => d.file === file && d.line === line && d.name === o.point.n && d.kind === o.point.k) ?? [];

  context.subscriptions.push(vscode.languages.registerInlayHintsProvider(SELECTOR, {
    onDidChangeInlayHints: hintsChanged.event,
    provideInlayHints(doc, range) {
      if (!hintsOn || !config().get('hints.enabled')) return [];
      const file = toKey(root, doc.uri.fsPath);
      const obs = store.get(file);
      if (!obs.length) return [];
      const lines = doc.getText().split(/\r?\n/);
      const max = config().get<number>('hints.maxLength') ?? 60;
      const showAnnotated = config().get<boolean>('hints.annotated');
      const hints: vscode.InlayHint[] = [];
      for (const o of obs) {
        const loc = locate(lines, o.point);
        if (!loc || loc.line - 1 < range.start.line || loc.line - 1 > range.end.line) continue;
        const drifts = driftsAt(file, o, loc.line).filter((d) => d.severity === 'drift');
        if (o.point.ann && !showAnnotated && !drifts.length) continue;
        const pos = loc.exact ? new vscode.Position(o.point.hl - 1, o.point.hc)
          : new vscode.Position(loc.line - 1, loc.col + o.point.n.split('.').pop()!.length);
        let text = render(o.ty, { mode: 'short' });
        if (text.length > max) text = text.slice(0, max - 1) + '…';
        const label = (drifts.length ? '⚠ ' : '') + (o.point.k === 'r' ? `⇒ ${text}` : o.point.ann ? `≈ ${text}` : `: ${text}`);
        const hint = new vscode.InlayHint(pos, label, vscode.InlayHintKind.Type);
        hint.paddingLeft = o.point.k === 'r' || !!o.point.ann || drifts.length > 0;
        hint.tooltip = hoverFor([o], file, loc.line);
        hints.push(hint);
      }
      return hints;
    },
  }));

  // ── Hover ───────────────────────────────────────────────────────────────
  const hoverFor = (list: Observation[], file: string, line: number) => {
    const md = new vscode.MarkdownString();
    for (const o of list) {
      const p = o.point;
      const what = p.k === 'r' ? `returns of \`${p.n}\`` : `\`${p.n}\`${p.k === 'p' ? ' (parameter)' : ''}`;
      md.appendMarkdown(`**Runtime type** of ${what} — seen ${o.count}×\n`);
      md.appendCodeblock(render(o.ty, { mode: 'pretty', maxDepth: 4 }), 'typescript');
      for (const d of driftsAt(file, o, line)) md.appendMarkdown(driftMarkdown(d));
    }
    md.appendMarkdown(`\n<sub>trickle lite · ${new Date(Math.max(...list.map((o) => o.at))).toLocaleTimeString()}</sub>`);
    md.supportHtml = true;
    return md;
  };

  const driftMarkdown = (d: Drift) => {
    const head = d.severity === 'drift' ? '⚠️ **Drift from the declared type**' : d.severity === 'excess' ? 'ℹ️ **Undeclared properties**' : '💡 **Declared `any`**';
    return `\n${head}: ${escape(d.message)}\n\n` + (d.severity === 'drift' ? '```text\n' + d.detail + '\n```\n' : '');
  };

  context.subscriptions.push(vscode.languages.registerHoverProvider(SELECTOR, {
    provideHover(doc, position) {
      const file = toKey(root, doc.uri.fsPath);
      const obs = store.get(file);
      if (!obs.length) return;
      const word = doc.getWordRangeAtPosition(position, /[\w$]+/);
      if (!word) return;
      const name = doc.getText(word);
      const lines = doc.getText().split(/\r?\n/);
      const hits = obs.filter((o) => {
        if (o.point.n.split('.').pop() !== name) return false;
        const loc = locate(lines, o.point);
        return loc && loc.line - 1 === position.line;
      });
      if (!hits.length) return;
      return new vscode.Hover(hoverFor(hits, file, position.line + 1), word);
    },
  }));

  // ── Quick fix: annotate an `any` with what it really was ────────────────
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider(SELECTOR, {
    provideCodeActions(doc, _range, ctx) {
      const actions: vscode.CodeAction[] = [];
      const file = toKey(root, doc.uri.fsPath);
      for (const diag of ctx.diagnostics) {
        if (diag.source !== 'trickle' || diag.code !== 'declared-any') continue;
        const o = store.get(file).find((x) => x.point.k !== 'r' && x.point.l - 1 === diag.range.start.line && x.point.c === diag.range.start.character);
        if (!o) continue;
        const action = new vscode.CodeAction(`Annotate '${o.point.n}' with its observed runtime type`, vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        // Unannotated: insert after the name. Annotated `: any`: replace the annotation (it ends where the hint goes).
        const end = o.point.ann && o.point.hl - 1 === diag.range.end.line ? new vscode.Position(o.point.hl - 1, o.point.hc) : diag.range.end;
        action.edit.replace(doc.uri, new vscode.Range(diag.range.end.line, diag.range.end.character, end.line, end.character), `: ${render(o.ty, { mode: 'ts' })}`);
        action.diagnostics = [diag];
        actions.push(action);
      }
      return actions;
    },
  }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));

  // ── Commands ────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('trickleLite.check', () => runCheck()),
    vscode.commands.registerCommand('trickleLite.toggleHints', () => { hintsOn = !hintsOn; hintsChanged.fire(); }),
    vscode.commands.registerCommand('trickleLite.clear', () => {
      fs.rmSync(path.join(root, DATA_DIR, OBS_FILE), { force: true });
      fs.rmSync(path.join(root, DATA_DIR, DRIFT_FILE), { force: true });
      refresh();
      loadReport();
    }),
    vscode.commands.registerCommand('trickleLite.report', async () => {
      if (!report) { runCheck(); return; }
      const lines = [`# Runtime type drift — ${report.generatedAt}`, '', `${report.checkedPoints} observed values in ${report.observedFiles} files.`, ''];
      for (const sev of ['drift', 'any', 'excess'] as const) {
        const list = report.drifts.filter((d) => d.severity === sev);
        if (!list.length) continue;
        lines.push(`## ${sev === 'drift' ? 'Drift from declared types' : sev === 'any' ? 'Declared any' : 'Undeclared properties'} (${list.length})`, '');
        for (const d of list) lines.push(`- [${d.file}:${d.line}](${vscode.Uri.file(path.join(root, d.file)).with({ fragment: `L${d.line}` })}) \`${d.name}\` — ${escape(d.message)} (${d.count}×)`);
        lines.push('');
      }
      const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
  );

  // ── Watching ────────────────────────────────────────────────────────────
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `${DATA_DIR}/{${OBS_FILE},${DRIFT_FILE}}`));
  const onFs = (uri: vscode.Uri) => (uri.fsPath.endsWith(DRIFT_FILE) ? (checking ? undefined : loadReport()) : refresh());
  watcher.onDidChange(onFs);
  watcher.onDidCreate(onFs);
  watcher.onDidDelete(onFs);
  // File events can be coalesced or missed for appends; poll cheaply as well.
  const poll = setInterval(refresh, 1000);
  context.subscriptions.push(watcher, diagnostics, status, out, hintsChanged, { dispose: () => clearInterval(poll) });
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
    if (store.get(toKey(root, doc.uri.fsPath)).length) scheduleCheck(500);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('trickleLite')) { publishDiagnostics(); hintsChanged.fire(); }
  }));

  refresh();
  loadReport();
}

function escape(s: string): string {
  return s.replace(/[\\`*_{}[\]<>]/g, (c) => '\\' + c);
}

export function deactivate() {}
