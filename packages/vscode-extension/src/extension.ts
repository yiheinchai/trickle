import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Walk up from `startDir` looking for a `.trickle` directory.
 * Stops at the workspace root (or filesystem root). Returns the
 * `.trickle` directory path, or undefined if not found.
 */
function findNearestTrickleDir(startDir: string): string | undefined {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  // Collect workspace roots so we know when to stop walking
  const roots = new Set<string>(
    (workspaceFolders || []).map(f => f.uri.fsPath),
  );

  let dir = startDir;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, '.trickle');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    // Stop if we reached a workspace root (we already checked it)
    if (roots.has(dir)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return undefined;
}

/** Cache: directory path → nearest .trickle directory (or null if none found). */
const trickleDirCache = new Map<string, string | null>();

/** Cached version of findNearestTrickleDir. */
function findNearestTrickleDirCached(startDir: string): string | undefined {
  if (trickleDirCache.has(startDir)) {
    return trickleDirCache.get(startDir) ?? undefined;
  }
  const result = findNearestTrickleDir(startDir);
  trickleDirCache.set(startDir, result ?? null);
  return result;
}

/** Invalidate the trickle-dir cache (called when .trickle dirs are created/deleted). */
function clearTrickleDirCache(): void {
  trickleDirCache.clear();
}

/**
 * Recursively find all `.trickle` directories under a given root.
 * Uses a breadth-first walk. Skips node_modules, .git, etc.
 */
function findAllTrickleDirs(rootDir: string): string[] {
  const results: string[] = [];
  const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build']);
  const queue = [rootDir];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.trickle') {
        results.push(path.join(dir, entry.name));
      } else if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) {
        queue.push(path.join(dir, entry.name));
      }
    }
  }
  return results;
}

/**
 * Collect all variables.jsonl paths across all workspace folders,
 * including subdirectory .trickle folders.
 */
function findAllVariablesJsonlPaths(): string[] {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const paths: string[] = [];
  for (const folder of (workspaceFolders || [])) {
    const trickleDirs = findAllTrickleDirs(folder.uri.fsPath);
    for (const td of trickleDirs) {
      const jsonlPath = path.join(td, 'variables.jsonl');
      if (fs.existsSync(jsonlPath)) {
        paths.push(jsonlPath);
      }
    }
  }
  // Also include .trickle dirs outside the workspace (e.g. subrepos, sibling projects)
  for (const td of extraTrickleDirs) {
    const jsonlPath = path.join(td, 'variables.jsonl');
    if (fs.existsSync(jsonlPath) && !paths.includes(jsonlPath)) {
      paths.push(jsonlPath);
    }
  }
  return paths;
}

/**
 * Collect all errors.jsonl paths across all workspace folders,
 * including subdirectory .trickle folders.
 */
function findAllErrorsJsonlPaths(): string[] {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const paths: string[] = [];
  for (const folder of (workspaceFolders || [])) {
    const trickleDirs = findAllTrickleDirs(folder.uri.fsPath);
    for (const td of trickleDirs) {
      const errorsPath = path.join(td, 'errors.jsonl');
      if (fs.existsSync(errorsPath)) {
        paths.push(errorsPath);
      }
    }
  }
  // Also include .trickle dirs outside the workspace
  for (const td of extraTrickleDirs) {
    const errorsPath = path.join(td, 'errors.jsonl');
    if (fs.existsSync(errorsPath) && !paths.includes(errorsPath)) {
      paths.push(errorsPath);
    }
  }
  return paths;
}

interface CallFlowInput {
  name: string;
  type: TypeNode;
}

interface CallFlow {
  callee: string;
  calleeClass?: string;
  inputs: CallFlowInput[];
}

/** A single variable observation from variables.jsonl */
interface VariableObservation {
  kind: 'variable';
  varName: string;
  line: number;
  module: string;
  file: string;
  cellIndex?: number;
  type: TypeNode;
  typeHash: string;
  sample: unknown;
  funcName?: string;
  callFlow?: CallFlow;
  gpu_memory_mb?: number;
  gpu_reserved_mb?: number;
  cpu_memory_mb?: number;
  /** Previous sample values (for showing value history in hover tooltip) */
  previousSamples?: unknown[];
}

interface TypeNode {
  kind: string;
  name?: string;
  class_name?: string;
  element?: TypeNode;
  elements?: TypeNode[];
  members?: TypeNode[];  // Python uses "members" for union types
  properties?: Record<string, TypeNode>;
  resolved?: TypeNode;
  key?: TypeNode;
  value?: TypeNode;
}

/** Index: filePath -> Map<lineNumber, observation[]> */
type VarIndex = Map<string, Map<number, VariableObservation[]>>;

/** Index for notebook cells: "notebookPath#cell_N" -> Map<lineNumber, observation[]> */
type NotebookCellIndex = Map<string, Map<number, VariableObservation[]>>;

/** A local variable captured at the crash frame */
interface CrashLocalVar {
  name: string;
  type_str: string;
  value: string | null;
}

/** A runtime error record from errors.jsonl */
interface ErrorRecord {
  kind: 'error';
  error_type: string;
  message: string;
  file: string;
  line: number;
  function: string;
  shape_context: string[];
  local_vars?: CrashLocalVar[];
  local_vars_file?: string;
  local_vars_line?: number;
  frames: { file: string; line: number; function: string }[];
}

let varIndex: VarIndex = new Map();
let notebookCellIndex: NotebookCellIndex = new Map();
/** Crash-site local vars: filePath -> lineNo -> CrashLocalVar[] */
let crashVarIndex: Map<string, Map<number, CrashLocalVar[]>> = new Map();
/** Error snapshot observations: same structure as varIndex but captured at crash time */
let errorSnapshotIndex: Map<string, Map<number, VariableObservation[]>> = new Map();
/** The error message from the most recent error snapshot */
let lastErrorMessage: string | undefined;
let fileWatcher: vscode.FileSystemWatcher | undefined;
let errorFileWatcher: vscode.FileSystemWatcher | undefined;
/** .trickle dirs discovered outside all workspace folders (e.g. files in a sibling/subrepo) */
const extraTrickleDirs = new Set<string>();
let statusBarItem: vscode.StatusBarItem;
let modeStatusBarItem: vscode.StatusBarItem;
let inlineHintsProvider: vscode.Disposable | undefined;
let diagnosticCollection: vscode.DiagnosticCollection;
/** Fires to tell VSCode to re-query inlay hints after data changes. */
const inlayHintsChangeEmitter = new vscode.EventEmitter<void>();

/** Type hashes from the previous load: "file:line:varName" → typeHash */
let prevTypeHashes: Map<string, string> = new Map();
/** Variables whose type changed since the last run: "file:line:varName" */
let changedVarKeys: Set<string> = new Set();

/** Load persisted type hashes from all .trickle/type_history.json files for cross-session drift detection. */
function loadTypeHistory(): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;
  for (const folder of workspaceFolders) {
    for (const trickleDir of findAllTrickleDirs(folder.uri.fsPath)) {
      const historyPath = path.join(trickleDir, 'type_history.json');
      try {
        if (fs.existsSync(historyPath)) {
          const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
          if (data && typeof data === 'object') {
            for (const [k, v] of Object.entries(data)) {
              prevTypeHashes.set(k, v as string);
            }
          }
        }
      } catch {
        // Ignore — corrupt or missing history is non-fatal
      }
    }
  }
}

/** Persist current type hashes to all discovered .trickle/type_history.json files.
 *  Falls back to workspace root .trickle/ if no existing dirs found. */
