import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const _EXPLODING_THRESHOLD = 100.0;
const _VANISHING_THRESHOLD = 1e-6;

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

/** A gradient flow record emitted after loss.backward() */
interface GradientLayer {
  name: string;
  norm: number;
  vanishing: boolean;
  exploding: boolean;
}

interface GradientRecord {
  kind: 'gradient';
  file: string;
  line: number;
  model_var: string;
  layers: GradientLayer[];
  max_norm: number;
  min_norm: number;
  num_layers: number;
  vanishing: string[];
  exploding: string[];
  timestamp: number;
}

/** A learning rate schedule record emitted after scheduler.step() */
interface LrScheduleRecord {
  kind: 'lr_schedule';
  file: string;
  line: number;
  lrs: number[];
  step_num: number;
  context: Record<string, number>;
  timestamp: number;
  scheduler_class: string;
}

/** A model checkpoint record emitted after torch.save / save_pretrained */
interface CheckpointRecord {
  kind: 'checkpoint';
  file: string;
  line: number;
  path: string;
  metrics: Record<string, number | string>;
  timestamp: number;
  save_count: number;
}

/** An optimizer step record emitted after optimizer.step() */
interface OptimizerParamStat {
  lr: number;
  n_params: number;
  param_norm: number;
  param_mean: number;
  param_std: number;
}

interface OptimizerStepRecord {
  kind: 'optimizer_step';
  file: string;
  line: number;
  grad_norm: number;
  update_norm: number;
  param_stats: OptimizerParamStat[];
  step_num: number;
  context: Record<string, number>;
  optimizer_class: string;
  exploding: boolean;
  vanishing: boolean;
  timestamp: number;
}

/** Attention statistics record emitted after each attention softmax call */
interface AttentionStatsRecord {
  kind: 'attention_stats';
  file: string;
  line: number;
  n_heads: number;
  seq_len: number;
  mean_entropy: number;
  max_entropy: number;
  head_entropies: number[];
  dead_heads: number;
  sharp_heads: number;
  mean_max_pos: number;
  diag_attn: number;
  call_count: number;
  timestamp: number;
}

/** Loss probe record emitted after each loss.backward() call */
interface LossProbeRecord {
  kind: 'loss_probe';
  file: string;
  line: number;
  loss: number;
  loss_avg: number;
  loss_delta: number;
  loss_std: number;
  pattern: 'decreasing' | 'increasing' | 'plateau' | 'oscillating' | 'diverging' | 'stable' | 'unknown';
  step: number;
  timestamp: number;
}

/** Activation statistics record emitted after each nn.Module forward pass */
interface ActivationStatsRecord {
  kind: 'activation_stats';
  file: string;
  line: number;
  module_name: string;
  call_count: number;
  mean: number;
  std: number;
  min: number;
  max: number;
  numel: number;
  shape: number[];
  zero_frac?: number;
  sat_frac?: number;
  vanishing?: boolean;
  exploding?: boolean;
  timestamp: number;
}

/** A DataLoader batch shape record emitted on each iteration */
interface DataloaderBatchShape {
  shape?: number[];
  dtype?: string;
  index?: number;
  key?: string;
}

interface DataloaderBatchRecord {
  kind: 'dataloader_batch';
  file: string;
  line: number;
  shapes: DataloaderBatchShape[];
  batch_num: number;
  timestamp: number;
}

/** Training throughput record emitted by the DataLoader hook */
interface TrainingThroughputRecord {
  kind: 'training_throughput';
  file: string;
  line: number;
  samples_per_sec: number;
  batches_per_sec: number;
  batch_size: number;
  batch_count: number;
  total_batches?: number;
  eta_seconds?: number;
  timestamp: number;
}

/** React component render tracking record emitted by the Vite plugin */
interface ReactRenderRecord {
  kind: 'react_render';
  file: string;
  line: number;
  component: string;
  renderCount: number;
  props?: Record<string, unknown>;
  propKeys?: string[];
  changedProps?: Array<{ key: string; from: unknown; to: unknown }>;
  timestamp: number;
}

/** React hook invocation record emitted by the Vite plugin */
interface ReactHookRecord {
  kind: 'react_hook';
  file: string;
  line: number;
  hookName: string;
  invokeCount: number;
  timestamp: number;
}

/** React useState update record emitted by the Vite plugin */
interface ReactStateRecord {
  kind: 'react_state';
  file: string;
  line: number;
  stateName: string;
  updateCount: number;
  value: unknown;
  timestamp: number;
}

/** A training progress record emitted by trickle.progress() */
interface ProgressRecord {
  kind: 'progress';
  file: string;
  line: number;
  metrics: Record<string, number | boolean | string>;
  timestamp: number;
  call_count: number;
}

