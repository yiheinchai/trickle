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
  type: TypeNode;
  typeHash: string;
  sample: unknown;
}

interface TypeNode {
  kind: string;
  name?: string;
  element?: TypeNode;
  elements?: TypeNode[];
  properties?: Record<string, TypeNode>;
  resolved?: TypeNode;
}

/** Index: filePath -> Map<lineNumber, observation[]> */
type VarIndex = Map<string, Map<number, VariableObservation[]>>;

let varIndex: VarIndex = new Map();
let fileWatcher: vscode.FileSystemWatcher | undefined;
let statusBarItem: vscode.StatusBarItem;
let inlineHintsProvider: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.command = 'trickle.refreshVariables';
  context.subscriptions.push(statusBarItem);

  // Load variable data
  loadAllVariables();

  // Register hover provider for all common file types
  const selector: vscode.DocumentSelector = [
    { scheme: 'file', language: 'typescript' },
    { scheme: 'file', language: 'typescriptreact' },
    { scheme: 'file', language: 'javascript' },
    { scheme: 'file', language: 'javascriptreact' },
  ];

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, new TrickleHoverProvider()),
  );

  // Register inline hints provider
  registerInlineHints(context, selector);

  // Watch for changes to variables.jsonl
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const pattern = new vscode.RelativePattern(workspaceFolders[0], '.trickle/variables.jsonl');
    fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    fileWatcher.onDidChange(() => loadAllVariables());
    fileWatcher.onDidCreate(() => loadAllVariables());
    fileWatcher.onDidDelete(() => {
      varIndex.clear();
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
}

function countVars(): number {
  let count = 0;
  for (const lineMap of varIndex.values()) {
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

          // Normalize file path
          const filePath = obs.file;

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

class TrickleHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const config = vscode.workspace.getConfiguration('trickle');
    if (!config.get('enabled', true)) return undefined;

    const filePath = document.uri.fsPath;
    const lineMap = varIndex.get(filePath);
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

    // Check exact line first
    const obsAtLine = lineMap.get(lineNo);
    if (obsAtLine) {
      for (const obs of obsAtLine) {
        if (obs.varName === word) candidates.push(obs);
      }
    }

    // If no exact match, search all lines in this file for this variable name
    if (candidates.length === 0) {
      for (const [, obsArr] of lineMap) {
        for (const obs of obsArr) {
          if (obs.varName === word) candidates.push(obs);
        }
      }
    }

    if (candidates.length === 0) return undefined;

    // Build hover content
    const showSamples = config.get('showSampleValues', true);
    const parts: string[] = [];

    for (const obs of candidates) {
      const typeStr = typeNodeToString(obs.type);
      parts.push(`**\`${obs.varName}\`** (line ${obs.line}): \`${typeStr}\``);

      if (showSamples && obs.sample !== undefined) {
        const sampleStr = formatSample(obs.sample);
        parts.push(`\n*Sample:*\n\`\`\`json\n${sampleStr}\n\`\`\``);
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
  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.InlayHint[] {
    const config = vscode.workspace.getConfiguration('trickle');
    if (!config.get('enabled', true) || !config.get('inlineHints', true)) return [];

    const filePath = document.uri.fsPath;
    const lineMap = varIndex.get(filePath);
    if (!lineMap) return [];

    const hints: vscode.InlayHint[] = [];

    for (const [lineNo, observations] of lineMap) {
      if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;

      for (const obs of observations) {
        const line = document.lineAt(lineNo - 1);
        const lineText = line.text;

        // Find the variable name in the line
        const varPattern = new RegExp(`\\b${escapeRegex(obs.varName)}\\b`);
        const match = varPattern.exec(lineText);
        if (!match) continue;

        // Check this is a declaration line (has const/let/var before the variable)
        const beforeVar = lineText.substring(0, match.index);
        if (!/\b(const|let|var)\s+$/.test(beforeVar) && !/\bexport\s+(const|let|var)\s+$/.test(beforeVar)) continue;

        // Find the end of the variable name — place hint after it
        const varEnd = match.index + obs.varName.length;

        // Check if there's already a type annotation
        const afterVar = lineText.substring(varEnd).trimStart();
        if (afterVar.startsWith(':') && !afterVar.startsWith(':=')) continue;

        const typeStr = typeNodeToString(obs.type);
        const position = new vscode.Position(lineNo - 1, varEnd);

        const hint = new vscode.InlayHint(position, `: ${typeStr}`, vscode.InlayHintKind.Type);
        hint.paddingLeft = false;
        hint.paddingRight = true;

        // Add sample value as tooltip
        if (config.get('showSampleValues', true) && obs.sample !== undefined) {
          const sampleStr = formatSample(obs.sample);
          hint.tooltip = new vscode.MarkdownString(`**Sample value:**\n\`\`\`json\n${sampleStr}\n\`\`\``);
        }

        hints.push(hint);
      }
    }

    return hints;
  }
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
  // Trigger inlay hints refresh by firing a dummy config change
  // VS Code automatically re-queries inlay hints when the document changes
  // For now, we rely on the file watcher triggering a refresh
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert a TypeNode to a readable TypeScript type string */
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
      if (!node.properties) return 'object';
      const entries = Object.entries(node.properties);
      if (entries.length === 0) return '{}';

      // Special cases
      if ('__date' in node.properties) return 'Date';
      if ('__regexp' in node.properties) return 'RegExp';
      if ('__error' in node.properties) return 'Error';

      if (entries.length <= 5) {
        const props = entries.map(([k, v]) => `${k}: ${typeNodeToString(v, depth - 1)}`);
        return `{ ${props.join('; ')} }`;
      }

      const first4 = entries.slice(0, 4).map(([k, v]) => `${k}: ${typeNodeToString(v, depth - 1)}`);
      return `{ ${first4.join('; ')}; ... }`;
    }

    case 'function':
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