function saveTypeHistory(hashes: Map<string, string>): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;

  // Collect all existing .trickle dirs; fall back to workspace root
  const allTrickleDirs: string[] = [];
  for (const folder of workspaceFolders) {
    const found = findAllTrickleDirs(folder.uri.fsPath);
    if (found.length > 0) {
      allTrickleDirs.push(...found);
    } else {
      allTrickleDirs.push(path.join(folder.uri.fsPath, '.trickle'));
    }
  }

  const obj: Record<string, string> = {};
  hashes.forEach((v, k) => { obj[k] = v; });
  const json = JSON.stringify(obj);

  for (const trickleDir of allTrickleDirs) {
    try {
      if (!fs.existsSync(trickleDir)) fs.mkdirSync(trickleDir, { recursive: true });
      fs.writeFileSync(path.join(trickleDir, 'type_history.json'), json, 'utf8');
    } catch {
      // Non-fatal — persistence is best-effort
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.command = 'trickle.refreshVariables';
  context.subscriptions.push(statusBarItem);

  modeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
  modeStatusBarItem.command = 'trickle.cycleInlineHintMode';
  context.subscriptions.push(modeStatusBarItem);
  updateModeStatusBar();

  // Create diagnostic collection for error reporting
  diagnosticCollection = vscode.languages.createDiagnosticCollection('trickle');
  context.subscriptions.push(diagnosticCollection);

  // Load persisted type hashes before first variable load (enables cross-session drift detection)
  loadTypeHistory();

  // Load variable data
  loadAllVariables();
  loadErrors();

  // Register hover provider for all common file types (JS/TS and Python)
  const selector: vscode.DocumentSelector = [
    { scheme: 'file', language: 'typescript' },
    { scheme: 'file', language: 'typescriptreact' },
    { scheme: 'file', language: 'javascript' },
    { scheme: 'file', language: 'javascriptreact' },
    { scheme: 'file', language: 'python' },
    // Jupyter notebook cells in VSCode
    { scheme: 'vscode-notebook-cell', language: 'python' },
  ];

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, new TrickleHoverProvider()),
  );

  // Register inline hints provider
  registerInlineHints(context, selector);

  // Register completion provider for runtime-type-aware autocomplete
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector,
      new TrickleCompletionProvider(),
      '.', // trigger on dot
    ),
  );

  // Register semantic token provider for runtime-type-aware syntax highlighting
  const semanticLegend = new vscode.SemanticTokensLegend(
    ['property', 'method', 'variable'],
    ['declaration', 'readonly'],
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      selector,
      new TrickleSemanticTokensProvider(),
      semanticLegend,
    ),
  );

  // Watch for changes to variables.jsonl in ANY subdirectory (not just workspace root)
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    // Use glob pattern to watch **/.trickle/variables.jsonl across all workspace folders
    for (const folder of workspaceFolders) {
      const pattern = new vscode.RelativePattern(folder, '**/.trickle/variables.jsonl');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      let reloadTimer: ReturnType<typeof setTimeout> | undefined;
      const debouncedReload = () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        clearTrickleDirCache();
        reloadTimer = setTimeout(() => loadAllVariables(), 300);
      };

      watcher.onDidChange(debouncedReload);
      watcher.onDidCreate(debouncedReload);
      watcher.onDidDelete(() => {
        if (reloadTimer) clearTimeout(reloadTimer);
        clearTrickleDirCache();
        varIndex.clear();
        notebookCellIndex.clear();
        updateStatusBar();
        refreshInlineHints();
      });
      context.subscriptions.push(watcher);
      // Keep reference to first watcher for deactivate
      if (!fileWatcher) fileWatcher = watcher;

      // Watch errors.jsonl in ANY subdirectory
      const errorPattern = new vscode.RelativePattern(folder, '**/.trickle/errors.jsonl');
      const errWatcher = vscode.workspace.createFileSystemWatcher(errorPattern);

      let errorReloadTimer: ReturnType<typeof setTimeout> | undefined;
      const debouncedErrorReload = () => {
        if (errorReloadTimer) clearTimeout(errorReloadTimer);
        clearTrickleDirCache();
        errorReloadTimer = setTimeout(() => { loadErrors(); refreshInlineHints(); }, 300);
      };

      errWatcher.onDidChange(debouncedErrorReload);
      errWatcher.onDidCreate(debouncedErrorReload);
      errWatcher.onDidDelete(() => {
        if (errorReloadTimer) clearTimeout(errorReloadTimer);
        clearTrickleDirCache();
        diagnosticCollection.clear();
        crashVarIndex.clear();
        refreshInlineHints();
      });
      context.subscriptions.push(errWatcher);
      if (!errorFileWatcher) errorFileWatcher = errWatcher;
    }
  }

  // Watch .trickle dirs for files opened outside workspace folders (subrepo support)
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (!editor || editor.document.uri.scheme !== 'file') return;
      const fileDir = path.dirname(editor.document.uri.fsPath);
      const trickleDir = findNearestTrickleDirCached(fileDir);
      if (!trickleDir) return;
      const workspaceFolders = vscode.workspace.workspaceFolders || [];
      const isInWorkspace = workspaceFolders.some(f => trickleDir.startsWith(f.uri.fsPath));
      if (isInWorkspace || extraTrickleDirs.has(trickleDir)) return;
      extraTrickleDirs.add(trickleDir);
      loadAllVariables();
      const w = vscode.workspace.createFileSystemWatcher(path.join(trickleDir, 'variables.jsonl'));
      w.onDidChange(() => { clearTrickleDirCache(); setTimeout(() => loadAllVariables(), 300); });
      w.onDidCreate(() => { clearTrickleDirCache(); setTimeout(() => loadAllVariables(), 300); });
      context.subscriptions.push(w);
      const ew = vscode.workspace.createFileSystemWatcher(path.join(trickleDir, 'errors.jsonl'));
      ew.onDidChange(() => { clearTrickleDirCache(); setTimeout(() => { loadErrors(); refreshInlineHints(); }, 300); });
      ew.onDidCreate(() => { clearTrickleDirCache(); setTimeout(() => { loadErrors(); refreshInlineHints(); }, 300); });
      context.subscriptions.push(ew);
    })
  );

  // Watch for source file edits — shift hint line numbers and invalidate edited lines
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.contentChanges.length === 0) return; // metadata-only change

      // Resolve the line map: regular files use varIndex, notebook cells use notebookCellIndex
      let lineMap: Map<number, VariableObservation[]> | undefined;
      let lineMapParent: { index: Map<string, Map<number, VariableObservation[]>>; key: string } | undefined;

      if (e.document.uri.scheme === 'vscode-notebook-cell') {
        lineMap = getLineMapForDocument(e.document);
        // Find which key in notebookCellIndex this maps to so we can clean up
        if (lineMap) {
          for (const [key, lm] of notebookCellIndex) {
            if (lm === lineMap) {
              lineMapParent = { index: notebookCellIndex, key };
              break;
            }
          }
        }
      } else {
        const filePath = e.document.uri.fsPath;
        lineMap = varIndex.get(filePath);
        if (lineMap) {
          lineMapParent = { index: varIndex, key: filePath };
        }
      }

      if (!lineMap) return;

      // Process changes in reverse order (bottom-up) so earlier changes
      // don't affect the line numbers of later changes
      const sortedChanges = [...e.contentChanges].sort(
        (a, b) => b.range.start.line - a.range.start.line,
      );

      for (const change of sortedChanges) {
        const startLine1 = change.range.start.line + 1; // 1-based
        const endLine1 = change.range.end.line + 1;
        const oldLineCount = endLine1 - startLine1 + 1;
        const newLineCount = change.text.split('\n').length;
        const lineDelta = newLineCount - oldLineCount;

        // Build new line map with shifted entries
        const newEntries: [number, VariableObservation[]][] = [];
        const toDelete: number[] = [];

        for (const [line, obs] of lineMap) {
          if (line >= startLine1 && line <= endLine1) {
            // Line was directly edited — invalidate these hints
            toDelete.push(line);
          } else if (line > endLine1 && lineDelta !== 0) {
            // Line is below the edit — shift it
            toDelete.push(line);
            const newLine = line + lineDelta;
            // Update the line number in each observation too
            const shifted = obs.map(o => ({ ...o, line: newLine }));
            newEntries.push([newLine, shifted]);
          }
          // Lines above the edit are unchanged
        }

        for (const line of toDelete) {
          lineMap.delete(line);
        }
        for (const [line, obs] of newEntries) {
          lineMap.set(line, obs);
        }
      }

      // If the map is now empty, remove the file entry entirely
      if (lineMap.size === 0 && lineMapParent) {
        lineMapParent.index.delete(lineMapParent.key);
      }

      updateStatusBar();
      refreshInlineHints();
    }),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('trickle.refreshVariables', () => {
      loadAllVariables();
      vscode.window.showInformationMessage(`Trickle: Loaded ${countVars()} variable observations`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('trickle.clearVariables', () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders) {
        let cleared = false;
        for (const folder of workspaceFolders) {
          for (const trickleDir of findAllTrickleDirs(folder.uri.fsPath)) {
            try {
              const jsonlPath = path.join(trickleDir, 'variables.jsonl');
              if (fs.existsSync(jsonlPath)) fs.writeFileSync(jsonlPath, '');
              const errorsPath = path.join(trickleDir, 'errors.jsonl');
              if (fs.existsSync(errorsPath)) fs.writeFileSync(errorsPath, '');
              cleared = true;
            } catch { /* ignore individual failures */ }
          }
        }
        varIndex.clear();
        notebookCellIndex.clear();
        errorSnapshotIndex.clear();
        lastErrorMessage = undefined;
        diagnosticCollection.clear();
        clearTrickleDirCache();
        updateStatusBar();
        refreshInlineHints();
        if (cleared) {
          vscode.window.showInformationMessage('Trickle: Variable data cleared');
        } else {
          vscode.window.showErrorMessage('Trickle: No .trickle directories found to clear');
        }
      }
    }),
  );

  // Toggle inline hints on/off
  context.subscriptions.push(
    vscode.commands.registerCommand('trickle.toggleInlineHints', async () => {
      const config = vscode.workspace.getConfiguration('trickle');
      const current = config.get('inlineHints', true);
      await config.update('inlineHints', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Trickle: Inline hints ${!current ? 'enabled' : 'disabled'}`);
    }),
  );

  // Cycle inline hint mode: auto → sample → type → (error if available) → auto
  context.subscriptions.push(
    vscode.commands.registerCommand('trickle.cycleInlineHintMode', async () => {
      const config = vscode.workspace.getConfiguration('trickle');
      const current = config.get<string>('inlineHintMode', 'auto');
      const order = errorSnapshotIndex.size > 0
        ? ['auto', 'sample', 'type', 'error']
        : ['auto', 'sample', 'type'];
      const next = order[(order.indexOf(current) + 1) % order.length];
      await config.update('inlineHintMode', next, vscode.ConfigurationTarget.Global);
      refreshInlineHints();
      updateModeStatusBar();
      vscode.window.showInformationMessage(`Trickle: Inline hint mode → ${next}`);
    }),
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('trickle.inlineHints')) {
        registerInlineHints(context, selector);
      }
      if (e.affectsConfiguration('trickle.inlineHintMode')) {
        refreshInlineHints();
        updateModeStatusBar();
      }
    }),
  );
}

export function deactivate() {
  fileWatcher?.dispose();
  errorFileWatcher?.dispose();
  inlineHintsProvider?.dispose();
  inlayHintsChangeEmitter.dispose();
  diagnosticCollection?.dispose();
}

function countVars(): number {
  let count = 0;
  for (const lineMap of varIndex.values()) {
    for (const obs of lineMap.values()) {
      count += obs.length;
    }
  }
  for (const lineMap of notebookCellIndex.values()) {
    for (const obs of lineMap.values()) {
      count += obs.length;
    }
  }
  return count;
}

function updateStatusBar() {
  const count = countVars();
  if (count > 0) {
    statusBarItem.text = `$(symbol-variable) Trickle: ${count} vars`;
    statusBarItem.tooltip = 'Click to refresh trickle variable data';
    statusBarItem.show();
  } else {
    statusBarItem.hide();
  }
  updateModeStatusBar();
}

function updateModeStatusBar() {
  const config = vscode.workspace.getConfiguration('trickle');
  const mode = config.get<string>('inlineHintMode', 'auto');
  const icons: Record<string, string> = {
    auto: '$(symbol-misc)',
    sample: '$(symbol-value)',
    type: '$(symbol-type-parameter)',
    error: '$(error)',
  };
  const icon = icons[mode] || '$(symbol-misc)';
  const hasErrors = errorSnapshotIndex.size > 0;
  modeStatusBarItem.text = `${icon} ${mode}`;
  modeStatusBarItem.tooltip = `Trickle hint mode: ${mode}\nClick to cycle (auto → sample → type${hasErrors ? ' → error' : ''})`;
  if (countVars() > 0 || hasErrors) {
    modeStatusBarItem.show();
  } else {
    modeStatusBarItem.hide();
  }
}

function loadAllVariables() {
  const config = vscode.workspace.getConfiguration('trickle');
  if (!config.get('enabled', true)) {
    varIndex.clear();
    updateStatusBar();
    return;
  }

  varIndex.clear();
  notebookCellIndex.clear();
  errorSnapshotIndex.clear();
  lastErrorMessage = undefined;

  // Find all variables.jsonl files across all workspace folders and subdirectories
  const allJsonlPaths = findAllVariablesJsonlPaths();
  if (allJsonlPaths.length === 0) {
    updateStatusBar();
    refreshInlineHints();
    return;
  }

  for (const jsonlPath of allJsonlPaths) {
    try {
      const content = fs.readFileSync(jsonlPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const record = JSON.parse(line);

          // Handle error snapshot records (captured at crash time)
          if (record.kind === 'error_snapshot') {
            const snap = record as VariableObservation;
            snap.kind = 'variable'; // normalize for reuse in hint rendering
            let snapPath = snap.file;
            try { snapPath = fs.realpathSync(snapPath); } catch { /* keep original */ }

            // Index into errorSnapshotIndex (same structure as varIndex)
            if (!errorSnapshotIndex.has(snapPath)) {
              errorSnapshotIndex.set(snapPath, new Map());
            }
            const snapLineMap = errorSnapshotIndex.get(snapPath)!;

            // Place each error_snapshot hint on its original assignment line
            // (from the regular observation index) instead of the error line,
            // so error mode looks like auto mode but with crash-time values.
            const isCell = snapPath.match(/#cell_(\d+)$/) || snapPath.match(/__notebook__cell_(\d+)\.py$/);
            const regularIndex = isCell ? notebookCellIndex : varIndex;
            let targetLine = snap.line; // default: the error line from the record
            const regularLineMap = regularIndex.get(snapPath);
            if (regularLineMap) {
              for (const [ln, obs] of regularLineMap) {
                if (obs.some(o => o.varName === snap.varName)) {
                  targetLine = ln;
                  break;
                }
              }
            }

            if (!snapLineMap.has(targetLine)) {
              snapLineMap.set(targetLine, []);
            }
            const snapExisting = snapLineMap.get(targetLine)!;
            const snapIdx = snapExisting.findIndex(o => o.varName === snap.varName);
            if (snapIdx >= 0) {
              snapExisting[snapIdx] = snap;
            } else {
              snapExisting.push(snap);
            }
            lastErrorMessage = (record as any).error || lastErrorMessage;
            continue;
          }

          const obs = record as VariableObservation;
          if (obs.kind !== 'variable') continue;

          // Resolve symlinks so paths match VSCode's document.uri.fsPath
          let filePath = obs.file;
          try { filePath = fs.realpathSync(filePath); } catch { /* keep original if file doesn't exist */ }

          // Check if this is a notebook cell observation
          // Format: "/path/to/notebook.ipynb#cell_N" or "__notebook__cell_N.py"
          const cellMatch = filePath.match(/#cell_(\d+)$/) || filePath.match(/__notebook__cell_(\d+)\.py$/);
          if (cellMatch) {
            // Index by the full cell identifier
            if (!notebookCellIndex.has(filePath)) {
              notebookCellIndex.set(filePath, new Map());
            }
            const lineMap = notebookCellIndex.get(filePath)!;
            if (!lineMap.has(obs.line)) {
              lineMap.set(obs.line, []);
            }
            // Deduplicate: replace existing observation with same varName (last wins)
            const existing = lineMap.get(obs.line)!;
            const existingIdx = existing.findIndex(o => o.varName === obs.varName);
            if (existingIdx >= 0) {
              existing[existingIdx] = obs;
            } else {
              existing.push(obs);
            }
            continue;
          }

          if (!varIndex.has(filePath)) {
            varIndex.set(filePath, new Map());
          }
          const lineMap = varIndex.get(filePath)!;

          if (!lineMap.has(obs.line)) {
            lineMap.set(obs.line, []);
          }
          // Deduplicate: replace existing observation with same varName (last wins for inline display)
          // But preserve previous samples for hover tooltip value history
          const existingVars = lineMap.get(obs.line)!;
          const existingVarIdx = existingVars.findIndex(o => o.varName === obs.varName);
          if (existingVarIdx >= 0) {
            const prev = existingVars[existingVarIdx];
            const prevSamples = prev.previousSamples || [];
            // Keep up to 4 previous samples (so total history is 5 with current)
            if (prevSamples.length < 4) {
              prevSamples.push(prev.sample);
            }
            obs.previousSamples = prevSamples;
            existingVars[existingVarIdx] = obs;
          } else {
            existingVars.push(obs);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File read error
    }
  }

  // Build hashes from freshly-loaded data
  const newHashes: Map<string, string> = new Map();
  for (const [filePath, lineMap] of varIndex) {
    for (const [lineNo, obsArr] of lineMap) {
      for (const obs of obsArr) {
        const key = `${filePath}:${lineNo}:${obs.varName}`;
        newHashes.set(key, obs.typeHash);
      }
    }
  }

  // Detect type drift: compare new hashes against previous run's hashes
  changedVarKeys.clear();
  if (prevTypeHashes.size > 0) {
    for (const [key, newHash] of newHashes) {
      const prev = prevTypeHashes.get(key);
      if (prev !== undefined && prev !== newHash) {
        changedVarKeys.add(key);
      }
    }
  }

  // Update baseline and persist for cross-session drift detection
  prevTypeHashes = newHashes;
  saveTypeHistory(newHashes);

  updateStatusBar();
  refreshInlineHints();
}

function loadErrors() {
  diagnosticCollection.clear();
  crashVarIndex.clear();

  // Find all errors.jsonl files across all workspace folders and subdirectories
  const allErrorPaths = findAllErrorsJsonlPaths();

  for (const errorsPath of allErrorPaths) {
    try {
      const content = fs.readFileSync(errorsPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());

      const diagsByFile = new Map<string, vscode.Diagnostic[]>();

      for (const line of lines) {
        try {
          const err: ErrorRecord = JSON.parse(line);
          if (err.kind !== 'error') continue;

          // Store crash-site local vars for inlay hints
          if (err.local_vars && err.local_vars.length > 0) {
            const varFile = err.local_vars_file || err.file;
            const varLine = err.local_vars_line || err.line;
            if (varFile && varLine) {
              if (!crashVarIndex.has(varFile)) {
                crashVarIndex.set(varFile, new Map());
              }
              crashVarIndex.get(varFile)!.set(varLine, err.local_vars);
            }
          }

          // Build diagnostic message with local vars + shape context
          let message = `${err.error_type}: ${err.message}`;
          if (err.local_vars && err.local_vars.length > 0) {
            const varLines = err.local_vars.map(v =>
              v.value !== null && v.value !== undefined
                ? `  ${v.name}: ${v.type_str} = ${v.value}`
                : `  ${v.name}: ${v.type_str}`,
            );
            message += '\n\nLocal variables at crash:\n' + varLines.join('\n');
          }
          if (err.shape_context && err.shape_context.length > 0) {
            message += '\n\nTensor shapes near error:\n' + err.shape_context.join('\n');
          }

          // Create diagnostic at crash site
          const crashLine = Math.max(0, err.line - 1); // 0-based
          const range = new vscode.Range(crashLine, 0, crashLine, 1000);
          const diag = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
          diag.source = 'trickle';

          // Add related information for stack frames
          const relatedInfo: vscode.DiagnosticRelatedInformation[] = [];
          for (const frame of (err.frames || []).slice(1, 6)) {
            const frameLine = Math.max(0, frame.line - 1);
            const frameUri = vscode.Uri.file(frame.file);
            const frameRange = new vscode.Range(frameLine, 0, frameLine, 1000);
            const loc = new vscode.Location(frameUri, frameRange);
            relatedInfo.push(new vscode.DiagnosticRelatedInformation(
              loc, `in ${frame.function} (${path.basename(frame.file)}:${frame.line})`,
            ));
          }
          if (relatedInfo.length > 0) {
            diag.relatedInformation = relatedInfo;
          }

          const filePath = err.file;
          if (!diagsByFile.has(filePath)) {
            diagsByFile.set(filePath, []);
          }
          diagsByFile.get(filePath)!.push(diag);
        } catch {
          // Skip malformed lines
        }
      }

      // Set diagnostics for each file
      for (const [filePath, diags] of diagsByFile) {
        diagnosticCollection.set(vscode.Uri.file(filePath), diags);
      }
    } catch {
      // File read error
    }
  }
}

/** Get the line map for a document, handling both regular files and notebook cells. */
function getLineMapForDocument(document: vscode.TextDocument): Map<number, VariableObservation[]> | undefined {
  // Regular file
  if (document.uri.scheme === 'file') {
    return varIndex.get(document.uri.fsPath);
  }

  // Notebook cell: URI looks like vscode-notebook-cell:/path/notebook.ipynb#fragment
  if (document.uri.scheme === 'vscode-notebook-cell') {
    // Always use content-based matching as the primary method.
    // Python's cell_counter increments on every execution (including re-runs),
    // so cell IDs like "cell_3" don't correspond to cell positions. Content
    // matching correctly handles re-runs by finding the most recent entry
    // whose variables match the cell's text.
    const cellText = document.getText();
    return findBestMatchingCell(cellText);
  }

  return undefined;
}

/** Find the notebook cell entry whose variables best match the cell text.
 * When multiple entries tie, prefers the one with the highest cell counter
 * (most recent execution). */
function findBestMatchingCell(cellText: string): Map<number, VariableObservation[]> | undefined {
  return findBestMatchingCellIn(cellText, notebookCellIndex);
}

/** Generic version: search any cell index for the best content match.
 * Uses ratio-based scoring (matched / total) so an entry where all variables
 * match is preferred over one where only a few out of many match.
 * Requires at least 50% of variables to match to avoid false positives
 * from common variable names (e.g. `x`, `i`) appearing in unrelated cells. */
function findBestMatchingCellIn(
  cellText: string,
  index: Map<string, Map<number, VariableObservation[]>>,
): Map<number, VariableObservation[]> | undefined {
  let bestMatch: Map<number, VariableObservation[]> | undefined;
  let bestRatio = 0;
  let bestScore = 0;
  let bestCellNum = -1;

  for (const [key, lineMap] of index) {
    let score = 0;
    let total = 0;
    for (const obsArr of lineMap.values()) {
      for (const obs of obsArr) {
        total++;
        // Skip special names like <return> that won't appear literally in source
        if (obs.varName.startsWith('<')) continue;
        const varPattern = new RegExp(`\\b${escapeRegex(obs.varName)}\\b`);
        if (varPattern.test(cellText)) {
          score++;
        }
      }
    }

    const ratio = total > 0 ? score / total : 0;

    // Extract cell number from key for tie-breaking (prefer most recent)
    const cellNumMatch = key.match(/cell_(\d+)/);
    const cellNum = cellNumMatch ? parseInt(cellNumMatch[1], 10) : 0;

    // Prefer higher ratio; on tie, prefer higher absolute score; then most recent cell
    if (ratio > bestRatio ||
        (ratio === bestRatio && score > bestScore) ||
        (ratio === bestRatio && score === bestScore && cellNum > bestCellNum)) {
      bestRatio = ratio;
      bestScore = score;
      bestMatch = lineMap;
      bestCellNum = cellNum;
    }
  }

  // Require at least 50% of variables to match to avoid cross-cell contamination
  if (bestMatch && bestRatio >= 0.5) return bestMatch;
  return undefined;
}


class TrickleHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const config = vscode.workspace.getConfiguration('trickle');
    if (!config.get('enabled', true)) return undefined;

    const lineMap = getLineMapForDocument(document);
    if (!lineMap) return undefined;

    // Get the word at the cursor
    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_$][a-zA-Z0-9_$]*/);
    if (!wordRange) return undefined;

    const word = document.getText(wordRange);
    const lineNo = position.line + 1; // JSONL uses 1-based lines

    // Look for observations at this line with this variable name
    // Also check nearby lines (the line in JSONL might be the declaration line,
    // but the user might hover on a usage line)
    const candidates: VariableObservation[] = [];

    // Try to get the full "obj.attr" text if the cursor is on an attribute
    const lineText = document.lineAt(position.line).text;
    const attrRange = document.getWordRangeAtPosition(position, /[a-zA-Z_$][a-zA-Z0-9_$]*\.[a-zA-Z_$][a-zA-Z0-9_$]*/);
    const attrWord = attrRange ? document.getText(attrRange) : null;

    // Check exact line first
    const obsAtLine = lineMap.get(lineNo);
    if (obsAtLine) {
      for (const obs of obsAtLine) {
        if (obs.varName === word) candidates.push(obs);
        // Match attribute vars: hovering on "weight" matches "self.weight"
        if (attrWord && obs.varName === attrWord) candidates.push(obs);
        // Also match when varName is "self.x" and word is "x" (attr part)
        if (obs.varName.endsWith('.' + word) && obs.varName.includes('.')) candidates.push(obs);
        // Show return value info when hovering over "return" keyword
        if (word === 'return' && (obs.varName === '<return>' || obs.varName.startsWith('<return:'))) {
          candidates.push(obs);
        }
      }
    }

    // If no exact match, search all lines in this file for this variable name
    if (candidates.length === 0) {
      for (const [, obsArr] of lineMap) {
        for (const obs of obsArr) {
          if (obs.varName === word) candidates.push(obs);
          if (attrWord && obs.varName === attrWord) candidates.push(obs);
        }
      }
    }

    if (candidates.length === 0) return undefined;

    // Build hover content
    const showSamples = config.get('showSampleValues', true);
    const parts: string[] = [];

    // For tensor variables with funcName, collect all observations of the same
    // variable in the same function to show "shape flow" (how shape transforms)
    const shapeFlowShown = new Set<string>();

    for (const obs of candidates) {
      const typeStr = typeNodeToString(obs.type, 3);
      const className = obs.type?.class_name;
      const funcCtx = obs.funcName ? ` in \`${obs.funcName}\`` : '';

      // For tensors, show shape flow if available
      if ((className === 'Tensor' || className === 'ndarray') && obs.funcName) {
        const flowKey = `${obs.varName}:${obs.funcName}`;
        if (shapeFlowShown.has(flowKey)) continue;
        shapeFlowShown.add(flowKey);

        // Find all observations of this variable in the same function
        const flowObs = collectShapeFlow(lineMap, obs.varName, obs.funcName);

        if (flowObs.length > 1) {
          // Show shape flow chain
          parts.push(`**\`${obs.varName}\`**${funcCtx} — shape flow:`);
          const flowLines: string[] = [];
          for (const fo of flowObs) {
            const shape = extractShapeStr(fo.type);
            const stats = formatTensorStats(fo.type);
            const marker = fo.line === obs.line ? ' **←**' : '';
            const callStr = fo.callFlow ? ` ← ${fo.callFlow.callee}(${fo.callFlow.calleeClass || ''})` : '';
            flowLines.push(`  L${fo.line}: \`${shape}\`${stats}${callStr}${marker}`);
          }
          parts.push(flowLines.join('\n\n'));
          if (obs.callFlow) {
            parts.push(formatCallFlow(obs.callFlow, obs.type));
          }
        } else {
          parts.push(`**\`${obs.varName}\`** (line ${obs.line}${funcCtx}): \`${typeStr}\``);
          const stats = formatTensorStats(obs.type);
          if (stats) parts.push(stats);
          if (obs.callFlow) {
            parts.push(formatCallFlow(obs.callFlow, obs.type));
          }
        }
      } else if (className === 'Tensor' || className === 'ndarray') {
        parts.push(`**\`${obs.varName}\`** (line ${obs.line}${funcCtx}): \`${typeStr}\``);
        const stats = formatTensorStats(obs.type);
        if (stats) parts.push(stats);
        if (obs.callFlow) {
          parts.push(formatCallFlow(obs.callFlow, obs.type));
        }
      } else {
        parts.push(`**\`${obs.varName}\`** (line ${obs.line}${funcCtx}): \`${typeStr}\``);
        if (obs.callFlow) {
          parts.push(formatCallFlow(obs.callFlow, obs.type));
        }
        if (showSamples && obs.sample !== undefined) {
          const sampleStr = formatSample(obs.sample);
          parts.push(`\n*Sample:*\n\`\`\`json\n${sampleStr}\n\`\`\``);
        }
      }
    }

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`### Trickle Runtime Data\n\n${parts.join('\n\n')}`);
    markdown.isTrusted = true;

    return new vscode.Hover(markdown, wordRange);
  }
}

