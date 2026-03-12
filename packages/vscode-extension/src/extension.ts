import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

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
}

interface TypeNode {
  kind: string;
  name?: string;
  class_name?: string;
  element?: TypeNode;
  elements?: TypeNode[];
  properties?: Record<string, TypeNode>;
  resolved?: TypeNode;
}

/** A dimension label record from variables.jsonl */
interface DimLabelRecord {
  kind: 'dim_labels';
  varName: string;
  labels: string[];
  line: number;
  file: string;
  funcName?: string;
}

/** Index: filePath -> Map<lineNumber, observation[]> */
type VarIndex = Map<string, Map<number, VariableObservation[]>>;

/** Index for notebook cells: "notebookPath#cell_N" -> Map<lineNumber, observation[]> */
type NotebookCellIndex = Map<string, Map<number, VariableObservation[]>>;

/** Index: filePath -> Map<varName, DimLabelRecord> (most recent per var per file+func) */
type DimLabelIndex = Map<string, Map<string, DimLabelRecord>>;

/** A runtime error record from errors.jsonl */
interface ErrorRecord {
  kind: 'error';
  error_type: string;
  message: string;
  file: string;
  line: number;
  function: string;
  shape_context: string[];
  frames: { file: string; line: number; function: string }[];
}

let varIndex: VarIndex = new Map();
let notebookCellIndex: NotebookCellIndex = new Map();
let dimLabelIndex: DimLabelIndex = new Map();
let fileWatcher: vscode.FileSystemWatcher | undefined;
let errorFileWatcher: vscode.FileSystemWatcher | undefined;
let statusBarItem: vscode.StatusBarItem;
let inlineHintsProvider: vscode.Disposable | undefined;
let diagnosticCollection: vscode.DiagnosticCollection;
/** Fires to tell VSCode to re-query inlay hints after data changes. */
const inlayHintsChangeEmitter = new vscode.EventEmitter<void>();

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.command = 'trickle.refreshVariables';
  context.subscriptions.push(statusBarItem);

  // Create diagnostic collection for error reporting
  diagnosticCollection = vscode.languages.createDiagnosticCollection('trickle');
  context.subscriptions.push(diagnosticCollection);

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

  // Watch for changes to variables.jsonl with debouncing for rapid writes
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const pattern = new vscode.RelativePattern(workspaceFolders[0], '.trickle/variables.jsonl');
    fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    const debouncedReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => loadAllVariables(), 300);
    };

    fileWatcher.onDidChange(debouncedReload);
    fileWatcher.onDidCreate(debouncedReload);
    fileWatcher.onDidDelete(() => {
      if (reloadTimer) clearTimeout(reloadTimer);
      varIndex.clear();
      notebookCellIndex.clear();
      updateStatusBar();
      refreshInlineHints();
    });
    context.subscriptions.push(fileWatcher);

    // Watch errors.jsonl for crash diagnostics
    const errorPattern = new vscode.RelativePattern(workspaceFolders[0], '.trickle/errors.jsonl');
    errorFileWatcher = vscode.workspace.createFileSystemWatcher(errorPattern);

    let errorReloadTimer: ReturnType<typeof setTimeout> | undefined;
    const debouncedErrorReload = () => {
      if (errorReloadTimer) clearTimeout(errorReloadTimer);
      errorReloadTimer = setTimeout(() => loadErrors(), 300);
    };

    errorFileWatcher.onDidChange(debouncedErrorReload);
    errorFileWatcher.onDidCreate(debouncedErrorReload);
    errorFileWatcher.onDidDelete(() => {
      if (errorReloadTimer) clearTimeout(errorReloadTimer);
      diagnosticCollection.clear();
    });
    context.subscriptions.push(errorFileWatcher);
  }

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
        const jsonlPath = path.join(workspaceFolders[0].uri.fsPath, '.trickle', 'variables.jsonl');
        try {
          fs.writeFileSync(jsonlPath, '');
          // Also clear errors
          const errorsPath = path.join(workspaceFolders[0].uri.fsPath, '.trickle', 'errors.jsonl');
          try { fs.writeFileSync(errorsPath, ''); } catch { /* ignore */ }
          varIndex.clear();
          notebookCellIndex.clear();
          diagnosticCollection.clear();
          updateStatusBar();
          refreshInlineHints();
          vscode.window.showInformationMessage('Trickle: Variable data cleared');
        } catch {
          vscode.window.showErrorMessage('Trickle: Failed to clear variable data');
        }
      }
    }),
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('trickle.inlineHints')) {
        registerInlineHints(context, selector);
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
  dimLabelIndex.clear();

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;

  for (const folder of workspaceFolders) {
    const jsonlPath = path.join(folder.uri.fsPath, '.trickle', 'variables.jsonl');
    if (!fs.existsSync(jsonlPath)) continue;

    try {
      const content = fs.readFileSync(jsonlPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const record = JSON.parse(line);

          // Handle dim_labels records
          if (record.kind === 'dim_labels') {
            const dl = record as DimLabelRecord;
            const key = dl.funcName ? `${dl.file}:${dl.funcName}:${dl.varName}` : `${dl.file}::${dl.varName}`;
            if (!dimLabelIndex.has(dl.file)) {
              dimLabelIndex.set(dl.file, new Map());
            }
            dimLabelIndex.get(dl.file)!.set(key, dl);
            continue;
          }

          const obs = record as VariableObservation;
          if (obs.kind !== 'variable') continue;

          const filePath = obs.file;

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
          lineMap.get(obs.line)!.push(obs);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File read error
    }
  }

  updateStatusBar();
  refreshInlineHints();
}

function loadErrors() {
  diagnosticCollection.clear();

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;

  for (const folder of workspaceFolders) {
    const errorsPath = path.join(folder.uri.fsPath, '.trickle', 'errors.jsonl');
    if (!fs.existsSync(errorsPath)) continue;

    try {
      const content = fs.readFileSync(errorsPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());

      const diagsByFile = new Map<string, vscode.Diagnostic[]>();

      for (const line of lines) {
        try {
          const err: ErrorRecord = JSON.parse(line);
          if (err.kind !== 'error') continue;

          // Build diagnostic message with shape context
          let message = `${err.error_type}: ${err.message}`;
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
  let bestMatch: Map<number, VariableObservation[]> | undefined;
  let bestScore = 0;
  let bestCellNum = -1;

  for (const [key, lineMap] of notebookCellIndex) {
    let score = 0;
    let total = 0;
    for (const obsArr of lineMap.values()) {
      for (const obs of obsArr) {
        total++;
        const varPattern = new RegExp(`\\b${escapeRegex(obs.varName)}\\b`);
        if (varPattern.test(cellText)) {
          score++;
        }
      }
    }

    // Extract cell number from key for tie-breaking (prefer most recent)
    const cellNumMatch = key.match(/cell_(\d+)/);
    const cellNum = cellNumMatch ? parseInt(cellNumMatch[1], 10) : 0;

    if (total > 0 && (score > bestScore || (score === bestScore && cellNum > bestCellNum))) {
      bestScore = score;
      bestMatch = lineMap;
      bestCellNum = cellNum;
    }
  }

  if (bestMatch && bestScore > 0) return bestMatch;
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
      const labels = getDimLabels(obs);
      const typeStr = typeNodeToString(obs.type, 3, labels);
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
            const foLabels = getDimLabels(fo);
            const shape = extractShapeStr(fo.type, foLabels);
            const stats = formatTensorStats(fo.type);
            const marker = fo.line === obs.line ? ' **←**' : '';
            flowLines.push(`  L${fo.line}: \`${shape}\`${stats}${marker}`);
          }
          parts.push(flowLines.join('\n\n'));
        } else {
          parts.push(`**\`${obs.varName}\`** (line ${obs.line}${funcCtx}): \`${typeStr}\``);
          const stats = formatTensorStats(obs.type);
          if (stats) parts.push(stats);
        }
      } else if (className === 'Tensor' || className === 'ndarray') {
        parts.push(`**\`${obs.varName}\`** (line ${obs.line}${funcCtx}): \`${typeStr}\``);
        const stats = formatTensorStats(obs.type);
        if (stats) parts.push(stats);
      } else {
        parts.push(`**\`${obs.varName}\`** (line ${obs.line}${funcCtx}): \`${typeStr}\``);
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
          const retLabels = getDimLabels(obs);
          const typeStr = typeNodeToString(obs.type, 3, retLabels);
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
          // JS/TS: check for const/let/var
          if (!/\b(const|let|var)\s+$/.test(beforeVar) && !/\bexport\s+(const|let|var)\s+$/.test(beforeVar)) continue;

          // Check if there's already a type annotation
          if (afterVar.startsWith(':') && !afterVar.startsWith(':=')) continue;
        }

        const obsLabels = getDimLabels(obs);
        const typeStr = typeNodeToString(obs.type, 3, obsLabels);
        const position = new vscode.Position(lineNo - 1, varEnd);

        const label = isPython ? `: ${typeStr}` : `: ${typeStr}`;
        const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Type);
        hint.paddingLeft = false;
        hint.paddingRight = true;

        // Add funcName, tensor stats, and sample value as tooltip
        const tooltipParts: string[] = [];
        if (obs.funcName) tooltipParts.push(`**Function:** \`${obs.funcName}\``);
        const stats = formatTensorStats(obs.type);
        if (stats) tooltipParts.push(`**Stats:**${stats}`);
        if (config.get('showSampleValues', true) && obs.sample !== undefined) {
          tooltipParts.push(`**Sample value:**\n\`\`\`json\n${formatSample(obs.sample)}\n\`\`\``);
        }
        if (tooltipParts.length > 0) {
          hint.tooltip = new vscode.MarkdownString(tooltipParts.join('\n\n'));
        }

        hints.push(hint);
      }
    }

    return hints;
  }
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