let varIndex: VarIndex = new Map();
let notebookCellIndex: NotebookCellIndex = new Map();
let dimLabelIndex: DimLabelIndex = new Map();
let latestProgress: ProgressRecord | null = null;
/** Gradient flow records: filePath -> lineNo -> GradientRecord (latest per line) */
let gradientIndex: Map<string, Map<number, GradientRecord>> = new Map();
/** Checkpoint records: filePath -> lineNo -> CheckpointRecord[] (all saves at that line) */
let checkpointIndex: Map<string, Map<number, CheckpointRecord[]>> = new Map();
/** LR schedule records: filePath -> lineNo -> LrScheduleRecord (latest per line) */
let lrScheduleIndex: Map<string, Map<number, LrScheduleRecord>> = new Map();
/** Optimizer step records: filePath -> lineNo -> OptimizerStepRecord (latest) */
let optimizerIndex: Map<string, Map<number, OptimizerStepRecord>> = new Map();
/** DataLoader batch shapes: filePath -> lineNo -> DataloaderBatchRecord (latest) */
let dataloaderIndex: Map<string, Map<number, DataloaderBatchRecord>> = new Map();
/** Training throughput: filePath -> lineNo -> TrainingThroughputRecord (latest) */
let throughputIndex: Map<string, Map<number, TrainingThroughputRecord>> = new Map();
/** Activation statistics: filePath -> lineNo -> ActivationStatsRecord (latest) */
let activationIndex: Map<string, Map<number, ActivationStatsRecord>> = new Map();
/** Loss probe records: filePath -> lineNo -> LossProbeRecord (latest) */
let lossProbeIndex: Map<string, Map<number, LossProbeRecord>> = new Map();
/** Attention statistics: filePath -> lineNo -> AttentionStatsRecord (latest) */
let attentionIndex: Map<string, Map<number, AttentionStatsRecord>> = new Map();
/** React render counts: filePath -> lineNo -> ReactRenderRecord (latest) */
let reactRenderIndex: Map<string, Map<number, ReactRenderRecord>> = new Map();
/** React hook invocation counts: filePath -> lineNo -> ReactHookRecord (latest) */
let reactHookIndex: Map<string, Map<number, ReactHookRecord>> = new Map();
/** React useState update counts: filePath -> lineNo -> ReactStateRecord (latest) */
let reactStateIndex: Map<string, Map<number, ReactStateRecord>> = new Map();
/** Crash-site local vars: filePath -> lineNo -> CrashLocalVar[] */
let crashVarIndex: Map<string, Map<number, CrashLocalVar[]>> = new Map();
let fileWatcher: vscode.FileSystemWatcher | undefined;
let errorFileWatcher: vscode.FileSystemWatcher | undefined;
let statusBarItem: vscode.StatusBarItem;
let inlineHintsProvider: vscode.Disposable | undefined;
let diagnosticCollection: vscode.DiagnosticCollection;
/** Fires to tell VSCode to re-query inlay hints after data changes. */
const inlayHintsChangeEmitter = new vscode.EventEmitter<void>();

/** Type hashes from the previous load: "file:line:varName" → typeHash */
let prevTypeHashes: Map<string, string> = new Map();
/** Variables whose type changed since the last run: "file:line:varName" */
let changedVarKeys: Set<string> = new Set();

/** Load persisted type hashes from .trickle/type_history.json for cross-session drift detection. */
function loadTypeHistory(): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;
  const historyPath = path.join(workspaceFolders[0].uri.fsPath, '.trickle', 'type_history.json');
  try {
    if (fs.existsSync(historyPath)) {
      const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      if (data && typeof data === 'object') {
        prevTypeHashes = new Map(Object.entries(data));
      }
    }
  } catch {
    // Ignore — corrupt or missing history is non-fatal
  }
}