/** Inline hints (inlay hints) — show type after variable declarations */
class TrickleInlayHintsProvider implements vscode.InlayHintsProvider {
  onDidChangeInlayHints = inlayHintsChangeEmitter.event;

  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.InlayHint[] {
    const config = vscode.workspace.getConfiguration('trickle');
    if (!config.get('enabled', true) || !config.get('inlineHints', true)) return [];

    const hintMode = config.get<string>('inlineHintMode', 'auto');

    // Error mode: show error snapshot values instead of normal observations
    if (hintMode === 'error' && errorSnapshotIndex.size > 0) {
      return this._provideErrorHints(document, range, config);
    }

    const lineMap = getLineMapForDocument(document);
    if (!lineMap) return [];

    const hints: vscode.InlayHint[] = [];

    for (const [lineNo, observations] of lineMap) {
      if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;

      for (const obs of observations) {
        const line = document.lineAt(lineNo - 1);
        const lineText = line.text;
        const isPython = document.languageId === 'python';

        // Handle return value traces — show at end of return line
        if (obs.varName === '<return>' || obs.varName.startsWith('<return:')) {
          if (!/\breturn\b/.test(lineText)) continue;
          const typeStr = typeNodeToString(obs.type, 3);
          // For <return:varname>, show the individual element type
          const label = obs.varName === '<return>'
            ? ` -> ${typeStr}`
            : ` ${obs.varName.slice(8, -1)}: ${typeStr}`;
          const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
          const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Type);
          hint.paddingLeft = true;
          hint.paddingRight = false;
          const tooltipParts: string[] = [];
          if (obs.funcName) tooltipParts.push(`**Function:** \`${obs.funcName}\``);
          const retStats = formatTensorStats(obs.type);
          if (retStats) tooltipParts.push(`**Stats:**${retStats}`);
          if (config.get('showSampleValues', true) && obs.sample !== undefined) {
            tooltipParts.push(`**Sample value:**\n\`\`\`json\n${formatSample(obs.sample)}\n\`\`\``);
          }
          if (tooltipParts.length > 0) {
            hint.tooltip = new vscode.MarkdownString(tooltipParts.join('\n\n'));
          }
          hints.push(hint);
          continue;
        }

        // Find the variable name in the line
        // For attribute names like "self.weight", use non-word-boundary matching
        const isAttrVar = obs.varName.includes('.');
        const varPattern = isAttrVar
          ? new RegExp(escapeRegex(obs.varName))
          : new RegExp(`\\b${escapeRegex(obs.varName)}\\b`);
        const match = varPattern.exec(lineText);
        if (!match) continue;

        // Check this is a declaration/assignment line
        const beforeVar = lineText.substring(0, match.index);
        const varEnd = match.index + obs.varName.length;
        const afterVar = lineText.substring(varEnd).trimStart();

        if (isPython) {
          // Python patterns where we show inlay hints:
          // 1. Assignment: `x = ...`, `a, b = ...`
          // 2. For-loop: `for x in ...`, `for i, (a, b) in ...`
          // 3. With-as: `with ... as x:`
          // 4. Function param: `def fn(x, y=None):` or `def fn(self, x):`
          // 5. Annotated: `x: int = ...` (skip — already has annotation)
          // 6. Attribute assignment: `self.x = ...`
          const isAssignment = afterVar.startsWith('=') && !afterVar.startsWith('==');
          const isAnnotated = afterVar.startsWith(':');
          const isForVar = /\bfor\s+$/.test(beforeVar) || /\bfor\s+.*,\s*$/.test(beforeVar);
          const isWithAs = /\bas\s+$/.test(beforeVar);
          const isBareAssignment = /^\s*$/.test(beforeVar) || /,\s*$/.test(beforeVar);

          // Attribute assignment: `self.weight = ...` or `  self.proj = ...`
          const isAttrAssignment = isAttrVar && isAssignment && /^\s*$/.test(beforeVar);

          // Function parameter: `def fn(x` or `def fn(self, x` or `def fn(x,`
          // Also handles `async def fn(x`
          const isFuncParam = /\b(?:async\s+)?def\s+\w+\s*\(/.test(beforeVar) &&
            (afterVar.startsWith(',') || afterVar.startsWith(')') ||
             afterVar.startsWith('=') || afterVar.startsWith(':'));

          // Tuple unpacking middle elements: `, x, ` or `, x =`
          const isTupleElement = /,\s*$/.test(beforeVar) &&
            (afterVar.startsWith(',') || afterVar.startsWith('=') || afterVar.startsWith(')'));

          const isValidPattern =
            ((isBareAssignment || isForVar || isWithAs) && (isAssignment || isAnnotated)) ||
            isFuncParam ||
            isAttrAssignment ||
            (isTupleElement && !isFuncParam);  // Tuple elements in assignments

          if (!isValidPattern) continue;

          // Skip if already has a type annotation (x: int = ...)
          if (isAnnotated && !isFuncParam) continue;
          // For function params with annotation (x: Tensor), skip
          if (isFuncParam && afterVar.startsWith(':')) continue;
        } else {
          // JS/TS patterns where we show inlay hints:
          // 1. Declaration: `const x = ...`, `let x = ...`, `var x = ...`
          // 2. Export declaration: `export const x = ...`
          // 3. Reassignment: `x = ...`, `x += ...` (bare identifier at statement start)
          // 4. For-loop variable: `for (const x of ...`, `for (let x in ...`
          // 5. Function parameter: `function fn(x,` or `(x) =>`
          // 6. Destructured binding: `const { x } = ...` or `const [x, ...`
          // 7. Catch clause: `catch (err)`
          const isDeclaration = /\b(const|let|var)\s+$/.test(beforeVar) || /\bexport\s+(const|let|var)\s+$/.test(beforeVar);
          const isForLoopVar = /\bfor\s*\(\s*(const|let|var)\s+$/.test(beforeVar);
          const isReassignment = /^\s*$/.test(beforeVar) && (afterVar.startsWith('=') && !afterVar.startsWith('==') && !afterVar.startsWith('=>'));
          const isCompoundAssign = /^\s*$/.test(beforeVar) && /^(\+=|-=|\*=|\/=|%=|\*\*=|&&=|\|\|=|\?\?=|<<=|>>=|>>>=|&=|\|=|\^=)/.test(afterVar);
          const isFuncParam = /\b(?:async\s+)?function\s+\w+\s*\(/.test(beforeVar) &&
            (afterVar.startsWith(',') || afterVar.startsWith(')') || afterVar.startsWith(':') || afterVar.startsWith('='));
          const isArrowParam = /\(\s*$/.test(beforeVar) &&
            (afterVar.startsWith(',') || afterVar.startsWith(')') || afterVar.startsWith(':'));
          const isDestructuredBinding = (/[{[,]\s*$/.test(beforeVar) || /\.\.\.\s*$/.test(beforeVar)) &&
            (afterVar.startsWith(',') || afterVar.startsWith('}') || afterVar.startsWith(']') || afterVar.startsWith(':') || afterVar.startsWith('='));
          const isCatchVar = /\bcatch\s*\(\s*$/.test(beforeVar);

          if (!isDeclaration && !isForLoopVar && !isReassignment && !isCompoundAssign &&
              !isFuncParam && !isArrowParam && !isDestructuredBinding && !isCatchVar) continue;

          // Check if there's already a type annotation (skip for declarations with `: Type`)
          if (isDeclaration && afterVar.startsWith(':') && !afterVar.startsWith(':=')) continue;
          // Skip function params that already have type annotation
          if ((isFuncParam || isArrowParam) && afterVar.startsWith(':')) continue;
        }

        const fullTypeStr = typeNodeToString(obs.type, 3);
        let typeStr = typeNodeToStringCompact(obs.type, undefined, obs.sample);
        const hintMode = config.get<string>('inlineHintMode', 'auto');

        if (hintMode !== 'type') {
          // "auto" or "sample" mode — show sample values inline

          // For primitive types, show actual value inline instead of just "number"/"integer"
          if (obs.type.kind === 'primitive' && obs.sample !== undefined && obs.sample !== null) {
            if (obs.type.name === 'number' && typeof obs.sample === 'number') {
              typeStr = Number.isInteger(obs.sample) ? String(obs.sample) : obs.sample.toFixed(4);
            } else if (obs.type.name === 'integer' && typeof obs.sample === 'number') {
              typeStr = String(obs.sample);
            } else if (obs.type.name === 'boolean' && typeof obs.sample === 'boolean') {
              typeStr = isPython ? (obs.sample ? 'True' : 'False') : String(obs.sample);
            } else if (obs.type.name === 'string' && typeof obs.sample === 'string' && obs.sample.length <= 40) {
              typeStr = `"${obs.sample}"`;
            }
          }

          // For class instances with a config, sample is a constructor-call string like
          // "GPT(n_layer=12, n_head=12, n_embd=768)" — use it as the inline hint directly.
          if (obs.type.kind === 'object' && obs.type.class_name &&
              typeof obs.sample === 'string' &&
              obs.sample.startsWith(obs.type.class_name + '(') &&
              obs.sample.endsWith(')')) {
            typeStr = obs.sample;
          }

          // "sample" mode — aggressively prefer sample data for all types
          if (hintMode === 'sample' && obs.sample !== undefined && obs.sample !== null) {
            const sampleStr = formatSampleInline(obs.sample);
            if (sampleStr) typeStr = sampleStr;
          }
        }

        const position = new vscode.Position(lineNo - 1, varEnd);

        // Check for type drift (type changed since last run)
        const driftKey = `${obs.file}:${obs.line}:${obs.varName}`;
        const hasDrift = changedVarKeys.has(driftKey);

        // Append memory info for tensors
        let memSuffix = '';
        if (obs.gpu_memory_mb !== undefined) {
          const gpuMb = obs.gpu_memory_mb;
          memSuffix = gpuMb >= 1024
            ? ` 🔴 ${(gpuMb / 1024).toFixed(1)}GB GPU`
            : ` 🟡 ${gpuMb.toFixed(0)}MB GPU`;
        } else if (obs.cpu_memory_mb !== undefined) {
          const cpuMb = obs.cpu_memory_mb;
          memSuffix = cpuMb >= 1024
            ? ` ${(cpuMb / 1024).toFixed(1)}GB RAM`
            : ` ${cpuMb.toFixed(0)}MB RAM`;
        }

        const labelBase = hasDrift ? `: ${typeStr} ⚠` : `: ${typeStr}`;
        const label = labelBase + memSuffix;
        const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Type);
        hint.paddingLeft = false;
        hint.paddingRight = true;

        // Add funcName, full type (if compacted), tensor stats, and sample value as tooltip
        const tooltipParts: string[] = [];
        if (hasDrift) tooltipParts.push(`⚠ **Type changed since last run**`);
        if (obs.funcName) tooltipParts.push(`**Function:** \`${obs.funcName}\``);
        // Show full type in tooltip when inline was compacted
        if (fullTypeStr !== typeStr) {
          if (obs.type && isComplexType(obs.type)) {
            const prettyType = typeNodeToPretty(obs.type, 0);
            tooltipParts.push(`**Type:**\n\`\`\`typescript\n${prettyType}\n\`\`\``);
          } else {
            tooltipParts.push(`**Type:** \`${fullTypeStr}\``);
          }
        } else if (obs.type && isComplexType(obs.type)) {
          // Even when not compacted, show pretty-printed hover for complex types
          const prettyType = typeNodeToPretty(obs.type, 0);
          tooltipParts.push(`**Type:**\n\`\`\`typescript\n${prettyType}\n\`\`\``);
        }
        const stats = formatTensorStats(obs.type);
        if (stats) tooltipParts.push(`**Stats:**${stats}`);
        if (obs.gpu_memory_mb !== undefined) {
          const reserved = obs.gpu_reserved_mb !== undefined ? ` (${obs.gpu_reserved_mb.toFixed(0)}MB reserved)` : '';
          tooltipParts.push(`**GPU Memory:** \`${obs.gpu_memory_mb.toFixed(1)}MB allocated${reserved}\``);
        } else if (obs.cpu_memory_mb !== undefined) {
          tooltipParts.push(`**RAM:** \`${obs.cpu_memory_mb.toFixed(1)}MB\``);
        }
        if (obs.callFlow) {
          tooltipParts.push(formatCallFlow(obs.callFlow, obs.type));
        }
        if (config.get('showSampleValues', true) && obs.sample !== undefined) {
          if (obs.previousSamples && obs.previousSamples.length > 0) {
            // Show value history for variables that had multiple values (e.g., loop iterations)
            const allValues = [...obs.previousSamples, obs.sample];
            const formatted = allValues.map(s => formatSample(s)).join(' → ');
            tooltipParts.push(`**Values** (${allValues.length} observed):\n\`\`\`\n${formatted}\n\`\`\``);
          } else {
            tooltipParts.push(`**Sample value:**\n\`\`\`json\n${formatSample(obs.sample)}\n\`\`\``);
          }
        }
        if (tooltipParts.length > 0) {
          hint.tooltip = new vscode.MarkdownString(tooltipParts.join('\n\n'));
        }

        hints.push(hint);
      }
    }

    // Add crash-site inlay hints showing local variable values at the exception line
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const crashLines = crashVarIndex.get(filePath);
      if (crashLines) {
        for (const [lineNo, vars] of crashLines) {
          if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;
          if (vars.length === 0) continue;

          // Build compact label: "✗ x: Tensor[32,784] | batch_size: 32"
          const MAX_VARS = 5;
          const parts = vars.slice(0, MAX_VARS).map(v =>
            v.value !== null && v.value !== undefined
              ? `${v.name}: ${v.type_str} = ${v.value}`
              : `${v.name}: ${v.type_str}`,
          );
          const remaining = vars.length - parts.length;
          const suffix = remaining > 0 ? ` | +${remaining} more` : '';
          const label = ` ✗ ${parts.join(' | ')}${suffix}`;

          try {
            const line = document.lineAt(lineNo - 1);
            const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;

            // Tooltip with full list
            const tooltipLines = vars.map(v =>
              v.value !== null && v.value !== undefined
                ? `**\`${v.name}\`**: \`${v.type_str}\` = \`${v.value}\``
                : `**\`${v.name}\`**: \`${v.type_str}\``,
            );
            const md = new vscode.MarkdownString(
              `### Trickle: Variables at crash\n\n${tooltipLines.join('\n\n')}`,
            );
            md.isTrusted = true;
            hint.tooltip = md;

            hints.push(hint);
          } catch {
            // Skip if line is out of range
          }
        }
      }
    }

    return hints;
  }

  /** Render inline hints from error snapshot data (post-mortem debug view). */
  private _provideErrorHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    config: vscode.WorkspaceConfiguration,
  ): vscode.InlayHint[] {
    const hints: vscode.InlayHint[] = [];

    // Find error snapshot observations for this document
    let snapLineMap: Map<number, VariableObservation[]> | undefined;

    if (document.uri.scheme === 'file') {
      snapLineMap = errorSnapshotIndex.get(document.uri.fsPath);
    } else if (document.uri.scheme === 'vscode-notebook-cell') {
      // For notebooks, use content matching to find the right cell entry.
      // Don't fall back to applying error snapshots to unrelated cells.
      const cellText = document.getText();
      snapLineMap = findBestMatchingCellIn(cellText, errorSnapshotIndex);
    }

    if (!snapLineMap) return hints;

    const isPython = document.languageId === 'python';

    // Render error snapshot hints in the same style as auto mode —
    // positioned after the variable name on its assignment line,
    // with `: type  = value` format showing crash-time values.
    for (const [lineNo, observations] of snapLineMap) {
      if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;

      for (const obs of observations) {
        try {
          const line = document.lineAt(lineNo - 1);
          const lineText = line.text;

          // Find the variable name in the line (same as auto mode)
          const isAttrVar = obs.varName.includes('.');
          const varPattern = isAttrVar
            ? new RegExp(escapeRegex(obs.varName))
            : new RegExp(`\\b${escapeRegex(obs.varName)}\\b`);
          const match = varPattern.exec(lineText);
          if (!match) {
            // Fallback: place at end of line if variable name not found
            const position = new vscode.Position(lineNo - 1, lineText.trimEnd().length);
            const inline = formatSampleInline(obs.sample);
            const valueStr = inline || typeNodeToStringCompact(obs.type, undefined, obs.sample);
            const label = ` ${obs.varName} = ${valueStr}`;
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;
            const tooltipParts: string[] = [];
            tooltipParts.push(`**Error mode** — values at crash time`);
            if (lastErrorMessage) tooltipParts.push(`**Error:** \`${lastErrorMessage}\``);
            tooltipParts.push(`**Type:** \`${typeNodeToString(obs.type, 3)}\``);
            if (obs.sample !== undefined) {
              tooltipParts.push(`**Value:**\n\`\`\`json\n${formatSample(obs.sample)}\n\`\`\``);
            }
            hint.tooltip = new vscode.MarkdownString(tooltipParts.join('\n\n'));
            hints.push(hint);
            continue;
          }

          const varEnd = match.index + obs.varName.length;

          // Format type string like auto mode
          const fullTypeStr = typeNodeToString(obs.type, 3);
          let typeStr = typeNodeToStringCompact(obs.type, undefined, obs.sample);

          // Show sample values inline like auto mode
          if (obs.type.kind === 'primitive' && obs.sample !== undefined && obs.sample !== null) {
            if (obs.type.name === 'number' && typeof obs.sample === 'number') {
              typeStr = Number.isInteger(obs.sample) ? String(obs.sample) : obs.sample.toFixed(4);
            } else if (obs.type.name === 'integer' && typeof obs.sample === 'number') {
              typeStr = String(obs.sample);
            } else if (obs.type.name === 'boolean' && typeof obs.sample === 'boolean') {
              typeStr = isPython ? (obs.sample ? 'True' : 'False') : String(obs.sample);
            } else if (obs.type.name === 'string' && typeof obs.sample === 'string' && obs.sample.length <= 40) {
              typeStr = `"${obs.sample}"`;
            }
          }
          if (obs.type.kind === 'object' && obs.type.class_name &&
              typeof obs.sample === 'string' &&
              obs.sample.startsWith(obs.type.class_name + '(') &&
              obs.sample.endsWith(')')) {
            typeStr = obs.sample;
          }

          const position = new vscode.Position(lineNo - 1, varEnd);
          const label = `: ${typeStr}`;
          const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Type);
          hint.paddingLeft = false;
          hint.paddingRight = true;

          // Tooltip with error context + full type/sample
          const tooltipParts: string[] = [];
          tooltipParts.push(`**Error mode** — values at crash time`);
          if (lastErrorMessage) {
            tooltipParts.push(`**Error:** \`${lastErrorMessage}\``);
          }
          if (fullTypeStr !== typeStr) {
            if (obs.type && isComplexType(obs.type)) {
              const prettyType = typeNodeToPretty(obs.type, 0);
              tooltipParts.push(`**Type:**\n\`\`\`typescript\n${prettyType}\n\`\`\``);
            } else {
              tooltipParts.push(`**Type:** \`${fullTypeStr}\``);
            }
          }
          if (obs.sample !== undefined) {
            tooltipParts.push(`**Value at crash:**\n\`\`\`json\n${formatSample(obs.sample)}\n\`\`\``);
          }
          hint.tooltip = new vscode.MarkdownString(tooltipParts.join('\n\n'));

          hints.push(hint);
        } catch {
          // Skip if line is out of range
        }
      }
    }

    return hints;
  }
}

/** Format a callFlow record as a Markdown string for hover display.
 * Example: "**Flow:** layer (Linear)\n  x: Tensor[32, 784] → Tensor[32, 10]" */
function formatCallFlow(cf: CallFlow, outputType: TypeNode, dimLabels?: string[]): string {
  const calleePart = cf.calleeClass && cf.calleeClass !== cf.callee
    ? `\`${cf.callee}\` (${cf.calleeClass})`
    : `\`${cf.callee}\``;
  const inputParts = cf.inputs.map(inp => {
    const typeStr = extractShapeStr(inp.type);
    return `\`${inp.name}\`: \`${typeStr}\``;
  });
  const outputStr = extractShapeStr(outputType, dimLabels);
  const arrow = inputParts.length > 0
    ? `${inputParts.join(', ')} → \`${outputStr}\``
    : `→ \`${outputStr}\``;
  return `**Flow:** ${calleePart}: ${arrow}`;
}

/** Collect all observations of a variable within the same function, sorted by line. */
function collectShapeFlow(
  lineMap: Map<number, VariableObservation[]>,
  varName: string,
  funcName: string,
): VariableObservation[] {
  const results: VariableObservation[] = [];
  for (const [, obsArr] of lineMap) {
    for (const obs of obsArr) {
      if (obs.varName === varName && obs.funcName === funcName) {
        results.push(obs);
      }
    }
  }
  results.sort((a, b) => a.line - b.line);
  return results;
}

/** Extract a concise shape string from a tensor TypeNode. */
function extractShapeStr(type: TypeNode, dimLabels?: string[]): string {
  if (!type.properties) return type.class_name || 'unknown';
  const shape = type.properties['shape'];
  const dtype = type.properties['dtype'];
  const device = type.properties['device'];
  const gradFn = type.properties['grad_fn'];

  let result = type.class_name || 'Tensor';
  if (shape?.kind === 'primitive' && shape.name) {
    if (dimLabels && dimLabels.length > 0) {
      const match = shape.name.match(/^\[(.+)\]$/);
      if (match) {
        const dims = match[1].split(',').map(s => s.trim());
        const labeled = dims.map((d, i) => i < dimLabels.length ? `${dimLabels[i]}=${d}` : d);
        result += `[${labeled.join(', ')}]`;
      } else {
        result += shape.name;
      }
    } else {
      result += shape.name;
    }
  }
  if (dtype?.kind === 'primitive' && dtype.name) {
    result += ' ' + dtype.name.replace('torch.', '').replace('numpy.', '');
  }
  if (device?.kind === 'primitive' && device.name && device.name !== 'cpu') {
    result += ` @${device.name}`;
  }
  if (gradFn?.kind === 'primitive' && gradFn.name) {
    result += ` (${gradFn.name})`;
  }
  const val = type.properties['value'];
  if (val?.kind === 'primitive' && val.name) {
    result += ` = ${val.name}`;
  }
  const nan = type.properties['nan_count'];
  if (nan?.kind === 'primitive' && nan.name && nan.name !== '0') {
    result += ` NaN!(${nan.name})`;
  }
  const inf = type.properties['inf_count'];
  if (inf?.kind === 'primitive' && inf.name && inf.name !== '0') {
    result += ` [${inf.name} inf]`;
  }
  return result;
}

function registerInlineHints(context: vscode.ExtensionContext, selector: vscode.DocumentSelector) {
  inlineHintsProvider?.dispose();

  const config = vscode.workspace.getConfiguration('trickle');
  if (config.get('inlineHints', true)) {
    inlineHintsProvider = vscode.languages.registerInlayHintsProvider(selector, new TrickleInlayHintsProvider());
    context.subscriptions.push(inlineHintsProvider);
  }
}

function refreshInlineHints() {
  // Fire the event emitter so VSCode re-queries all inlay hints providers
  inlayHintsChangeEmitter.fire();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert a TypeNode to a readable type string.
 * Handles both JS/TS types and Python types (tensors, ndarrays, etc.)
 */
function typeNodeToString(node: TypeNode, depth: number = 3, dimLabels?: string[]): string {
  if (depth <= 0) return 'unknown';

  switch (node.kind) {
    case 'primitive':
      return node.name || 'unknown';

    case 'array':
      if (node.element) {
        const inner = typeNodeToString(node.element, depth - 1);
        return inner.includes('|') || inner.includes('{') ? `Array<${inner}>` : `${inner}[]`;
      }
      return 'unknown[]';

    case 'tuple':
      if (node.elements) {
        const tuplePrefix = node.class_name === 'list' ? 'list' : '';
        return `${tuplePrefix}[${node.elements.map(e => typeNodeToString(e, depth - 1)).join(', ')}]`;
      }
      return '[]';

    case 'object': {
      if (!node.properties) return node.class_name || 'object';
      const entries = Object.entries(node.properties);
      if (entries.length === 0) return node.class_name || '{}';

      // Special cases for JS
      if ('__date' in node.properties) return 'Date';
      if ('__regexp' in node.properties) return 'RegExp';
      if ('__error' in node.properties) return 'Error';

      // Plain Python dict: show {key: type, ...} (values shown via compact renderer using sample)
      if (node.class_name === 'dict') {
        if (entries.length <= 8) {
          const props = entries.map(([k, v]) => `${k}: ${typeNodeToString(v, depth - 1)}`);
          return `{${props.join(', ')}}`;
        }
        const first6 = entries.slice(0, 6).map(([k, v]) => `${k}: ${typeNodeToString(v, depth - 1)}`);
        return `{${first6.join(', ')}, ...}`;
      }

      // Special case for PyTorch Tensor / NumPy ndarray:
      // These have shape, dtype (and optionally device) as properties
      // where the values are stored as primitive name strings like "[1, 16, 32]"
      if (node.class_name === 'Tensor' || node.class_name === 'ndarray') {
        return formatTensorType(node.class_name, node.properties, dimLabels);
      }

      // Pandas DataFrame: show rows x cols with memory
      if (node.class_name === 'DataFrame') {
        const rows = node.properties['rows']?.name;
        const cols = node.properties['cols']?.name;
        const mem = node.properties['memory']?.name;
        const nulls = node.properties['nulls']?.name;
        const parts: string[] = [];
        if (rows && cols) parts.push(`${rows} rows x ${cols} cols`);
        if (mem) parts.push(mem);
        if (nulls) parts.push(`${nulls} nulls`);
        return `DataFrame(${parts.join(', ')})`;
      }

      // Pandas Series: show length and dtype
      if (node.class_name === 'Series') {
        const len = node.properties['length']?.name;
        const dtype = node.properties['dtype']?.name;
        const name = node.properties['name']?.name;
        const nulls = node.properties['nulls']?.name;
        const parts: string[] = [];
        if (len) parts.push(len);
        if (dtype) parts.push(dtype);
        if (name) parts.push(`"${name}"`);
        if (nulls) parts.push(`${nulls} nulls`);
        return `Series(${parts.join(', ')})`;
      }

      // Pandas GroupBy: show ngroups and keys
      if (node.class_name === 'DataFrameGroupBy' || node.class_name === 'SeriesGroupBy') {
        const ngroups = node.properties['ngroups']?.name;
        const by = node.properties['by']?.name;
        const groupSize = node.properties['group_size']?.name;
        const parts: string[] = [];
        if (by) parts.push(`by=${by}`);
        if (ngroups) parts.push(`${ngroups} groups`);
        if (groupSize) parts.push(`size=${groupSize}`);
        return `${node.class_name}(${parts.join(', ')})`;
      }

      // Pandas Index types
      if (node.class_name === 'RangeIndex') {
        const len = node.properties['length']?.name;
        const range = node.properties['range']?.name;
        return range ? `RangeIndex(${range}, len=${len})` : `RangeIndex(${len})`;
      }
      if (node.class_name === 'MultiIndex') {
        const len = node.properties['length']?.name;
        const names = node.properties['names']?.name;
        const levels = node.properties['levels']?.name;
        const parts: string[] = [];
        if (len) parts.push(len);
        if (names) parts.push(names);
        if (levels) parts.push(`${levels} levels`);
        return `MultiIndex(${parts.join(', ')})`;
      }
      if (node.class_name === 'DatetimeIndex') {
        const len = node.properties['length']?.name;
        const start = node.properties['start']?.name;
        const end = node.properties['end']?.name;
        const freq = node.properties['freq']?.name;
        const parts: string[] = [];
        if (len) parts.push(len);
        if (start && end) parts.push(`${start}..${end}`);
        if (freq) parts.push(freq);
        return `DatetimeIndex(${parts.join(', ')})`;
      }

      // HuggingFace Dataset: show rows and columns
      if (node.class_name === 'Dataset' && node.properties['rows']) {
        const rows = node.properties['rows']?.name;
        const cols = node.properties['columns']?.name;
        const split = node.properties['split']?.name;
        const fmt = node.properties['format']?.name;
        const parts: string[] = [];
        if (rows) parts.push(`${rows} rows`);
        if (cols) parts.push(cols);
        const badges: string[] = [];
        if (split) badges.push(split);
        if (fmt) badges.push(fmt);
        const badgeStr = badges.length > 0 ? ` [${badges.join(', ')}]` : '';
        return `Dataset(${parts.join(', ')})${badgeStr}`;
      }

      // HuggingFace DatasetDict: show splits with row counts
      if (node.class_name === 'DatasetDict' && node.properties['splits']) {
        const splits = node.properties['splits']?.name;
        return `DatasetDict(${splits || ''})`;
      }

      // Sklearn estimators: show key info compactly
      if (node.properties && (node.properties['fitted'] || node.properties['steps'])) {
        const fitted = node.properties['fitted']?.name === 'True';
        const steps = node.properties['steps']?.name;
        const features = node.properties['features']?.name;
        const classes = node.properties['classes']?.name;
        const skipKeys = new Set(['fitted', 'features', 'classes', 'n_estimators_actual', 'steps']);
        const paramEntries = entries.filter(([k]) => !skipKeys.has(k));
        const parts: string[] = [];
        if (steps) {
          parts.push(steps);
        } else {
          parts.push(...paramEntries.slice(0, 4).map(([k, v]) => `${k}=${v.name ?? typeNodeToString(v, depth - 1)}`));
        }
        const badges: string[] = [];
        if (fitted) {
          if (features) badges.push(`${features} features`);
          if (classes) badges.push(`${classes} classes`);
        }
        const badgeStr = badges.length > 0 ? ` [${badges.join(', ')}]` : fitted ? ' [fitted]' : '';
        return `${node.class_name}(${parts.join(', ')})${badgeStr}`;
      }

      // nn.Module types: show key params, omit 'params'/'training'/'memory' from inline props
      if (node.class_name && node.properties['params']) {
        const paramCount = node.properties['params']?.name;
        const trainingMode = node.properties['training']?.name;
        const memorySize = node.properties['memory']?.name;
        const gradNorm = node.properties['grad_norm']?.name;
        const gradNan = node.properties['grad_nan']?.name;
        const gradInf = node.properties['grad_inf']?.name;
        const modeBadge = trainingMode === 'False' ? ' [eval]' : '';
        const memBadge = memorySize ? ` ${memorySize}` : '';
        // Gradient badges
        let gradBadge = '';
        if (gradNan) {
          gradBadge = ` ⚠ grad NaN!(${gradNan})`;
        } else if (gradInf) {
          gradBadge = ` ⚠ grad Inf!(${gradInf})`;
        } else if (gradNorm) {
          gradBadge = ` |∇|=${gradNorm}`;
        }
        const skipKeys = new Set(['params', 'training', 'param_groups', 'memory', 'grad_norm', 'grad_nan', 'grad_inf', 'grad_top']);
        const displayEntries = entries.filter(([k]) => !skipKeys.has(k));
        if (displayEntries.length === 0) {
          return paramCount ? `${node.class_name}(${paramCount} params${memBadge})${modeBadge}${gradBadge}` : `${node.class_name}${modeBadge}${gradBadge}`;
        }
        const props = displayEntries.slice(0, 4).map(([k, v]) => `${k}=${typeNodeToString(v, depth - 1)}`);
        const suffix = displayEntries.length > 4 ? ', ...' : '';
        return `${node.class_name}(${props.join(', ')}${suffix})${modeBadge}${gradBadge}`;
      }

      // Named class
      if (node.class_name) {
        if (entries.length <= 4) {
          const props = entries.map(([k, v]) => `${k}=${typeNodeToString(v, depth - 1)}`);
          return `${node.class_name}(${props.join(', ')})`;
        }
        const first3 = entries.slice(0, 3).map(([k, v]) => `${k}=${typeNodeToString(v, depth - 1)}`);
        return `${node.class_name}(${first3.join(', ')}, ...)`;
      }

      if (entries.length <= 5) {
        const props = entries.map(([k, v]) => `${k}: ${typeNodeToString(v, depth - 1)}`);
        return `{ ${props.join('; ')} }`;
      }

      const first4 = entries.slice(0, 4).map(([k, v]) => `${k}: ${typeNodeToString(v, depth - 1)}`);
      return `{ ${first4.join('; ')}; ... }`;
    }

    case 'map': {
      const keyType = node.key ? typeNodeToString(node.key, depth - 1) : 'string';
      const valType = node.value ? typeNodeToString(node.value, depth - 1) : 'Any';
      return `dict[${keyType}, ${valType}]`;
    }

    case 'function':
      if (node.name && node.name !== 'anonymous') {
        return `${node.name}(...)`;
      }
      return '(...args: any[]) => any';

    case 'promise':
      if (node.resolved) {
        return `Promise<${typeNodeToString(node.resolved, depth - 1)}>`;
      }
      return 'Promise<unknown>';

    case 'union': {
      const unionMembers = node.elements || node.members;
      if (unionMembers) {
        return unionMembers.map(e => typeNodeToString(e, depth - 1)).join(' | ');
      }
      return 'unknown';
    }

    default:
      return 'unknown';
  }
}

/**
 * Compact type string for inline display.
 * For objects with many keys, shows just key names: {key1, key2, +N more}
 * This keeps inline hints short. Full type is shown in hover tooltip.
 */
/** Format a scalar sample value as a short string for inline display. Returns null if not suitable. */
function formatScalarSample(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean') return val ? 'True' : 'False';
  if (typeof val === 'number') {
    if (!isFinite(val)) return null;
    return Number.isInteger(val) ? String(val) : val.toFixed(4).replace(/\.?0+$/, '');
  }
  if (typeof val === 'string') {
    // Class reference like "ModelConfig(...)" — show without quotes
    if (/^\w+\(\.\.\.\)$/.test(val)) return val;
    if (val.length <= 20) return `"${val}"`;
  }
  return null;
}

function typeNodeToStringCompact(node: TypeNode, dimLabels?: string[], sample?: unknown): string {
  // Arrays: recursively compact the element type
  if (node.kind === 'array' && node.element) {
    const inner = typeNodeToStringCompact(node.element, dimLabels);
    // Wrap in Array<...> if inner contains special chars, else use T[]
    const needsWrapper = inner.includes('|') || inner.includes('(') ||
      (inner.includes('<') && !inner.endsWith('>'));
    return needsWrapper ? `Array<${inner}>` : `${inner}[]`;
  }

  // Unions: collapse homogeneous unions (e.g. 20 Tensor variants → just "Tensor")
  if (node.kind === 'union') {
    const members = node.elements || node.members;
    if (!members || members.length === 0) return 'unknown';
    // If all members share the same class_name, use that class name
    const classNames = new Set(members.map(m => m.class_name).filter(Boolean));
    if (classNames.size === 1) {
      return classNames.values().next().value!;
    }
    // Otherwise fall through to typeNodeToString
    return typeNodeToString(node, 3, dimLabels);
  }

  if (node.kind === 'map') {
    return typeNodeToString(node, 3, dimLabels);
  }

  if (node.kind !== 'object' || !node.properties) {
    return typeNodeToString(node, 3, dimLabels);
  }

  const entries = Object.entries(node.properties);
  if (entries.length === 0) return node.class_name || '{}';

  // Special values — use full rendering
  if ('__date' in node.properties) return 'Date';
  if ('__regexp' in node.properties) return 'RegExp';
  if ('__error' in node.properties) return 'Error';

  // ML/data types — keep their special compact rendering
  const mlClasses = new Set(['Tensor', 'ndarray', 'DataFrame', 'Series',
    'DataFrameGroupBy', 'SeriesGroupBy', 'RangeIndex', 'MultiIndex',
    'DatetimeIndex', 'Dataset', 'DatasetDict']);
  if (node.class_name && mlClasses.has(node.class_name)) {
    return typeNodeToString(node, 3, dimLabels);
  }

  // Named classes (dataclasses, NamedTuples, Pydantic models): show key=value when sample available
  const sampleObj = (sample !== null && sample !== undefined && typeof sample === 'object' && !Array.isArray(sample))
    ? sample as Record<string, unknown>
    : null;

  // Plain dict: show {key: value, ...} using sample values when available
  if (node.class_name === 'dict') {
    const MAX_SHOW = 5;
    const shown: string[] = [];
    let idx = 0;
    for (const [key] of entries) {
      if (idx >= MAX_SHOW) break;
      if (sampleObj) {
        const val = sampleObj[key];
        const formatted = formatScalarSample(val);
        shown.push(formatted !== null ? `${key}: ${formatted}` : key);
      } else {
        shown.push(key);
      }
      idx++;
    }
    const remaining = entries.length - shown.length;
    const suffix = remaining > 0 ? `, +${remaining}` : '';
    return `{${shown.join(', ')}${suffix}}`;
  }

  if (node.class_name && sampleObj) {
    const MAX_SHOW = 4;
    const shown: string[] = [];
    let idx = 0;
    for (const [key] of entries) {
      if (idx >= MAX_SHOW) break;
      const val = sampleObj[key];
      const formatted = formatScalarSample(val);
      shown.push(formatted !== null ? `${key}=${formatted}` : key);
      idx++;
    }
    const remaining = entries.length - shown.length;
    const suffix = remaining > 0 ? `, +${remaining}` : '';
    return `${node.class_name}(${shown.join(', ')}${suffix})`;
  }

  // Small objects (≤ 3 keys): show normally with types
  if (entries.length <= 3) {
    return typeNodeToString(node, 3, dimLabels);
  }

  // Large objects: show key names only, with count of remaining
  const MAX_SHOW = 3;
  const shown = entries.slice(0, MAX_SHOW).map(([k]) => k);
  const remaining = entries.length - MAX_SHOW;
  const suffix = remaining > 0 ? `, +${remaining}` : '';

  if (node.class_name) {
    return `${node.class_name}(${shown.join(', ')}${suffix})`;
  }
  return `{${shown.join(', ')}${suffix}}`;
}

/** Format a tensor type as a concise readable string.
 * E.g. Tensor[B=1, T=16, C=32] float32 @cpu
 * When dimLabels are provided, annotates each dimension with its name.
 */
function formatTensorType(className: string, properties: Record<string, TypeNode>, dimLabels?: string[]): string {
  const parts: string[] = [className];

  // Shape: stored as primitive with name like "[1, 16, 32]"
  const shapeProp = properties['shape'];
  if (shapeProp?.kind === 'primitive' && shapeProp.name) {
    if (dimLabels && dimLabels.length > 0) {
      // Parse the shape string "[1, 16, 32]" and annotate with dim names
      const shapeStr = shapeProp.name;
      const match = shapeStr.match(/^\[(.+)\]$/);
      if (match) {
        const dims = match[1].split(',').map(s => s.trim());
        const labeled = dims.map((d, i) => i < dimLabels.length ? `${dimLabels[i]}=${d}` : d);
        parts[0] = `${className}[${labeled.join(', ')}]`;
      } else {
        parts[0] = `${className}${shapeStr}`;
      }
    } else {
      parts[0] = `${className}${shapeProp.name}`;
    }
  }

  // Dtype: stored as primitive with name like "torch.float32"
  const dtypeProp = properties['dtype'];
  if (dtypeProp?.kind === 'primitive' && dtypeProp.name) {
    // Shorten common dtypes
    let dtype = dtypeProp.name;
    dtype = dtype.replace('torch.', '').replace('numpy.', '');
    parts.push(dtype);
  }

  // Device: stored as primitive with name like "cpu" or "cuda:0"
  const deviceProp = properties['device'];
  if (deviceProp?.kind === 'primitive' && deviceProp.name && deviceProp.name !== 'cpu') {
    parts.push(`@${deviceProp.name}`);
  }

  // Memory: show inline for tensors (e.g. "98.0 KB")
  const memProp = properties['memory'];
  if (memProp?.kind === 'primitive' && memProp.name) {
    parts.push(memProp.name);
  }

  // requires_grad: show when True
  const gradProp = properties['requires_grad'];
  if (gradProp?.kind === 'primitive' && gradProp.name === 'True') {
    parts.push('grad');
  }

  // grad_fn: show the backward function name
  const gradFnProp = properties['grad_fn'];
  if (gradFnProp?.kind === 'primitive' && gradFnProp.name) {
    parts.push(`(${gradFnProp.name})`);
  }

  // Scalar value: show actual number for 0-dim / 1-element tensors
  // If aggregation data exists (from loop tracking), show trend instead
  const aggFirst = properties['agg_first'];
  const aggLast = properties['agg_last'];
  const aggSteps = properties['agg_steps'];
  if (aggFirst?.kind === 'primitive' && aggFirst.name && aggLast?.kind === 'primitive' && aggLast.name && aggSteps?.kind === 'primitive' && aggSteps.name) {
    const first = parseFloat(aggFirst.name);
    const last = parseFloat(aggLast.name);
    const trend = last < first ? '↓' : last > first ? '↑' : '→';
    parts.push(`${aggFirst.name} ${trend} ${aggLast.name} (${aggSteps.name} steps)`);
  } else {
    const valueProp = properties['value'];
    if (valueProp?.kind === 'primitive' && valueProp.name) {
      parts.push(`= ${valueProp.name}`);
    }
  }

  // no_grad context: show when tensor was computed without gradient tracking
  const gradEnabledProp = properties['grad_enabled'];
  if (gradEnabledProp?.kind === 'primitive' && gradEnabledProp.name === 'False') {
    parts.push('[no_grad]');
  }

  // NaN/Inf warnings — show prominently at the end
  const nanProp = properties['nan_count'];
  const infProp = properties['inf_count'];
  // NaN is always a bug — show prominently
  if (nanProp?.kind === 'primitive' && nanProp.name && nanProp.name !== '0') {
    parts.push(`NaN!(${nanProp.name})`);
  }
  // Inf can be intentional (attention masking uses -inf) — show less alarming
  if (infProp?.kind === 'primitive' && infProp.name && infProp.name !== '0') {
    parts.push(`[${infProp.name} inf]`);
  }

  return parts.join(' ');
}

/** Format tensor statistics (min/max/mean) for hover display. */
function formatTensorStats(type: TypeNode): string {
  if (!type.properties) return '';
  const parts: string[] = [];
  const min = type.properties['min'];
  const max = type.properties['max'];
  const mean = type.properties['mean'];
  if (min && max && mean) {
    const std = type.properties['std'];
    let statsStr = `min=${min.name} max=${max.name} mean=${mean.name}`;
    if (std?.kind === 'primitive' && std.name) {
      statsStr += ` std=${std.name}`;
    }
    parts.push(statsStr);
  }
  const mem = type.properties['memory'];
  if (mem?.kind === 'primitive' && mem.name) {
    parts.push(`mem=${mem.name}`);
  }
  // Scalar aggregation stats from loop tracking
  const aggMin = type.properties['agg_min'];
  const aggMax = type.properties['agg_max'];
  const aggFirst = type.properties['agg_first'];
  const aggLast = type.properties['agg_last'];
  const aggSteps = type.properties['agg_steps'];
  if (aggFirst?.kind === 'primitive' && aggLast?.kind === 'primitive') {
    parts.push(`loop: ${aggFirst.name}→${aggLast.name} min=${aggMin?.name} max=${aggMax?.name} (${aggSteps?.name} steps)`);
  }
  // Gradient info for nn.Module (after backward)
  const gradNorm = type.properties['grad_norm'];
  const gradTop = type.properties['grad_top'];
  const gradNan = type.properties['grad_nan'];
  const gradInf = type.properties['grad_inf'];
  if (gradNorm?.kind === 'primitive' && gradNorm.name) {
    let gradStr = `grad_norm=${gradNorm.name}`;
    if (gradNan?.kind === 'primitive') gradStr += ` NaN_grads=${gradNan.name}`;
    if (gradInf?.kind === 'primitive') gradStr += ` Inf_grads=${gradInf.name}`;
    if (gradTop?.kind === 'primitive' && gradTop.name) gradStr += ` top: ${gradTop.name}`;
    parts.push(gradStr);
  }
  if (parts.length === 0) return '';
  return ` \`${parts.join(' | ')}\``;
}

/**
 * Render a TypeNode as a pretty-printed, indented type string suitable for
 * hover tooltips. Uses TypeScript-like syntax with newlines for readability.
 * Falls back to the compact single-line form for simple types.
 */
function typeNodeToPretty(node: TypeNode, indent: number = 0, dimLabels?: string[]): string {
  const pad = '  '.repeat(indent);
  const innerPad = '  '.repeat(indent + 1);

  switch (node.kind) {
    case 'primitive':
      return node.name || 'unknown';

    case 'array': {
      if (!node.element) return 'unknown[]';
      const inner = node.element;
      // If element is a complex object, expand it on multiple lines
      if (inner.kind === 'object' && inner.properties && Object.keys(inner.properties).length > 2) {
        const innerStr = typeNodeToPretty(inner, indent, dimLabels);
        return innerStr.includes('\n') ? `Array<\n${innerPad}${innerStr}\n${pad}>` : `${innerStr}[]`;
      }
      const innerStr = typeNodeToString(inner, 3, dimLabels);
      return innerStr.includes('{') ? `Array<${innerStr}>` : `${innerStr}[]`;
    }

    case 'tuple':
      if (node.elements) {
        const prettyPrefix = node.class_name === 'list' ? 'list' : '';
        return `${prettyPrefix}[${node.elements.map(e => typeNodeToString(e, 3, dimLabels)).join(', ')}]`;
      }
      return '[]';

    case 'object': {
      if (!node.properties) return node.class_name || 'object';
      const entries = Object.entries(node.properties);
      if (entries.length === 0) return node.class_name ? `${node.class_name} {}` : '{}';

      // Special types handled by typeNodeToString
      if ('__date' in node.properties) return 'Date';
      if ('__regexp' in node.properties) return 'RegExp';
      if ('__error' in node.properties) return 'Error';
      if (node.class_name === 'Tensor' || node.class_name === 'ndarray' ||
          node.class_name === 'DataFrame' || node.class_name === 'Series') {
        return typeNodeToString(node, 3, dimLabels);
      }

      const header = node.class_name ? `${node.class_name} ` : '';
      const fieldLines = entries.map(([k, v]) => {
        const valStr = typeNodeToPretty(v, indent + 1, dimLabels);
        return `${innerPad}${k}: ${valStr}`;
      });
      return `${header}{\n${fieldLines.join('\n')}\n${pad}}`;
    }

    case 'union': {
      const prettyUnionMembers = node.elements || node.members;
      if (prettyUnionMembers) {
        return prettyUnionMembers.map(e => typeNodeToString(e, 3, dimLabels)).join(' | ');
      }
      return 'unknown';
    }

    case 'map': {
      const keyType = node.key ? typeNodeToString(node.key, 3, dimLabels) : 'string';
      const valNode = node.value;
      if (valNode && valNode.kind === 'object' && valNode.properties && Object.keys(valNode.properties).length > 2) {
        const valStr = typeNodeToPretty(valNode, indent + 1, dimLabels);
        return `dict[${keyType}, ${valStr}]`;
      }
      const valType = valNode ? typeNodeToString(valNode, 3, dimLabels) : 'Any';
      return `dict[${keyType}, ${valType}]`;
    }

    case 'promise':
      return node.resolved ? `Promise<${typeNodeToString(node.resolved, 3, dimLabels)}>` : 'Promise<unknown>';

    default:
      return typeNodeToString(node, 3, dimLabels);
  }
}

/**
 * Decide if a TypeNode is complex enough to warrant a pretty-printed hover card.
 * Returns true for objects with nested objects or many fields.
 */
function isComplexType(node: TypeNode): boolean {
  if (node.kind === 'array' && node.element) return isComplexType(node.element);
  if (node.kind === 'union') {
    const members = node.elements || node.members;
    return !!members && members.length > 1;
  }
  if (node.kind !== 'object' || !node.properties) return false;
  const entries = Object.entries(node.properties);
  if (entries.length > 4) return true;
  return entries.some(([, v]) => v.kind === 'object' && v.properties && Object.keys(v.properties).length > 0);
}

/** Format a sample value for display */
/** Format a sample value for inline hint display (compact, single-line). */
function formatSampleInline(sample: unknown): string | null {
  if (sample === undefined || sample === null) return null;
  if (typeof sample === 'number') {
    return Number.isInteger(sample) ? String(sample) : sample.toFixed(4);
  }
  if (typeof sample === 'boolean') return String(sample);
  if (typeof sample === 'string') {
    return sample.length <= 60 ? `"${sample}"` : `"${sample.substring(0, 57)}..."`;
  }
  try {
    const str = JSON.stringify(sample);
    if (str.length <= 80) return str;
    return str.substring(0, 77) + '...';
  } catch {
    const s = String(sample);
    return s.length <= 80 ? s : s.substring(0, 77) + '...';
  }
}

function formatSample(sample: unknown): string {
  if (sample === undefined) return 'undefined';
  if (sample === null) return 'null';

  const config = vscode.workspace.getConfiguration('trickle');
  const maxLen = config.get<number>('sampleLength', 200);
  // Use 10x for hover tooltips (JSON formatted), maxLen for inline
  const hoverMax = maxLen * 10;

  try {
    const str = JSON.stringify(sample, null, 2);
    if (str.length > hoverMax) {
      return str.substring(0, hoverMax) + '\n// ... truncated';
    }
    return str;
  } catch {
    return String(sample);
  }
}

// ─── Runtime-type-aware Autocomplete ──────────────────────────────────────────

/** Common methods/properties for known Python types, used for autocomplete. */
const KNOWN_TYPE_MEMBERS: Record<string, { props: string[]; methods: string[] }> = {
  Tensor: {
    props: [
      'shape', 'dtype', 'device', 'data', 'grad', 'requires_grad', 'is_cuda',
      'is_contiguous', 'ndim', 'T', 'mT', 'real', 'imag', 'is_leaf',
      'grad_fn', 'is_sparse', 'is_quantized', 'is_meta', 'is_nested',
      'nbytes', 'itemsize', 'is_complex', 'is_floating_point',
    ],
    methods: [
      'abs', 'add', 'argmax', 'argmin', 'backward', 'bool', 'chunk', 'clamp',
      'clone', 'contiguous', 'cpu', 'cuda', 'detach', 'dim', 'div', 'double',
      'eq', 'expand', 'expand_as', 'flatten', 'flip', 'float', 'floor', 'gather',
      'half', 'index_select', 'int', 'item', 'log', 'long', 'masked_fill',
      'matmul', 'max', 'mean', 'min', 'mm', 'mul', 'narrow', 'ne', 'neg',
      'nonzero', 'norm', 'numel', 'numpy', 'permute', 'pow', 'prod',
      'repeat', 'reshape', 'requires_grad_', 'retain_grad', 'scatter',
      'sigmoid', 'sign', 'size', 'softmax', 'sort', 'split', 'sqrt',
      'squeeze', 'std', 'sub', 'sum', 'to', 'tolist', 'topk', 'transpose',
      'type', 'unbind', 'unflatten', 'unfold', 'uniform_', 'unique',
      'unsqueeze', 'var', 'view', 'view_as', 'zero_',
    ],
  },
  ndarray: {
    props: [
      'shape', 'dtype', 'ndim', 'size', 'T', 'flat', 'real', 'imag',
      'data', 'strides', 'itemsize', 'nbytes', 'base',
    ],
    methods: [
      'all', 'any', 'argmax', 'argmin', 'argsort', 'astype', 'clip', 'copy',
      'cumsum', 'diagonal', 'dot', 'fill', 'flatten', 'item', 'max', 'mean',
      'min', 'nonzero', 'prod', 'ravel', 'repeat', 'reshape', 'round',
      'sort', 'squeeze', 'std', 'sum', 'swapaxes', 'take', 'tolist',
      'transpose', 'var', 'view',
    ],
  },
  DataFrame: {
    props: [
      'columns', 'index', 'dtypes', 'shape', 'values', 'T', 'axes', 'ndim',
      'size', 'empty', 'loc', 'iloc', 'at', 'iat',
    ],
    methods: [
      'apply', 'astype', 'copy', 'corr', 'count', 'describe', 'drop',
      'dropna', 'fillna', 'filter', 'groupby', 'head', 'info', 'isna',
      'isnull', 'iterrows', 'join', 'max', 'mean', 'melt', 'merge', 'min',
      'nunique', 'pivot', 'plot', 'query', 'rename', 'replace', 'reset_index',
      'rolling', 'sample', 'set_index', 'sort_values', 'std', 'sum', 'tail',
      'to_csv', 'to_dict', 'to_json', 'to_numpy', 'value_counts', 'var',
    ],
  },
  Series: {
    props: [
      'dtype', 'index', 'name', 'shape', 'values', 'ndim', 'size', 'empty',
      'loc', 'iloc', 'at', 'iat', 'str', 'dt', 'cat',
    ],
    methods: [
      'apply', 'astype', 'copy', 'count', 'cumsum', 'describe', 'drop',
      'dropna', 'fillna', 'groupby', 'head', 'idxmax', 'idxmin', 'isna',
      'isnull', 'map', 'max', 'mean', 'min', 'nunique', 'plot', 'replace',
      'reset_index', 'rolling', 'sample', 'sort_values', 'std', 'sum',
      'tail', 'to_dict', 'to_frame', 'to_list', 'to_numpy', 'unique',
      'value_counts', 'var',
    ],
  },
};

/**
 * Find the enclosing function name for a given line in a Python document.
 * Returns undefined if the line is at module/cell top level.
 */
function findEnclosingFunction(document: vscode.TextDocument, lineIdx: number): string | undefined {
  for (let i = lineIdx; i >= 0; i--) {
    const text = document.lineAt(i).text;
    const m = text.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/);
    if (m) {
      // Check indentation: if the target line is indented more than the def, it's inside
      const defIndent = text.search(/\S/);
      if (i === lineIdx) return m[1]; // cursor is on the def line itself
      const targetIndent = document.lineAt(lineIdx).text.search(/\S/);
      if (targetIndent > defIndent) return m[1];
      // If same or less indent, this def doesn't contain our line
    }
  }
  return undefined;
}

/**
 * Find the observation for a variable name, scoped to the enclosing function.
 * Falls back to module-level observations if no function-scoped match.
 */
function findScopedObservation(
  lineMap: Map<number, VariableObservation[]>,
  varName: string,
  funcName: string | undefined,
): VariableObservation | undefined {
  let funcMatch: VariableObservation | undefined;
  let moduleMatch: VariableObservation | undefined;
  for (const [, observations] of lineMap) {
    for (const o of observations) {
      if (o.varName !== varName) continue;
      if (funcName && o.funcName === funcName) {
        funcMatch = o;
      } else if (!o.funcName) {
        moduleMatch = o;
      }
    }
  }
  return funcMatch || (funcName ? undefined : moduleMatch);
}

class TrickleCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] | undefined {
    const lineText = document.lineAt(position.line).text;
    const textBefore = lineText.substring(0, position.character);

