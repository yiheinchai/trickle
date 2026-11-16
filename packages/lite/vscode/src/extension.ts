/**
 * trickle lite for VS Code: the observed runtime type of each value inline, and drift from the declared
 * type as warnings. Follows the project's observations (kept outside it, in ~/.cache/trickle-lite) as they
 * grow, and re-runs the bundled checker when observations change or a file is saved.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Store, locate, type Observation } from '../../src/store.js';
import { render } from '../../src/types.js';
import { dataDir, DRIFT_FILE, toKey } from '../../src/common.js';
import type { Drift, Report } from '../../src/check.js';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'typescript', scheme: 'file' },
  { language: 'typescriptreact', scheme: 'file' },
];

export function activate(context: vscode.ExtensionContext) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const root = folder.uri.fsPath;
  const store = new Store(root);
  const diagnostics = vscode.languages.createDiagnosticCollection('trickle');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'workbench.actions.view.problems';
  const hintsChanged = new vscode.EventEmitter<void>();
  const config = () => vscode.workspace.getConfiguration('trickleLite');
  let report: Report | undefined;
  let checking = false;
  let again = false;
  let timer: NodeJS.Timeout | undefined;

  const driftsFor = (file: string, o: Observation, line: number): Drift[] =>
    report?.drifts.filter((d) => d.file === file && d.line === line && d.name === o.point.n && d.kind === o.point.k) ?? [];

  const updateStatus = () => {
    const files = store.files();
    if (!files.length) return status.hide();
    const values = files.reduce((n, f) => n + store.get(f).length, 0);
    const drifts = report?.drifts.filter((d) => d.severity === 'drift').length ?? 0;
    status.text = `${checking ? '$(sync~spin)' : '$(pulse)'} ${values} runtime types${drifts ? ` · $(warning) ${drifts} drift` : ''}`;
    status.show();
  };

  const loadReport = () => {
    try { report = JSON.parse(fs.readFileSync(path.join(dataDir(root), DRIFT_FILE), 'utf8')); } catch { report = undefined; }
    diagnostics.clear();
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of report?.drifts ?? []) {
      const name = d.name.split('.').pop()!;
      const what = d.kind === 'r' ? `return of ${d.name}` : d.kind === 'p' ? `parameter ${d.name}` : d.name;
      const diag = new vscode.Diagnostic(
        new vscode.Range(d.line - 1, d.col, d.line - 1, d.col + name.length),
        `${what}: ${d.message} (seen ${d.count}×)`,
        d.severity === 'drift' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Hint,
      );
      diag.source = 'trickle';
      byFile.set(d.file, [...(byFile.get(d.file) ?? []), diag]);
    }
    for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(path.join(root, file)), list);
    hintsChanged.fire();
    updateStatus();
  };

  const runCheck = () => {
    if (checking) { again = true; return; }
    if (!store.files().length) return;
    checking = true;
    updateStatus();
    const cli = context.asAbsolutePath(path.join('dist', 'cli.mjs'));
    execFile(process.execPath, [cli, 'check', '--json'], {
      cwd: root, maxBuffer: 64 << 20, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRICKLE_ROOT: root },
    }, () => {
      checking = false;
      loadReport();
      if (again) { again = false; runCheck(); }
    });
  };
  const scheduleCheck = (ms = 1500) => { clearTimeout(timer); timer = setTimeout(runCheck, ms); };

  // Everything observed for this project (Cloudflare Workers, other machines), from trickle-lite's Neon database.
  // The connection string is in VS Code's secret storage, or else wherever `trickle-lite connect` saved it.
  let pulling = false;
  const pull = async () => {
    if (pulling) return;
    pulling = true;
    const url = await Promise.resolve(context.secrets?.get('trickleLite.databaseUrl')).catch(() => undefined);
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRICKLE_ROOT: root };
    if (url) env.TRICKLE_DATABASE_URL = url;
    const projectName = config().get<string>('project');
    if (projectName) env.TRICKLE_PROJECT = projectName;
    execFile(process.execPath, [context.asAbsolutePath(path.join('dist', 'cli.mjs')), 'pull'], { cwd: root, env }, () => {
      pulling = false;
      refresh();
    });
  };

  const refresh = () => {
    let changed = new Set<string>();
    try { changed = store.update(); } catch { /* file mid-write */ }
    if (changed.size) { hintsChanged.fire(); scheduleCheck(); }
    updateStatus();
  };

  const hover = (list: Observation[], file: string, line: number) => {
    const md = new vscode.MarkdownString();
    for (const o of list) {
      md.appendMarkdown(`**Runtime type** of \`${o.point.n}\`${o.point.k === 'r' ? ' (returns)' : ''}, seen ${o.count}×\n`);
      md.appendCodeblock(render(o.ty, { mode: 'pretty', maxDepth: 4 }), 'typescript');
      for (const d of driftsFor(file, o, line)) {
        md.appendMarkdown(d.severity === 'drift' ? '⚠️ **Drift from the declared type**\n' : '**Declared `any`**\n');
        md.appendCodeblock(d.severity === 'drift' ? d.detail : d.message, 'text');
      }
    }
    return md;
  };

  context.subscriptions.push(vscode.languages.registerInlayHintsProvider(SELECTOR, {
    onDidChangeInlayHints: hintsChanged.event,
    provideInlayHints(doc, range) {
      if (!config().get('hints.enabled')) return [];
      const file = toKey(root, doc.uri.fsPath);
      const source = doc.getText();
      const lines = source.split(/\r?\n/);
      const hints: vscode.InlayHint[] = [];
      for (const o of store.get(file, source)) {
        const loc = locate(lines, o.point);
        if (!loc || loc.line - 1 < range.start.line || loc.line - 1 > range.end.line) continue;
        const drift = driftsFor(file, o, loc.line).some((d) => d.severity === 'drift');
        if (o.point.ann && !drift && !config().get('hints.annotated')) continue;
        const pos = loc.exact ? new vscode.Position(o.point.hl - 1, o.point.hc)
          : new vscode.Position(loc.line - 1, loc.col + o.point.n.split('.').pop()!.length);
        let text = render(o.ty, { mode: 'short' });
        if (text.length > 60) text = text.slice(0, 59) + '…';
        const hint = new vscode.InlayHint(pos, (drift ? '⚠ ' : '') + (o.point.k === 'r' ? `⇒ ${text}` : o.point.ann ? `≈ ${text}` : `: ${text}`), vscode.InlayHintKind.Type);
        hint.paddingLeft = o.point.k === 'r' || !!o.point.ann || drift;
        hint.tooltip = hover([o], file, loc.line);
        hints.push(hint);
      }
      return hints;
    },
  }));

  context.subscriptions.push(vscode.languages.registerHoverProvider(SELECTOR, {
    provideHover(doc, position) {
      const word = doc.getWordRangeAtPosition(position, /[\w$]+/);
      if (!word) return;
      const file = toKey(root, doc.uri.fsPath);
      const name = doc.getText(word);
      const source = doc.getText();
      const lines = source.split(/\r?\n/);
      const hits = store.get(file, source).filter((o) => o.point.n.split('.').pop() === name && locate(lines, o.point)?.line === position.line + 1);
      return hits.length ? new vscode.Hover(hover(hits, file, position.line + 1), word) : undefined;
    },
  }));

  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dataDir(root)), '*'));
  watcher.onDidChange((uri) => (uri.fsPath.endsWith(DRIFT_FILE) ? !checking && loadReport() : refresh()));
  watcher.onDidCreate(refresh);
  const poll = setInterval(refresh, 1000); // appends are not always reported as changes
  const pullTimer = setInterval(pull, 15_000);
  context.subscriptions.push(
    watcher, diagnostics, status, hintsChanged, { dispose: () => { clearInterval(poll); clearInterval(pullTimer); clearTimeout(timer); } },
    vscode.commands.registerCommand('trickleLite.check', runCheck),
    vscode.commands.registerCommand('trickleLite.connect', async () => {
      const url = await vscode.window.showInputBox({ prompt: "trickle-lite's Neon connection string (postgres://…)", password: true, ignoreFocusOut: true });
      if (url) { await context.secrets.store('trickleLite.databaseUrl', url.trim()); void pull(); }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => { if (store.get(toKey(root, doc.uri.fsPath)).length) scheduleCheck(500); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('trickleLite')) hintsChanged.fire(); }),
  );
  refresh();
  loadReport();
  void pull();
}

export function deactivate() {}
