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

/** Index: filePath -> Map<lineNumber, observation[]> */
type VarIndex = Map<string, Map<number, VariableObservation[]>>;

/** Index for notebook cells: "notebookPath#cell_N" -> Map<lineNumber, observation[]> */
type NotebookCellIndex = Map<string, Map<number, VariableObservation[]>>;

let varIndex: VarIndex = new Map();
let notebookCellIndex: NotebookCellIndex = new Map();
let fileWatcher: vscode.FileSystemWatcher | undefined;
let statusBarItem: vscode.StatusBarItem;
let inlineHintsProvider: vscode.Disposable | undefined;
/** Fires to tell VSCode to re-query inlay hints after data changes. */
const inlayHintsChangeEmitter = new vscode.EventEmitter<void>();

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.command = 'trickle.refreshVariables';
  context.subscriptions.push(statusBarItem);

  // Load variable data
  loadAllVariables();

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
  }

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
          varIndex.clear();
          notebookCellIndex.clear();
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
  inlineHintsProvider?.dispose();
  inlayHintsChangeEmitter.dispose();
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
          const obs: VariableObservation = JSON.parse(line);
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
            lineMap.get(obs.line)!.push(obs);
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

/** Get the line map for a document, handling both regular files and notebook cells. */
function getLineMapForDocument(document: vscode.TextDocument): Map<number, VariableObservation[]> | undefined {
  // Regular file
  if (document.uri.scheme === 'file') {
    return varIndex.get(document.uri.fsPath);
  }

  // Notebook cell: URI looks like vscode-notebook-cell:/path/notebook.ipynb#fragment
  if (document.uri.scheme === 'vscode-notebook-cell') {
    // Extract the notebook path and cell index
    const notebookUri = document.uri.with({ scheme: 'file', fragment: '' });
    const notebookPath = notebookUri.fsPath;

    // Find the cell index from the notebook
    const cellIndex = getNotebookCellIndex(document);
    if (cellIndex === undefined) return undefined;

    // Look up by various cell ID formats
    const cellId1 = `${notebookPath}#cell_${cellIndex}`;
    const cellId2 = path.join(path.dirname(notebookPath), `__notebook__cell_${cellIndex}.py`);

    const result = notebookCellIndex.get(cellId1) || notebookCellIndex.get(cellId2);
    if (result) return result;

    // Fallback: Python's _cell_counter only counts executed code cells,
    // but VSCode's cell index counts all cells (including markdown).
    // Also, the __notebook__ path uses Python's CWD which may differ from
    // the notebook directory. Try matching by scanning all keys.
    const cellSuffix1 = `#cell_${cellIndex}`;
    const cellSuffix2 = `__notebook__cell_${cellIndex}.py`;

    for (const [key, lineMap] of notebookCellIndex) {
      if (key.endsWith(cellSuffix1) || key.endsWith(cellSuffix2)) {
        return lineMap;
      }
    }

    // If cell index doesn't match (markdown cells shift the count),
    // try matching by document content: find the cell whose observations
    // best match the variable names visible in this cell's text.
    const cellText = document.getText();
    return findBestMatchingCell(cellText);
  }

  return undefined;
}

/** Find the notebook cell index entry that best matches the given cell text. */
function findBestMatchingCell(cellText: string): Map<number, VariableObservation[]> | undefined {
  let bestMatch: Map<number, VariableObservation[]> | undefined;
  let bestScore = 0;

  for (const [, lineMap] of notebookCellIndex) {
    let score = 0;
    let total = 0;
    for (const obsArr of lineMap.values()) {
      for (const obs of obsArr) {
        total++;
        // Check if this variable name appears in the cell text at roughly the right line
        const varPattern = new RegExp(`\\b${escapeRegex(obs.varName)}\\b`);
        if (varPattern.test(cellText)) {
          score++;
        }
      }
    }
    if (total > 0 && score > bestScore) {
      bestScore = score;
      bestMatch = lineMap;
    }
  }

  // Only return if we have a reasonable match (at least half the variables found)
  if (bestMatch && bestScore > 0) return bestMatch;
  return undefined;
}

/** Get the 1-based code cell index for a notebook cell document.
 * Only counts code cells (not markdown) to match Python's _cell_counter. */
function getNotebookCellIndex(document: vscode.TextDocument): number | undefined {
  for (const notebook of vscode.workspace.notebookDocuments) {
    let codeCellIndex = 0;
    for (let i = 0; i < notebook.cellCount; i++) {
      const cell = notebook.cellAt(i);
      if (cell.kind === vscode.NotebookCellKind.Code) {
        codeCellIndex++;
        if (cell.document === document) {
          return codeCellIndex; // 1-based to match Python's _cell_counter
        }
      }
    }
  }
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
      const typeStr = typeNodeToString(obs.type);
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
          const typeStr = typeNodeToString(obs.type);
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

        const typeStr = typeNodeToString(obs.type);
        const position = new vscode.Position(lineNo - 1, varEnd);

        const label = isPython ? `: ${typeStr}` : `: ${typeStr}`;
        const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Type);
        hint.paddingLeft = false;
        hint.paddingRight = true;

        // Add funcName and sample value as tooltip
        const tooltipParts: string[] = [];
        if (obs.funcName) tooltipParts.push(`**Function:** \`${obs.funcName}\``);
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
function extractShapeStr(type: TypeNode): string {
  if (!type.properties) return type.class_name || 'unknown';
  const shape = type.properties['shape'];
  const dtype = type.properties['dtype'];
  const device = type.properties['device'];
  const gradFn = type.properties['grad_fn'];

  let result = type.class_name || 'Tensor';
  if (shape?.kind === 'primitive' && shape.name) {
    result += shape.name;
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
function typeNodeToString(node: TypeNode, depth: number = 3): string {
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
        return formatTensorType(node.class_name, node.properties);
      }

      // nn.Module types: show key params, omit 'params' count from inline display
      if (node.class_name && node.properties['params']) {
        const paramCount = node.properties['params']?.name;
        const displayEntries = entries.filter(([k]) => k !== 'params');
        if (displayEntries.length === 0) {
          return paramCount ? `${node.class_name}(${paramCount} params)` : node.class_name;
        }
        const props = displayEntries.slice(0, 4).map(([k, v]) => `${k}=${typeNodeToString(v, depth - 1)}`);
        const suffix = displayEntries.length > 4 ? ', ...' : '';
        return `${node.class_name}(${props.join(', ')}${suffix})`;
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
 * E.g. Tensor[1, 16, 32] float32 @cpu
 */
function formatTensorType(className: string, properties: Record<string, TypeNode>): string {
  const parts: string[] = [className];

  // Shape: stored as primitive with name like "[1, 16, 32]"
  const shapeProp = properties['shape'];
  if (shapeProp?.kind === 'primitive' && shapeProp.name) {
    parts[0] = `${className}${shapeProp.name}`;
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