/** Look up dimension labels for a tensor variable from the dimLabelIndex. */
function getDimLabels(obs: VariableObservation): string[] | undefined {
  const fileLabels = dimLabelIndex.get(obs.file);
  if (!fileLabels) return undefined;
  // Try func-scoped key first, then file-scoped
  const funcKey = obs.funcName ? `${obs.file}:${obs.funcName}:${obs.varName}` : `${obs.file}::${obs.varName}`;
  const record = fileLabels.get(funcKey);
  if (record) return record.labels;
  // Also try without func for attribute vars like "self.x" -> look up "x"
  if (obs.varName.includes('.')) {
    const baseName = obs.varName.split('.').pop()!;
    const baseKey = obs.funcName ? `${obs.file}:${obs.funcName}:${baseName}` : `${obs.file}::${baseName}`;
    const baseRecord = fileLabels.get(baseKey);
    if (baseRecord) return baseRecord.labels;
  }
  return undefined;
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
        return `[${node.elements.map(e => typeNodeToString(e, depth - 1)).join(', ')}]`;
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

      // Special case for PyTorch Tensor / NumPy ndarray:
      // These have shape, dtype (and optionally device) as properties
      // where the values are stored as primitive name strings like "[1, 16, 32]"
      if (node.class_name === 'Tensor' || node.class_name === 'ndarray') {
        return formatTensorType(node.class_name, node.properties, dimLabels);
      }

      // nn.Module types: show key params, omit 'params'/'training' from inline props
      if (node.class_name && node.properties['params']) {
        const paramCount = node.properties['params']?.name;
        const trainingMode = node.properties['training']?.name;
        const modeBadge = trainingMode === 'False' ? ' [eval]' : '';
        const displayEntries = entries.filter(([k]) => k !== 'params' && k !== 'training' && k !== 'param_groups');
        if (displayEntries.length === 0) {
          return paramCount ? `${node.class_name}(${paramCount} params)${modeBadge}` : `${node.class_name}${modeBadge}`;
        }
        const props = displayEntries.slice(0, 4).map(([k, v]) => `${k}=${typeNodeToString(v, depth - 1)}`);
        const suffix = displayEntries.length > 4 ? ', ...' : '';
        return `${node.class_name}(${props.join(', ')}${suffix})${modeBadge}`;
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

    case 'union':
      if (node.elements) {
        return node.elements.map(e => typeNodeToString(e, depth - 1)).join(' | ');
      }
      return 'unknown';

    default:
      return 'unknown';
  }
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
  const valueProp = properties['value'];
  if (valueProp?.kind === 'primitive' && valueProp.name) {
    parts.push(`= ${valueProp.name}`);
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
  const min = type.properties['min'];
  const max = type.properties['max'];
  const mean = type.properties['mean'];
  if (!min || !max || !mean) return '';
  return ` \`min=${min.name} max=${max.name} mean=${mean.name}\``;
}

/** Format a sample value for display */
function formatSample(sample: unknown): string {
  if (sample === undefined) return 'undefined';
  if (sample === null) return 'null';

  try {
    const str = JSON.stringify(sample, null, 2);
    // Truncate long samples
    if (str.length > 500) {
      return str.substring(0, 500) + '\n// ... truncated';
    }
    return str;
  } catch {
    return String(sample);
  }
}