    // Match `varName.` at the end
    const dotMatch = textBefore.match(/\b(\w+)\.\s*$/);
    if (!dotMatch) return undefined;
    const varName = dotMatch[1];

    const lineMap = getLineMapForDocument(document);
    if (!lineMap) return undefined;

    // Scope to the enclosing function
    const funcName = findEnclosingFunction(document, position.line);
    const obs = findScopedObservation(lineMap, varName, funcName);
    if (!obs) return undefined;

    const typeNode = obs.type;
    const items: vscode.CompletionItem[] = [];

    const className = resolveClassName(typeNode);
    if (className && KNOWN_TYPE_MEMBERS[className]) {
      const known = KNOWN_TYPE_MEMBERS[className];
      for (const prop of known.props) {
        const item = new vscode.CompletionItem(prop, vscode.CompletionItemKind.Property);
        item.detail = `(trickle) ${className}.${prop}`;
        item.sortText = `0_${prop}`;
        items.push(item);
      }
      for (const method of known.methods) {
        const item = new vscode.CompletionItem(method, vscode.CompletionItemKind.Method);
        item.detail = `(trickle) ${className}.${method}()`;
        item.sortText = `1_${method}`;
        items.push(item);
      }
    }

    if (typeNode.kind === 'object' && typeNode.properties) {
      for (const [key, valType] of Object.entries(typeNode.properties)) {
        if (key.startsWith('__')) continue;
        if (className && KNOWN_TYPE_MEMBERS[className]) {
          const known = KNOWN_TYPE_MEMBERS[className];
          if (known.props.includes(key) || known.methods.includes(key)) continue;
        }
        const typeStr = typeNodeToStringCompact(valType);
        const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Field);
        item.detail = `(trickle) ${typeStr}`;
        item.sortText = `2_${key}`;
        items.push(item);
      }
    }