/** Persist current type hashes to .trickle/type_history.json for next session. */
function saveTypeHistory(hashes: Map<string, string>): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;
  const trickleDir = path.join(workspaceFolders[0].uri.fsPath, '.trickle');
  const historyPath = path.join(trickleDir, 'type_history.json');
  try {
    if (!fs.existsSync(trickleDir)) fs.mkdirSync(trickleDir, { recursive: true });
    const obj: Record<string, string> = {};
    hashes.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(historyPath, JSON.stringify(obj), 'utf8');
  } catch {
    // Non-fatal — persistence is best-effort
  }
}

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBarItem.command = 'trickle.refreshVariables';
  context.subscriptions.push(statusBarItem);

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
      errorReloadTimer = setTimeout(() => { loadErrors(); refreshInlineHints(); }, 300);
    };

    errorFileWatcher.onDidChange(debouncedErrorReload);
    errorFileWatcher.onDidCreate(debouncedErrorReload);
    errorFileWatcher.onDidDelete(() => {
      if (errorReloadTimer) clearTimeout(errorReloadTimer);
      diagnosticCollection.clear();
      crashVarIndex.clear();
      refreshInlineHints();
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

/** Ordered list of common training metric keys — shown first in status bar. */
const PROGRESS_KEY_ORDER = ['epoch', 'step', 'batch', 'iter', 'loss', 'train_loss',
  'val_loss', 'acc', 'accuracy', 'val_acc', 'lr', 'f1', 'auc'];

/** Format a single metric value for the status bar (compact). */
function formatProgressValue(val: number | boolean | string): string {
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return String(val);
    return val.toFixed(4).replace(/\.?0+$/, '');
  }
  return String(val);
}

function updateStatusBar() {
  // Show training progress when a recent trickle.progress() record exists (< 120 s)
  if (latestProgress) {
    const ageSeconds = Date.now() / 1000 - latestProgress.timestamp;
    if (ageSeconds < 120) {
      const m = latestProgress.metrics;
      const parts: string[] = [];

      // Priority keys first, then any remaining ones
      for (const key of PROGRESS_KEY_ORDER) {
        if (key in m) {
          parts.push(`${key} ${formatProgressValue(m[key])}`);
        }
      }
      for (const [key, val] of Object.entries(m)) {
        if (!PROGRESS_KEY_ORDER.includes(key)) {
          parts.push(`${key} ${formatProgressValue(val)}`);
        }
      }

      if (parts.length > 0) {
        statusBarItem.text = `$(sync~spin) Training: ${parts.join(' | ')}`;
        statusBarItem.tooltip = `Training progress from trickle.progress()\n${latestProgress.file}:${latestProgress.line}\nCall #${latestProgress.call_count}\nClick to refresh`;
        statusBarItem.show();
        return;
      }
    }
  }

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
  latestProgress = null;
  gradientIndex.clear();
  checkpointIndex.clear();
  lrScheduleIndex.clear();
  dataloaderIndex.clear();
  optimizerIndex.clear();
  throughputIndex.clear();
  activationIndex.clear();
  lossProbeIndex.clear();
  attentionIndex.clear();
  reactRenderIndex.clear();
  reactHookIndex.clear();
  reactStateIndex.clear();

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

          // Handle progress records from trickle.progress()
          if (record.kind === 'progress') {
            const pr = record as ProgressRecord;
            if (!latestProgress || pr.timestamp > latestProgress.timestamp) {
              latestProgress = pr;
            }
            continue;
          }

          // Handle LR schedule records emitted after scheduler.step()
          if (record.kind === 'lr_schedule') {
            const lr = record as LrScheduleRecord;
            if (!lrScheduleIndex.has(lr.file)) {
              lrScheduleIndex.set(lr.file, new Map());
            }
            const lineMap = lrScheduleIndex.get(lr.file)!;
            const existing = lineMap.get(lr.line);
            if (!existing || lr.timestamp > existing.timestamp) {
              lineMap.set(lr.line, lr);
            }
            continue;
          }

          // Handle checkpoint records emitted after torch.save / save_pretrained
          if (record.kind === 'checkpoint') {
            const cr = record as CheckpointRecord;
            if (!checkpointIndex.has(cr.file)) {
              checkpointIndex.set(cr.file, new Map());
            }
            const lineMap = checkpointIndex.get(cr.file)!;
            if (!lineMap.has(cr.line)) {
              lineMap.set(cr.line, []);
            }
            lineMap.get(cr.line)!.push(cr);
            continue;
          }

          // Handle gradient flow records emitted after loss.backward()
          if (record.kind === 'gradient') {
            const gr = record as GradientRecord;
            if (!gradientIndex.has(gr.file)) {
              gradientIndex.set(gr.file, new Map());
            }
            const lineMap = gradientIndex.get(gr.file)!;
            const existing = lineMap.get(gr.line);
            if (!existing || gr.timestamp > existing.timestamp) {
              lineMap.set(gr.line, gr);
            }
            continue;
          }

          // Handle optimizer step records
          if (record.kind === 'optimizer_step') {
            const op = record as OptimizerStepRecord;
            if (!optimizerIndex.has(op.file)) {
              optimizerIndex.set(op.file, new Map());
            }
            const lineMap = optimizerIndex.get(op.file)!;
            const existing = lineMap.get(op.line);
            if (!existing || op.timestamp > existing.timestamp) {
              lineMap.set(op.line, op);
            }
            continue;
          }

          // Handle DataLoader batch shape records
          if (record.kind === 'dataloader_batch') {
            const dl = record as DataloaderBatchRecord;
            if (!dataloaderIndex.has(dl.file)) {
              dataloaderIndex.set(dl.file, new Map());
            }
            const lineMap = dataloaderIndex.get(dl.file)!;
            const existing = lineMap.get(dl.line);
            if (!existing || dl.timestamp > existing.timestamp) {
              lineMap.set(dl.line, dl);
            }
            continue;
          }

          // Handle attention statistics records
          if (record.kind === 'attention_stats') {
            const at = record as AttentionStatsRecord;
            if (!attentionIndex.has(at.file)) {
              attentionIndex.set(at.file, new Map());
            }
            const lineMap = attentionIndex.get(at.file)!;
            const existing = lineMap.get(at.line);
            if (!existing || at.timestamp > existing.timestamp) {
              lineMap.set(at.line, at);
            }
            continue;
          }

          // Handle loss probe records
          if (record.kind === 'loss_probe') {
            const lp = record as LossProbeRecord;
            if (!lossProbeIndex.has(lp.file)) {
              lossProbeIndex.set(lp.file, new Map());
            }
            const lineMap = lossProbeIndex.get(lp.file)!;
            const existing = lineMap.get(lp.line);
            if (!existing || lp.timestamp > existing.timestamp) {
              lineMap.set(lp.line, lp);
            }
            continue;
          }

          // Handle activation statistics records
          if (record.kind === 'activation_stats') {
            const ac = record as ActivationStatsRecord;
            if (!activationIndex.has(ac.file)) {
              activationIndex.set(ac.file, new Map());
            }
            const lineMap = activationIndex.get(ac.file)!;
            const existing = lineMap.get(ac.line);
            if (!existing || ac.timestamp > existing.timestamp) {
              lineMap.set(ac.line, ac);
            }
            continue;
          }

          // Handle React hook invocation records
          if (record.kind === 'react_hook') {
            const rh = record as ReactHookRecord;
            if (!reactHookIndex.has(rh.file)) {
              reactHookIndex.set(rh.file, new Map());
            }
            const lineMap = reactHookIndex.get(rh.file)!;
            const existing = lineMap.get(rh.line);
            if (!existing || rh.invokeCount > existing.invokeCount) {
              lineMap.set(rh.line, rh);
            }
            continue;
          }

          // Handle React useState update records
          if (record.kind === 'react_state') {
            const rs = record as ReactStateRecord;
            if (!reactStateIndex.has(rs.file)) {
              reactStateIndex.set(rs.file, new Map());
            }
            const lineMap = reactStateIndex.get(rs.file)!;
            const existing = lineMap.get(rs.line);
            if (!existing || rs.updateCount > existing.updateCount) {
              lineMap.set(rs.line, rs);
            }
            continue;
          }

          // Handle React render records
          if (record.kind === 'react_render') {
            const rr = record as ReactRenderRecord;
            if (!reactRenderIndex.has(rr.file)) {
              reactRenderIndex.set(rr.file, new Map());
            }
            const lineMap = reactRenderIndex.get(rr.file)!;
            const existing = lineMap.get(rr.line);
            if (!existing || rr.renderCount > existing.renderCount) {
              lineMap.set(rr.line, rr);
            }
            continue;
          }

          // Handle training throughput records
          if (record.kind === 'training_throughput') {
            const tp = record as TrainingThroughputRecord;
            if (!throughputIndex.has(tp.file)) {
              throughputIndex.set(tp.file, new Map());
            }
            const lineMap = throughputIndex.get(tp.file)!;
            const existing = lineMap.get(tp.line);
            if (!existing || tp.timestamp > existing.timestamp) {
              lineMap.set(tp.line, tp);
            }
            continue;
          }

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
            const callStr = fo.callFlow ? ` ← ${fo.callFlow.callee}(${fo.callFlow.calleeClass || ''})` : '';
            flowLines.push(`  L${fo.line}: \`${shape}\`${stats}${callStr}${marker}`);
          }
          parts.push(flowLines.join('\n\n'));
          if (obs.callFlow) {
            parts.push(formatCallFlow(obs.callFlow, obs.type, labels));
          }
        } else {
          parts.push(`**\`${obs.varName}\`** (line ${obs.line}${funcCtx}): \`${typeStr}\``);
          const stats = formatTensorStats(obs.type);
          if (stats) parts.push(stats);
          if (obs.callFlow) {
            parts.push(formatCallFlow(obs.callFlow, obs.type, labels));
          }
        }
      } else if (className === 'Tensor' || className === 'ndarray') {
        parts.push(`**\`${obs.varName}\`** (line ${obs.line}${funcCtx}): \`${typeStr}\``);
        const stats = formatTensorStats(obs.type);
        if (stats) parts.push(stats);
        if (obs.callFlow) {
          parts.push(formatCallFlow(obs.callFlow, obs.type, labels));
        }
      } else {
        parts.push(`**\`${obs.varName}\`** (line ${obs.line}${funcCtx}): \`${typeStr}\``);
        if (obs.callFlow) {
          parts.push(formatCallFlow(obs.callFlow, obs.type, labels));
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
        const fullTypeStr = typeNodeToString(obs.type, 3, obsLabels);
        let typeStr = typeNodeToStringCompact(obs.type, obsLabels, obs.sample);

        // For primitive types, show actual value inline instead of just "number"/"integer"
        if (obs.type.kind === 'primitive' && obs.sample !== undefined && obs.sample !== null) {
          if (obs.type.name === 'number' && typeof obs.sample === 'number') {
            typeStr = Number.isInteger(obs.sample) ? String(obs.sample) : obs.sample.toFixed(4);
          } else if (obs.type.name === 'integer' && typeof obs.sample === 'number') {
            typeStr = String(obs.sample);
          } else if (obs.type.name === 'boolean' && typeof obs.sample === 'boolean') {
            typeStr = obs.sample ? 'True' : 'False';
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
            const prettyType = typeNodeToPretty(obs.type, 0, obsLabels);
            tooltipParts.push(`**Type:**\n\`\`\`typescript\n${prettyType}\n\`\`\``);
          } else {
            tooltipParts.push(`**Type:** \`${fullTypeStr}\``);
          }
        } else if (obs.type && isComplexType(obs.type)) {
          // Even when not compacted, show pretty-printed hover for complex types
          const prettyType = typeNodeToPretty(obs.type, 0, obsLabels);
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
          tooltipParts.push(formatCallFlow(obs.callFlow, obs.type, obsLabels));
        }
        if (config.get('showSampleValues', true) && obs.sample !== undefined) {
          tooltipParts.push(`**Sample value:**\n\`\`\`json\n${formatSample(obs.sample)}\n\`\`\``);
        }
        if (tooltipParts.length > 0) {
          hint.tooltip = new vscode.MarkdownString(tooltipParts.join('\n\n'));
        }

        hints.push(hint);
      }
    }

    // Add LR schedule inlay hints at scheduler.step() lines
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const lrLines = lrScheduleIndex.get(filePath);
      if (lrLines) {
        for (const [lineNo, lr] of lrLines) {
          if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;

          // Format LRs: single value or array
          const lrStr = lr.lrs.length === 1
            ? lr.lrs[0].toExponential(3)
            : `[${lr.lrs.map(v => v.toExponential(2)).join(', ')}]`;

          // Add context (epoch/step) if available
          const ctxParts: string[] = [];
          for (const key of ['epoch', 'step', 'global_step', 'iteration']) {
            if (key in lr.context) {
              ctxParts.push(`${key}=${lr.context[key]}`);
              if (ctxParts.length >= 2) break;
            }
          }
          const ctxStr = ctxParts.length > 0 ? ` | ${ctxParts.join(' | ')}` : '';
          const label = ` 📈 lr=${lrStr}${ctxStr}`;

          try {
            const line = document.lineAt(lineNo - 1);
            const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;

            const allCtx = Object.entries(lr.context).map(([k, v]) => `**${k}**: ${v}`).join(' · ');
            const md = new vscode.MarkdownString(
              `### 📈 Learning Rate: \`${lr.scheduler_class}\`\n\n` +
              `Current LR: \`${lrStr}\`\n\n` +
              (lr.lrs.length > 1 ? `Param groups: ${lr.lrs.map((v, i) => `group ${i}: \`${v.toExponential(3)}\``).join(', ')}\n\n` : '') +
              (allCtx ? `Context: ${allCtx}\n\n` : '') +
              `Step: ${lr.step_num}`,
            );
            md.isTrusted = true;
            hint.tooltip = md;
            hints.push(hint);
          } catch {
            // Skip if line out of range
          }
        }
      }
    }

    // Add checkpoint inlay hints at torch.save / save_pretrained lines
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const ckptLines = checkpointIndex.get(filePath);
      if (ckptLines) {
        for (const [lineNo, saves] of ckptLines) {
          if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;
          if (saves.length === 0) continue;

          // Show info from the most recent save at this line
          const latest = saves[saves.length - 1];
          const total = latest.save_count;
          const basename = latest.path.split('/').pop() || latest.path;

          // Build metrics string from the most recent save
          const PRIORITY_KEYS = ['epoch', 'step', 'loss', 'val_loss', 'acc', 'lr'];
          const metricParts: string[] = [];
          for (const key of PRIORITY_KEYS) {
            if (key in latest.metrics) {
              const v = latest.metrics[key];
              metricParts.push(`${key}=${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : v}`);
            }
          }
          // Add any remaining metrics not in the priority list
          for (const [k, v] of Object.entries(latest.metrics)) {
            if (!PRIORITY_KEYS.includes(k) && metricParts.length < 5) {
              metricParts.push(`${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(4)) : v}`);
            }
          }

          const metricsStr = metricParts.length > 0 ? ` | ${metricParts.join(' | ')}` : '';
          const countStr = total > 1 ? ` (×${total})` : '';
          const label = ` 💾 ${basename}${metricsStr}${countStr}`;

          try {
            const line = document.lineAt(lineNo - 1);
            const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;

            // Tooltip with history of all saves at this line
            const historyRows = saves.map((s, i) => {
              const mStr = Object.entries(s.metrics).map(([k, v]) => `${k}=${v}`).join(', ');
              const d = new Date(s.timestamp * 1000).toLocaleTimeString();
              return `${i + 1}. \`${s.path.split('/').pop()}\` — ${mStr || 'no metrics'} @ ${d}`;
            });
            const md = new vscode.MarkdownString(
              `### 💾 Checkpoint Saves\n\n${historyRows.join('\n\n')}`,
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

    // Add gradient flow inlay hints at the loss.backward() call line
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const gradLines = gradientIndex.get(filePath);
      if (gradLines) {
        for (const [lineNo, gr] of gradLines) {
          if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;
          if (gr.layers.length === 0) continue;

          // Build compact label showing gradient health
          const parts: string[] = [];

          if (gr.exploding.length > 0) {
            parts.push(`⚡ exploding: ${gr.exploding.slice(0, 2).join(', ')}`);
          }
          if (gr.vanishing.length > 0) {
            parts.push(`↓ vanishing: ${gr.vanishing.slice(0, 2).join(', ')}`);
          }
          if (parts.length === 0) {
            // All healthy — show top 3 layer norms
            const top = gr.layers.slice(0, 3).map(l => `${l.name}=${l.norm.toExponential(2)}`);
            parts.push(`${gr.num_layers} layers | ${top.join(' | ')}`);
          }

          const label = ` ∇ ${gr.model_var}: ${parts.join(' | ')}`;

          try {
            const line = document.lineAt(lineNo - 1);
            const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;

            // Tooltip with full per-layer breakdown
            const layerRows = gr.layers.map(l => {
              const flag = l.exploding ? ' ⚡' : l.vanishing ? ' ↓' : '';
              return `| \`${l.name}\` | \`${l.norm.toExponential(3)}\`${flag} |`;
            });
            const md = new vscode.MarkdownString(
              `### ∇ Gradient Norms: \`${gr.model_var}\`\n\n` +
              `| Layer | Grad Norm |\n|---|---|\n${layerRows.join('\n')}\n\n` +
              `max: \`${gr.max_norm.toExponential(3)}\` · min: \`${gr.min_norm.toExponential(3)}\`\n\n` +
              (gr.exploding.length > 0 ? `⚡ **Exploding** (>${_EXPLODING_THRESHOLD}): ${gr.exploding.join(', ')}\n\n` : '') +
              (gr.vanishing.length > 0 ? `↓ **Vanishing** (<${_VANISHING_THRESHOLD}): ${gr.vanishing.join(', ')}` : ''),
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

    // Add optimizer step inlay hints at optimizer.step() lines
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const optLines = optimizerIndex.get(filePath);
      if (optLines) {
        for (const [lineNo, op] of optLines) {
          if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;

          // Build compact label
          const gradStr = op.grad_norm.toExponential(3);
          const healthIcon = op.exploding ? '⚡' : op.vanishing ? '↓' : '⚙';

          const parts: string[] = [`grad=${gradStr}`];
          if (op.update_norm > 0) {
            parts.push(`Δθ=${op.update_norm.toExponential(3)}`);
          }
          if (op.param_stats.length > 0) {
            const s = op.param_stats[0];
            parts.push(`σ=${s.param_std.toExponential(2)}`);
          }
          const label = ` ${healthIcon} ${parts.join(' | ')}`;

          try {
            const line = document.lineAt(lineNo - 1);
            const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;

            // Build detailed tooltip
            const groupRows = op.param_stats.map((s, i) =>
              `| group ${i} | lr=\`${s.lr}\` | norm=\`${s.param_norm.toFixed(4)}\` | μ=\`${s.param_mean.toFixed(4)}\` | σ=\`${s.param_std.toFixed(4)}\` | params=\`${s.n_params.toLocaleString()}\` |`,
            ).join('\n');

            const ctxStr = Object.entries(op.context).map(([k, v]) => `**${k}**: ${v}`).join(' · ');

            const md = new vscode.MarkdownString(
              `### ${op.exploding ? '⚡' : op.vanishing ? '↓' : '⚙'} Optimizer: \`${op.optimizer_class}\`\n\n` +
              `**Gradient norm:** \`${op.grad_norm.toExponential(4)}\`` +
              (op.exploding ? ' — ⚡ **EXPLODING**' : op.vanishing ? ' — ↓ **VANISHING**' : '') + '\n\n' +
              (op.update_norm > 0 ? `**Weight update:** \`||Δθ|| = ${op.update_norm.toExponential(4)}\`\n\n` : '') +
              (groupRows ? `**Parameter groups:**\n\n| Group | LR | Norm | Mean | Std | #Params |\n|---|---|---|---|---|---|\n${groupRows}\n\n` : '') +
              (ctxStr ? `**Context:** ${ctxStr}\n\n` : '') +
              `Step #${op.step_num}`,
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

    // Add DataLoader batch shape inlay hints at for-loop lines
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const dlLines = dataloaderIndex.get(filePath);
      if (dlLines) {
        for (const [lineNo, dl] of dlLines) {
          if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;
          if (dl.shapes.length === 0) continue;

          // Format shapes compactly
          const isDict = dl.shapes.some(s => s.key !== undefined);
          let shapeStr: string;

          if (isDict) {
            // Dict batch: {input_ids[32,512] int64, attention_mask[32,512]}
            const parts = dl.shapes.map(s => {
              const shapeRepr = s.shape ? `[${s.shape.join(',')}]` : '';
              const dtypeRepr = s.dtype ? ` ${s.dtype.replace('torch.', '')}` : '';
              return `${s.key}${shapeRepr}${dtypeRepr}`;
            });
            shapeStr = `{${parts.join(', ')}}`;
          } else {
            // Tuple/list/single tensor batch: [32,3,224,224] float32, [32] int64
            const parts = dl.shapes.map(s => {
              const shapeRepr = s.shape ? `[${s.shape.join(',')}]` : '';
              const dtypeRepr = s.dtype ? ` ${s.dtype.replace('torch.', '')}` : '';
              return `${shapeRepr}${dtypeRepr}`;
            });
            shapeStr = parts.join(', ');
          }

          const label = ` ⬛ ${shapeStr}`;

          try {
            const line = document.lineAt(lineNo - 1);
            const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;

            // Tooltip with full shape breakdown
            const shapeRows = dl.shapes.map(s => {
              const nameStr = s.key !== undefined ? `\`${s.key}\`` : `item ${s.index ?? 0}`;
              const shapeRepr = s.shape ? `\`[${s.shape.join(', ')}]\`` : 'n/a';
              const dtypeStr = s.dtype ? ` · \`${s.dtype}\`` : '';
              return `${nameStr}: ${shapeRepr}${dtypeStr}`;
            });
            const md = new vscode.MarkdownString(
              `### ⬛ DataLoader Batch Shapes\n\n` +
              shapeRows.join('\n\n') +
              `\n\n*Batch #${dl.batch_num} captured by trickle*`,
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

    // Add training throughput inlay hints at DataLoader for-loop lines
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const tpLines = throughputIndex.get(filePath);
      if (tpLines) {
        for (const [lineNo, tp] of tpLines) {
          if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;

          // Format samples/sec compactly: 1234 → "1.23k", 45678 → "45.7k"
          const fmtRate = (n: number): string => {
            if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 1 : 2)}k`;
            return n.toFixed(1);
          };

          const fmtEta = (s: number): string => {
            const h = Math.floor(s / 3600);
            const m = Math.floor((s % 3600) / 60);
            const sec = Math.floor(s % 60);
            if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
            return `${m}:${String(sec).padStart(2, '0')}`;
          };

          let label = ` ⚡ ${fmtRate(tp.samples_per_sec)} smp/s`;
          if (tp.eta_seconds !== undefined) {
            label += ` | ETA ${fmtEta(tp.eta_seconds)}`;
          }
          if (tp.total_batches !== undefined) {
            const pct = Math.round((tp.batch_count / tp.total_batches) * 100);
            label += ` (${pct}%)`;
          }

          try {
            const line = document.lineAt(lineNo - 1);
            const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;

            const tooltipLines = [
              `**Samples/sec:** \`${tp.samples_per_sec.toFixed(1)}\``,
              `**Batches/sec:** \`${tp.batches_per_sec.toFixed(3)}\``,
              `**Batch size:** \`${tp.batch_size}\``,
              `**Batches done:** \`${tp.batch_count}${tp.total_batches ? ' / ' + tp.total_batches : ''}\``,
            ];
            if (tp.eta_seconds !== undefined) {
              tooltipLines.push(`**ETA:** \`${fmtEta(tp.eta_seconds)}\``);
            }
            const md = new vscode.MarkdownString(
              `### ⚡ Training Throughput\n\n` + tooltipLines.join('\n\n') +
              `\n\n*Tracked by trickle (rolling avg)*`,
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

    // Add attention statistics inlay hints at F.softmax / attention call lines
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const atLines = attentionIndex.get(filePath);
      if (atLines) {
        for (const [lineNo, at] of atLines) {
          if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;

          const entropyPct = at.max_entropy > 0
            ? Math.round((at.mean_entropy / at.max_entropy) * 100)
            : 0;

          let label = ` 🎯 H=${at.mean_entropy.toFixed(2)}/${at.max_entropy.toFixed(2)}`;
          if (at.sharp_heads > 0) label += ` | sharp:${at.sharp_heads}`;
          if (at.dead_heads > 0) label += ` | dead:${at.dead_heads}`;

          try {
            const line = document.lineAt(lineNo - 1);
            const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;

            // Per-head entropy breakdown
            const headRows = at.head_entropies.map((h, i) => {
              const pct = Math.round((h / at.max_entropy) * 100);
              const flag = h > 0.95 * at.max_entropy ? ' 💤 dead'
                : h < 0.10 * at.max_entropy ? ' ⚡ sharp' : '';
              return `head ${i}: \`${h.toFixed(3)}\` (${pct}%${flag})`;
            });

            const tooltipLines = [
              `**Heads:** \`${at.n_heads}\` · **Seq len:** \`${at.seq_len}\``,
              `**Mean entropy:** \`${at.mean_entropy.toFixed(4)}\` / \`${at.max_entropy.toFixed(4)}\` (${entropyPct}% of max)`,
              `**Sharp heads** (< 10% entropy): \`${at.sharp_heads}\``,
              `**Dead heads** (> 95% entropy): \`${at.dead_heads}\``,
              `**Mean max-attended position:** \`${at.mean_max_pos.toFixed(1)}\``,
              `**Diagonal attention (self):** \`${(at.diag_attn * 100).toFixed(1)}%\``,
              `\n**Per-head entropy:**\n${headRows.join('\n')}`,
              `\n*Sampled at call #${at.call_count} by trickle*`,
            ];
            const md = new vscode.MarkdownString(
              `### 🎯 Attention Pattern Stats\n\n` + tooltipLines.join('\n\n'),
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

    // Add loss probe inlay hints at loss.backward() call lines
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const lpLines = lossProbeIndex.get(filePath);
      if (lpLines) {
        for (const [lineNo, lp] of lpLines) {
          if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;

          const patternIcon: Record<string, string> = {
            decreasing: '↘', increasing: '↗', plateau: '—',
            oscillating: '〰', diverging: '⚠', stable: '→', unknown: '?',
          };
          const patternTip: Record<string, string> = {
            plateau: 'try raising LR or check gradient vanishing',
            oscillating: 'try lowering LR or add gradient clipping',
            increasing: 'check LR, data, or possible bug',
            diverging: 'NaN/Inf detected — lower LR or add gradient clipping',
            decreasing: 'training healthy',
            stable: '', unknown: '',
          };

          const icon = patternIcon[lp.pattern] ?? '?';
          const fmtLoss = (v: number): string => {
            if (!isFinite(v)) return String(v);
            if (Math.abs(v) >= 100) return v.toFixed(1);
            if (Math.abs(v) >= 10) return v.toFixed(2);
            return v.toFixed(4);
          };
          const deltaStr = lp.loss_delta !== 0
            ? ` Δ=${lp.loss_delta >= 0 ? '+' : ''}${lp.loss_delta.toFixed(4)}/step`
            : '';
          const patternNote = ['plateau', 'oscillating', 'increasing', 'diverging'].includes(lp.pattern)
            ? ` [${lp.pattern}]` : '';

          let label = ` ${icon} loss=${fmtLoss(lp.loss)}${deltaStr}${patternNote}`;

          try {
            const line = document.lineAt(lineNo - 1);
            const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;

            const tip = patternTip[lp.pattern] ?? '';
            const tooltipLines = [
              `**Pattern:** \`${lp.pattern}\`${tip ? '  —  ' + tip : ''}`,
              `**Current loss:** \`${lp.loss}\``,
              `**Moving avg:** \`${lp.loss_avg}\``,
              `**Std (window):** \`${lp.loss_std}\``,
              `**Δ/step:** \`${lp.loss_delta >= 0 ? '+' : ''}${lp.loss_delta}\``,
              `**Step:** \`${lp.step}\``,
            ];
            const md = new vscode.MarkdownString(
              `### ${icon} Loss Landscape\n\n` + tooltipLines.join('\n\n') +
              `\n\n*Tracked by trickle (20-step rolling window)*`,
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

    // Add activation statistics inlay hints at nn.Module forward call lines
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const actLines = activationIndex.get(filePath);
      if (actLines) {
        for (const [lineNo, ac] of actLines) {
          if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;

          // Format a compact stats label
          const fmtNum = (n: number): string => {
            const a = Math.abs(n);
            if (a >= 100) return n.toFixed(1);
            if (a >= 10) return n.toFixed(2);
            if (a >= 1) return n.toFixed(3);
            return n.toFixed(4);
          };

          let label = ` ◆ μ=${fmtNum(ac.mean)} σ=${fmtNum(ac.std)}`;

          // Anomaly flags
          if (ac.exploding) {
            label = ` ⚡◆ μ=${fmtNum(ac.mean)} σ=${fmtNum(ac.std)} [explode]`;
          } else if (ac.vanishing) {
            label = ` ↓◆ μ=${fmtNum(ac.mean)} σ=${fmtNum(ac.std)} [vanish]`;
          } else if (ac.zero_frac !== undefined && ac.zero_frac > 0.5) {
            label += ` [dead:${Math.round(ac.zero_frac * 100)}%]`;
          } else if (ac.sat_frac !== undefined && ac.sat_frac > 0.5) {
            label += ` [sat:${Math.round(ac.sat_frac * 100)}%]`;
          }

          try {
            const line = document.lineAt(lineNo - 1);
            const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;

            const tooltipLines = [
              `**Module:** \`${ac.module_name}\``,
              `**Shape:** \`[${ac.shape.join(', ')}]\``,
              `**Mean:** \`${ac.mean}\``,
              `**Std:** \`${ac.std}\``,
              `**Min:** \`${ac.min}\` · **Max:** \`${ac.max}\``,
            ];
            if (ac.zero_frac !== undefined && ac.zero_frac > 0) {
              tooltipLines.push(`**Zero fraction:** \`${(ac.zero_frac * 100).toFixed(1)}%\` ${ac.zero_frac > 0.5 ? '⚠ dead neurons detected' : ''}`);
            }
            if (ac.sat_frac !== undefined) {
              tooltipLines.push(`**Saturation (|x|>0.9):** \`${(ac.sat_frac * 100).toFixed(1)}%\` ${ac.sat_frac > 0.5 ? '⚠ saturated' : ''}`);
            }
            if (ac.vanishing) tooltipLines.push('⚠ **Vanishing activations** (std < 1e-5)');
            if (ac.exploding) tooltipLines.push('⚠ **Exploding activations** (|max| > 1e3)');
            tooltipLines.push(`*Sampled at call #${ac.call_count} by trickle*`);

            const md = new vscode.MarkdownString(
              `### ◆ Activation Stats\n\n` + tooltipLines.join('\n\n'),
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

    // Add React hook invocation count inlay hints
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const rhLines = reactHookIndex.get(filePath);
      if (rhLines) {
        for (const [lineNo, rh] of rhLines) {
          if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;

          const hookIcon: Record<string, string> = {
            useEffect: '⚡',
            useMemo: '💾',
            useCallback: '🎯',
          };
          const hookVerb: Record<string, string> = {
            useEffect: 'ran',
            useMemo: 'computed',
            useCallback: 'called',
          };
          const icon = hookIcon[rh.hookName] ?? '🪝';
          const verb = hookVerb[rh.hookName] ?? 'invoked';
          const label = ` ${icon} ${verb} ×${rh.invokeCount}`;

          try {
            const line = document.lineAt(lineNo - 1);
            const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;

            const tipByHook: Record<string, string> = {
              useEffect: 'Each invocation = effect ran (deps changed or first mount)',
              useMemo: 'Each invocation = cache miss (expensive value recomputed)',
              useCallback: 'Each invocation = callback was actually called by user code',
            };
            const md = new vscode.MarkdownString(
              `### ${icon} \`${rh.hookName}\` Hook Invocations\n\n` +
              `**${verb.charAt(0).toUpperCase() + verb.slice(1)}:** \`${rh.invokeCount}×\`\n\n` +
              `${tipByHook[rh.hookName] ?? ''}\n\n` +
              `*Tracked by trickle (cumulative since dev server start)*`,
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

    // Add React useState update count inlay hints
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const rsLines = reactStateIndex.get(filePath);
      if (rsLines) {
        for (const [lineNo, rs] of rsLines) {
          if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;

          // Format value for display
          const valDisplay = rs.value === null ? 'null'
            : rs.value === undefined ? 'undefined'
            : typeof rs.value === 'string' ? `"${(rs.value as string).length > 15 ? (rs.value as string).slice(0, 15) + '…' : rs.value}"`
            : String(rs.value);
          const label = ` 📊 ×${rs.updateCount} → ${valDisplay}`;

          try {
            const line = document.lineAt(lineNo - 1);
            const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;

            const md = new vscode.MarkdownString(
              `### 📊 \`${rs.stateName}\` State Updates\n\n` +
              `**Updated:** \`${rs.updateCount}×\`\n\n` +
              `**Latest value:** \`${valDisplay}\`\n\n` +
              `*Tracked by trickle — each invocation of the setter is counted*`,
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

    // Add React component render count inlay hints
    if (document.uri.scheme === 'file') {
      const filePath = document.uri.fsPath;
      const rrLines = reactRenderIndex.get(filePath);
      if (rrLines) {
        for (const [lineNo, rr] of rrLines) {
          if (lineNo - 1 < range.start.line || lineNo - 1 > range.end.line) continue;

          // Build compact prop summary for label: prefer showing changed props
          let propSummary = '';
          if (rr.changedProps && rr.changedProps.length > 0) {
            // Show which props caused re-render with old→new for primitives
            const MAX_CHANGED = 3;
            const shown = rr.changedProps.slice(0, MAX_CHANGED).map(cp => {
              const { key: k, from, to } = cp;
              const isPrim = (v: unknown) => typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string';
              if (isPrim(from) && isPrim(to) && String(from).length + String(to).length < 20) {
                return `${k}: ${from}→${to}`;
              }
              return `↑${k}`;
            });
            propSummary = ` | ${shown.join(' ')}`;
            if (rr.changedProps.length > MAX_CHANGED) propSummary += ` +${rr.changedProps.length - MAX_CHANGED}`;
          } else if (rr.props && rr.propKeys && rr.propKeys.length > 0) {
            const MAX_PROPS = 3;
            const shown = rr.propKeys.slice(0, MAX_PROPS).map(k => {
              const v = rr.props![k];
              if (typeof v === 'string') return `${k}="${v.length > 12 ? v.slice(0, 12) + '…' : v}"`;
              if (typeof v === 'number' || typeof v === 'boolean') return `${k}=${v}`;
              if (v === null || v === undefined) return `${k}=${v}`;
              return `${k}=…`;
            });
            propSummary = ` | ${shown.join(' ')}`;
            if (rr.propKeys.length > MAX_PROPS) propSummary += ` +${rr.propKeys.length - MAX_PROPS}`;
          }
          const label = ` 🔄 ×${rr.renderCount}${propSummary}`;

          try {
            const line = document.lineAt(lineNo - 1);
            const position = new vscode.Position(lineNo - 1, line.text.trimEnd().length);
            const hint = new vscode.InlayHint(position, label, vscode.InlayHintKind.Parameter);
            hint.paddingLeft = true;

            const tooltipLines = [
              `**Component:** \`${rr.component}\``,
              `**Render count:** \`${rr.renderCount}\``,
            ];
            if (rr.changedProps && rr.changedProps.length > 0) {
              const changedRows = rr.changedProps.map(cp => {
                const fromStr = typeof cp.from === 'string' ? `"${cp.from}"` : String(cp.from);
                const toStr = typeof cp.to === 'string' ? `"${cp.to}"` : String(cp.to);
                return `- **\`${cp.key}\`**: \`${fromStr}\` → \`${toStr}\``;
              });
              tooltipLines.push(`**Changed props (last re-render):**\n${changedRows.join('\n')}`);
            }
            if (rr.props && rr.propKeys && rr.propKeys.length > 0) {
              const propRows = rr.propKeys.map(k => {
                const v = rr.props![k];
                const display = typeof v === 'string' ? `"${v}"` : String(v);
                return `- **\`${k}\`**: \`${display}\``;
              });
              tooltipLines.push(`**Props (current):**\n${propRows.join('\n')}`);
            }
            tooltipLines.push('*Tracked by trickle (cumulative since dev server start)*');

            const md = new vscode.MarkdownString(
              `### 🔄 React Component Renders\n\n` + tooltipLines.join('\n\n'),
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

    case 'union':
      if (node.elements) {
        return node.elements.map(e => typeNodeToString(e, 3, dimLabels)).join(' | ');
      }
      return 'unknown';

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
  if (node.kind !== 'object' || !node.properties) return false;
  const entries = Object.entries(node.properties);
  if (entries.length > 4) return true;
  return entries.some(([, v]) => v.kind === 'object' && v.properties && Object.keys(v.properties).length > 0);
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