    return items.length > 0 ? items : undefined;
  }
}

/** Resolve the class name from a TypeNode, handling arrays and unions. */
function resolveClassName(node: TypeNode): string | undefined {
  if (node.class_name) return node.class_name;
  if (node.kind === 'union') {
    const members = node.elements || node.members;
    if (members && members.length > 0) {
      // If all members share the same class, use that
      const names = new Set(members.map(m => m.class_name).filter(Boolean));
      if (names.size === 1) return names.values().next().value;
    }
  }
  return undefined;
}

// ─── Semantic Token Provider ──────────────────────────────────────────────────

// Token type indices matching the legend registered in activate()
const TOKEN_TYPE_PROPERTY = 0;
const TOKEN_TYPE_METHOD = 1;

class TrickleSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  provideDocumentSemanticTokens(
    document: vscode.TextDocument,
  ): vscode.SemanticTokens | undefined {
    const lineMap = getLineMapForDocument(document);
    if (!lineMap) return undefined;

    // Build scope-aware map: "funcName:varName" → className
    const scopedVarTypes: Map<string, string> = new Map();
    for (const [, observations] of lineMap) {
      for (const obs of observations) {
        const cls = resolveClassName(obs.type);
        if (cls) {
          const scopeKey = `${obs.funcName || ''}:${obs.varName}`;
          scopedVarTypes.set(scopeKey, cls);
        }
      }
    }
    if (scopedVarTypes.size === 0) return undefined;

    const builder = new vscode.SemanticTokensBuilder(
      new vscode.SemanticTokensLegend(
        ['property', 'method', 'variable'],
        ['declaration', 'readonly'],
      ),
    );

    // Build a set of all variable names that have ANY observation
    const allVarNames = new Set<string>();
    for (const key of scopedVarTypes.keys()) {
      allVarNames.add(key.split(':')[1]);
    }
    if (allVarNames.size === 0) return undefined;

    const varPattern = new RegExp(
      `\\b(${[...allVarNames].map(escapeRegex).join('|')})\\.(\\w+)`,
      'g',
    );

    for (let lineIdx = 0; lineIdx < document.lineCount; lineIdx++) {
      const lineText = document.lineAt(lineIdx).text;
      let match: RegExpExecArray | null;
      varPattern.lastIndex = 0;
      while ((match = varPattern.exec(lineText)) !== null) {
        const varName = match[1];
        const attrName = match[2];

        // Resolve class using function scope
        const funcName = findEnclosingFunction(document, lineIdx);
        const scopeKey = `${funcName || ''}:${varName}`;
        const cls = scopedVarTypes.get(scopeKey)
          || (!funcName ? scopedVarTypes.get(`:${varName}`) : undefined);
        if (!cls) continue;

        const known = KNOWN_TYPE_MEMBERS[cls];
        if (!known) continue;

        const attrStart = match.index + varName.length + 1;
        if (known.methods.includes(attrName)) {
          builder.push(lineIdx, attrStart, attrName.length, TOKEN_TYPE_METHOD);
        } else if (known.props.includes(attrName)) {
          builder.push(lineIdx, attrStart, attrName.length, TOKEN_TYPE_PROPERTY);
        }
      }
    }

    return builder.build();
  }
}
