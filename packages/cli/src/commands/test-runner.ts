/**
 * trickle test — smart test runner with runtime observability.
 *
 * Runs tests with trickle instrumentation, parses results into structured
 * JSON, and augments failures with runtime context (variable values, queries,
 * call traces, errors). Designed for AI agent consumption.
 *
 * Supports: jest, vitest, pytest, mocha, node --test
 *
 * Usage:
 *   trickle test                     # auto-detect test command
 *   trickle test "npm test"          # run specific command
 *   trickle test --json              # structured JSON output
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { execSync, spawnSync } from 'child_process';

export interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'error';
  durationMs?: number;
  error?: {
    message: string;
    stack?: string;
    expected?: string;
    actual?: string;
  };
  file?: string;
  line?: number;
}

export interface TestSuite {
  name: string;
  file?: string;
  tests: TestResult[];
  passed: number;
  failed: number;
  skipped: number;
}

export interface TestReport {
  timestamp: string;
  command: string;
  framework: string;
  exitCode: number;
  duration: number;

  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    suites: number;
  };

  failures: Array<{
    test: string;
    suite?: string;
    file?: string;
    error: {
      message: string;
      stack?: string;
    };
    runtimeContext?: {
      variablesNearFailure?: Array<{ name: string; value: unknown; type: string; file: string; line: number }>;
      queriesDuringTest?: Array<{ query: string; durationMs: number; driver?: string }>;
      errorContext?: Array<{ message: string; stack?: string; file?: string; line?: number }>;
      relevantCallTrace?: Array<{ function: string; module: string; durationMs?: number }>;
    };
  }>;

  suites: TestSuite[];

  observability?: {
    functionsObserved: number;
    queriesCaptured: number;
    errorsDetected: number;
    logsCaptured: number;
    alerts: Array<{ severity: string; category: string; message: string; suggestion?: string }>;
  };
}

export interface TestOptions {
  json?: boolean;
  command?: string;
}

// ── Framework detection ──

interface DetectedFramework {
  name: string;
  command: string;
  jsonFlag?: string;
}

function detectTestFramework(): DetectedFramework | null {
  const pkgPath = path.join(process.cwd(), 'package.json');

  // Check package.json for JS/TS projects
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Check for test script first
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        // Detect framework from test script
        const testScript = pkg.scripts.test;
        if (testScript.includes('vitest')) return { name: 'vitest', command: 'npx vitest run', jsonFlag: '--reporter=json' };
        if (testScript.includes('jest')) return { name: 'jest', command: 'npx jest', jsonFlag: '--json' };
        if (testScript.includes('mocha')) return { name: 'mocha', command: 'npx mocha', jsonFlag: '--reporter=json' };
        if (testScript.includes('pytest')) return { name: 'pytest', command: 'python -m pytest', jsonFlag: '--tb=short -q' };
        // Generic npm test
        return { name: 'npm', command: 'npm test' };
      }

      // Check devDependencies
      if (deps.vitest) return { name: 'vitest', command: 'npx vitest run', jsonFlag: '--reporter=json' };
      if (deps.jest) return { name: 'jest', command: 'npx jest', jsonFlag: '--json' };
      if (deps.mocha) return { name: 'mocha', command: 'npx mocha', jsonFlag: '--reporter=json' };
    } catch {}
  }

  // Check for Python test frameworks
  if (fs.existsSync(path.join(process.cwd(), 'pytest.ini')) ||
      fs.existsSync(path.join(process.cwd(), 'pyproject.toml')) ||
      fs.existsSync(path.join(process.cwd(), 'setup.cfg'))) {
    // Check if pytest is available
    try {
      execSync('python -m pytest --version', { stdio: 'ignore' });
      return { name: 'pytest', command: 'python -m pytest', jsonFlag: '--tb=short -q' };
    } catch {}
  }

  // Check for test directories
  if (fs.existsSync(path.join(process.cwd(), 'tests')) ||
      fs.existsSync(path.join(process.cwd(), 'test'))) {
    // Check Python first
    try {
      execSync('python -m pytest --version', { stdio: 'ignore' });
      return { name: 'pytest', command: 'python -m pytest', jsonFlag: '--tb=short -q' };
    } catch {}
    // Check Node
    try {
      execSync('npx jest --version', { stdio: 'ignore' });
      return { name: 'jest', command: 'npx jest', jsonFlag: '--json' };
    } catch {}
  }

  return null;
}

function detectFrameworkFromCommand(command: string): string {
  if (command.includes('vitest')) return 'vitest';
  if (command.includes('jest')) return 'jest';
  if (command.includes('mocha')) return 'mocha';
  if (command.includes('pytest') || command.includes('python -m pytest')) return 'pytest';
  if (command.includes('manage.py test')) return 'django';
  if (command.includes('node --test')) return 'node-test';
  if (command.includes('npm test')) return 'npm';
  return 'unknown';
}

// ── Output parsing ──

function parseJestJson(output: string): { suites: TestSuite[]; summary: TestReport['summary'] } | null {
  try {
    // Jest JSON output may have non-JSON lines before it
    const jsonStart = output.indexOf('{"');
    if (jsonStart === -1) return null;
    const json = JSON.parse(output.substring(jsonStart));

    const suites: TestSuite[] = (json.testResults || []).map((suite: any) => {
      const tests = (suite.assertionResults || []).map((t: any) => ({
        name: t.fullName || t.title,
        status: (t.status === 'passed' ? 'passed' : t.status === 'pending' ? 'skipped' : 'failed') as TestResult['status'],
        durationMs: t.duration,
        error: t.status === 'failed' ? {
          message: (t.failureMessages || []).join('\n').substring(0, 500),
        } : undefined,
      }));

      // If suite failed but has no test results (compile/import error), add a synthetic failure
      if (suite.status === 'failed' && tests.length === 0 && suite.message) {
        tests.push({
          name: 'Suite failed to load',
          status: 'error' as TestResult['status'],
          durationMs: undefined,
          error: { message: suite.message.substring(0, 500) },
        });
      }

      const suiteName = suite.name ? path.relative(process.cwd(), suite.name) : 'unknown';
      return {
        name: suiteName,
        file: suite.name ? path.relative(process.cwd(), suite.name) : undefined,
        tests,
        passed: tests.filter((t: any) => t.status === 'passed').length,
        failed: tests.filter((t: any) => t.status === 'failed' || t.status === 'error').length,
        skipped: tests.filter((t: any) => t.status === 'skipped').length,
      };
    });

    // Account for suite-level failures (e.g., compile errors, import failures)
    const failedSuites = (json.testResults || []).filter((s: any) => s.status === 'failed').length;
    const totalFailed = (json.numFailedTests || 0) + (json.numTotalTests === 0 && failedSuites > 0 ? failedSuites : 0);
    const totalTests = (json.numTotalTests || 0) + (json.numTotalTests === 0 && failedSuites > 0 ? failedSuites : 0);

    return {
      suites,
      summary: {
        total: totalTests,
        passed: json.numPassedTests || 0,
        failed: totalFailed,
        skipped: json.numPendingTests || 0,
        suites: json.numTotalTestSuites || suites.length,
      },
    };
  } catch {
    return null;
  }
}

function parseVitestJson(output: string): { suites: TestSuite[]; summary: TestReport['summary'] } | null {
  try {
    const jsonStart = output.indexOf('{"');
    if (jsonStart === -1) return null;
    const json = JSON.parse(output.substring(jsonStart));

    const suites: TestSuite[] = (json.testResults || []).map((suite: any) => ({
      name: suite.name ? path.relative(process.cwd(), suite.name) : 'unknown',
      file: suite.name ? path.relative(process.cwd(), suite.name) : undefined,
      tests: (suite.assertionResults || []).map((t: any) => ({
        name: t.fullName || t.title,
        status: t.status === 'passed' ? 'passed' : t.status === 'skipped' ? 'skipped' : 'failed',
        durationMs: t.duration,
        error: t.status === 'failed' ? {
          message: (t.failureMessages || []).join('\n').substring(0, 500),
        } : undefined,
      })),
      passed: (suite.assertionResults || []).filter((t: any) => t.status === 'passed').length,
      failed: (suite.assertionResults || []).filter((t: any) => t.status === 'failed').length,
      skipped: (suite.assertionResults || []).filter((t: any) => t.status === 'skipped').length,
    }));

    return {
      suites,
      summary: {
        total: json.numTotalTests || 0,
        passed: json.numPassedTests || 0,
        failed: json.numFailedTests || 0,
        skipped: json.numPendingTests || 0,
        suites: json.numTotalTestSuites || suites.length,
      },
    };
  } catch {
    return null;
  }
}

function parsePytestOutput(output: string): { suites: TestSuite[]; summary: TestReport['summary'] } | null {
  const tests: TestResult[] = [];

  // Parse individual test results: "test_file.py::test_name PASSED/FAILED"
  const testLineRe = /^(.+?::[\w:]+)\s+(PASSED|FAILED|SKIPPED|ERROR)/gm;
  let match;
  while ((match = testLineRe.exec(output)) !== null) {
    const fullName = match[1];
    const status = match[2].toLowerCase() as TestResult['status'];
    const parts = fullName.split('::');
    const file = parts[0];
    const name = parts.slice(1).join('::');

    tests.push({ name, status, file });
  }

  // Parse failure details
  const failureBlocks = output.split(/^={3,}\s*FAILURES\s*={3,}$/m);
  if (failureBlocks.length > 1) {
    const failureSection = failureBlocks[1].split(/^={3,}/m)[0];
    const failures = failureSection.split(/^_{3,}\s+(.+?)\s+_{3,}$/m);

    for (let i = 1; i < failures.length; i += 2) {
      const testName = failures[i];
      const detail = failures[i + 1] || '';
      const test = tests.find(t => t.name.includes(testName) || testName.includes(t.name));
      if (test) {
        // Extract assertion error
        const assertMatch = detail.match(/(?:AssertionError|assert)\s*(.+)/);
        const errorMatch = detail.match(/E\s+(.+)/m);
        test.error = {
          message: (assertMatch?.[1] || errorMatch?.[1] || detail).substring(0, 500),
          stack: detail.substring(0, 800),
        };
      }
    }
  }

  // Parse summary line: "X passed, Y failed, Z skipped"
  const summaryMatch = output.match(/(\d+) passed(?:.*?(\d+) failed)?(?:.*?(\d+) skipped)?/);
  const passed = tests.filter(t => t.status === 'passed').length || parseInt(summaryMatch?.[1] || '0');
  const failed = tests.filter(t => t.status === 'failed').length || parseInt(summaryMatch?.[2] || '0');
  const skipped = tests.filter(t => t.status === 'skipped').length || parseInt(summaryMatch?.[3] || '0');

  // Group by file
  const byFile = new Map<string, TestResult[]>();
  for (const t of tests) {
    const key = t.file || 'unknown';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(t);
  }

  const suites: TestSuite[] = Array.from(byFile.entries()).map(([file, fileTests]) => ({
    name: file,
    file,
    tests: fileTests,
    passed: fileTests.filter(t => t.status === 'passed').length,
    failed: fileTests.filter(t => t.status === 'failed').length,
    skipped: fileTests.filter(t => t.status === 'skipped').length,
  }));

  // If no individual tests parsed, create a minimal summary from the summary line
  if (tests.length === 0 && summaryMatch) {
    return {
      suites: [],
      summary: {
        total: passed + failed + skipped,
        passed,
        failed,
        skipped,
        suites: 0,
      },
    };
  }

  if (tests.length === 0) return null;

  return {
    suites,
    summary: {
      total: tests.length,
      passed,
      failed,
      skipped,
      suites: suites.length,
    },
  };
}

function parseGenericOutput(output: string, exitCode: number): { suites: TestSuite[]; summary: TestReport['summary'] } {
  // Try to extract any pass/fail counts from output
  const passMatch = output.match(/(\d+)\s+(?:passing|passed|pass)/i);
  const failMatch = output.match(/(\d+)\s+(?:failing|failed|fail)/i);
  const skipMatch = output.match(/(\d+)\s+(?:pending|skipped|skip)/i);

  let passed = parseInt(passMatch?.[1] || '0');
  let failed = parseInt(failMatch?.[1] || '0');
  let skipped = parseInt(skipMatch?.[1] || '0');

  // Python unittest format: "Ran N tests in Xs" + "OK" or "FAILED (failures=N, errors=N)"
  if (passed === 0 && failed === 0) {
    const ranMatch = output.match(/Ran\s+(\d+)\s+tests?\s+in/);
    if (ranMatch) {
      const total = parseInt(ranMatch[1]);
      const failedMatch = output.match(/FAILED\s*\((?:failures=(\d+))?(?:,?\s*errors=(\d+))?\)/);
      if (failedMatch) {
        const failures = parseInt(failedMatch[1] || '0');
        const errors = parseInt(failedMatch[2] || '0');
        failed = failures + errors;
        passed = total - failed;
      } else if (/\nOK\s*$/m.test(output) || /\nOK\n/.test(output)) {
        passed = total;
      }
    }
  }

  // Node.js built-in test runner: "# pass N" / "# fail N"
  if (passed === 0 && failed === 0) {
    const nodePass = output.match(/# pass\s+(\d+)/);
    const nodeFail = output.match(/# fail\s+(\d+)/);
    if (nodePass) passed = parseInt(nodePass[1]);
    if (nodeFail) failed = parseInt(nodeFail[1]);
  }

  const total = passed + failed + skipped || (exitCode === 0 ? 1 : 0);

  return {
    suites: [],
    summary: { total, passed, failed, skipped, suites: 0 },
  };
}

// ── Runtime context enrichment ──

function readJsonl(fp: string): any[] {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function compactType(node: any): string {
  if (!node) return 'unknown';
  switch (node.kind) {
    case 'primitive': return node.name || 'unknown';
    case 'object': {
      if (node.class_name) return node.class_name;
      if (!node.properties) return '{}';
      const props = Object.entries(node.properties).slice(0, 3)
        .map(([k, v]) => `${k}: ${compactType(v)}`);
      return `{ ${props.join(', ')}${Object.keys(node.properties).length > 3 ? ', ...' : ''} }`;
    }
    case 'array': return `${compactType(node.element)}[]`;
    default: return node.kind || 'unknown';
  }
}

function enrichFailureWithContext(
  failure: TestReport['failures'][0],
  trickleDir: string,
): void {
  const ctx: NonNullable<typeof failure.runtimeContext> = {};

  // Find errors near the failure
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl'));
  if (errors.length > 0) {
    ctx.errorContext = errors.slice(0, 5).map((e: any) => ({
      message: (e.message || e.error || String(e)).substring(0, 300),
      stack: e.stack?.substring(0, 500),
      file: e.file,
      line: e.line,
    }));
  }

  // Find variables near the failure file
  if (failure.file) {
    const variables = readJsonl(path.join(trickleDir, 'variables.jsonl'));
    const fileVars = variables.filter((v: any) => {
      if (!v.file) return false;
      const rel = path.relative(process.cwd(), v.file);
      return rel.includes(failure.file!) || v.file.includes(failure.file!);
    });
    if (fileVars.length > 0) {
      // Deduplicate by name+line
      const seen = new Set<string>();
      ctx.variablesNearFailure = fileVars
        .filter((v: any) => {
          const key = `${v.varName}:${v.line}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 10)
        .map((v: any) => ({
          name: v.varName,
          value: v.sample,
          type: compactType(v.type),
          file: path.relative(process.cwd(), v.file),
          line: v.line,
        }));
    }
  }

  // Find queries that ran during the test
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
  if (queries.length > 0) {
    ctx.queriesDuringTest = queries.slice(0, 10).map((q: any) => ({
      query: (q.query || '').substring(0, 200),
      durationMs: Math.round((q.durationMs || 0) * 100) / 100,
      driver: q.driver,
    }));
  }

  // Get relevant call trace
  const calltrace = readJsonl(path.join(trickleDir, 'calltrace.jsonl'));
  if (calltrace.length > 0) {
    ctx.relevantCallTrace = calltrace
      .filter((t: any) => t.kind === 'call')
      .slice(0, 15)
      .map((t: any) => ({
        function: t.function,
        module: t.module,
        durationMs: t.durationMs,
      }));
  }

  if (Object.keys(ctx).length > 0) {
    failure.runtimeContext = ctx;
  }
}

// ── Main ──

export async function runTestCommand(opts: TestOptions): Promise<TestReport> {
  let command = opts.command;
  let framework: DetectedFramework | null = null;

  // Auto-detect if no command given
  if (!command) {
    framework = detectTestFramework();
    if (!framework) {
      console.error(chalk.red('\n  No test framework detected.'));
      console.error(chalk.gray('  Specify a command: trickle test "npm test"'));
      process.exitCode = 1;
      return emptyReport('unknown');
    }
    command = framework.command;
  }

  const frameworkName = framework?.name || detectFrameworkFromCommand(command);
  const trickleDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');

  // Determine if we should add JSON reporter
  let testCommand = command;
  let useJsonReporter = false;

  // Normalize "python -m pytest" to "pytest" for proper trickle run injection
  testCommand = testCommand.replace(/^python3?\s+-m\s+pytest\b/, 'pytest');

  // Resolve trickle jest-setup path for setupFiles injection
  let jestSetupPath = '';
  try {
    jestSetupPath = require.resolve('trickle-observe/jest-setup');
  } catch {
    try {
      jestSetupPath = path.resolve(__dirname, '..', '..', '..', 'client-js', 'jest-setup.js');
      if (!fs.existsSync(jestSetupPath)) jestSetupPath = '';
    } catch {}
  }

  if (frameworkName === 'jest' && !command.includes('--json')) {
    testCommand = `${testCommand} --json --outputFile=${path.join(trickleDir, 'test-results.json')}`;
    useJsonReporter = true;
  } else if (frameworkName === 'vitest' && !command.includes('--reporter')) {
    testCommand = `${testCommand} --reporter=json --outputFile=${path.join(trickleDir, 'test-results.json')}`;
    useJsonReporter = true;
  } else if (frameworkName === 'pytest' && !testCommand.includes('-v')) {
    testCommand = `${testCommand} -v`;
  }

  // Note: Jest/Vitest use their own module system (jest-runtime) that bypasses
  // Node's Module._load hooks, so DB query/function observation doesn't work
  // inside test files. The test results (pass/fail) are still captured.
  // For full observability during tests, run the app directly:
  //   trickle run "node app.js"  (then run tests separately against it)

  if (!opts.json) {
    console.log('');
    console.log(chalk.bold('  trickle test'));
    console.log(chalk.gray('  ' + '─'.repeat(50)));
    console.log(chalk.gray(`  Framework: ${frameworkName}`));
    console.log(chalk.gray(`  Command:   ${testCommand}`));
    console.log(chalk.gray('  ' + '─'.repeat(50)));
    console.log('');
  }

  // Clear old data so observability reflects only the test run
  if (fs.existsSync(trickleDir)) {
    const dataFiles = ['observations.jsonl', 'variables.jsonl', 'queries.jsonl',
      'errors.jsonl', 'calltrace.jsonl', 'console.jsonl', 'logs.jsonl',
      'alerts.jsonl', 'traces.jsonl', 'profile.jsonl', 'summary.json'];
    for (const f of dataFiles) {
      const fp = path.join(trickleDir, f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  } else {
    fs.mkdirSync(trickleDir, { recursive: true });
  }

  // Run tests with trickle instrumentation
  const startTime = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    // Run tests through trickle run via shell (not spawnSync with args)
    // so that the command is properly interpreted as a shell command
    const cliPath = path.join(__dirname, '..', 'index.js');
    const result = spawnSync('sh', ['-c', `node "${cliPath}" run ${testCommand}`], {
      cwd: process.cwd(),
      env: { ...process.env, TRICKLE_LOCAL: '1', TRICKLE_STUBS: '0' },
      timeout: 300000, // 5 minutes
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    stdout = result.stdout || '';
    stderr = result.stderr || '';
    exitCode = result.status || 0;
  } catch (e: any) {
    stdout = e.stdout || '';
    stderr = e.stderr || '';
    exitCode = e.status || 1;
  }

  const duration = Date.now() - startTime;
  const combinedOutput = stdout + '\n' + stderr;

  // Parse test results
  let parsed: { suites: TestSuite[]; summary: TestReport['summary'] } | null = null;

  // Try JSON results file first (jest/vitest)
  const jsonResultsFile = path.join(trickleDir, 'test-results.json');
  if (useJsonReporter && fs.existsSync(jsonResultsFile)) {
    try {
      const jsonOutput = fs.readFileSync(jsonResultsFile, 'utf-8');
      if (frameworkName === 'jest') parsed = parseJestJson(jsonOutput);
      else if (frameworkName === 'vitest') parsed = parseVitestJson(jsonOutput);
    } catch {}
  }

  // Fall back to stdout parsing
  if (!parsed) {
    if (frameworkName === 'jest') parsed = parseJestJson(combinedOutput);
    else if (frameworkName === 'vitest') parsed = parseVitestJson(combinedOutput);
    else if (frameworkName === 'pytest') parsed = parsePytestOutput(combinedOutput);
  }

  // Generic fallback
  if (!parsed) {
    parsed = parseGenericOutput(combinedOutput, exitCode);
  }

  // Build failures list with runtime context
  const failures: TestReport['failures'] = [];
  for (const suite of parsed.suites) {
    for (const test of suite.tests) {
      if (test.status === 'failed' || test.status === 'error') {
        const failure: TestReport['failures'][0] = {
          test: test.name,
          suite: suite.name,
          file: test.file || suite.file,
          error: {
            message: test.error?.message || 'Unknown error',
            stack: test.error?.stack,
          },
        };
        enrichFailureWithContext(failure, trickleDir);
        failures.push(failure);
      }
    }
  }

  // If no parsed failures but exit code is non-zero, create a generic failure
  if (failures.length === 0 && exitCode !== 0 && parsed.summary.passed === 0) {
    // Extract error from output (skip section headers like "=== FAILURES ===")
    const errorLines = combinedOutput.split('\n')
      .filter(l => /error|fail|assert/i.test(l) && !l.match(/^[=\-─]{3,}/))
      .slice(0, 5)
      .join('\n');
    if (errorLines) {
      const failure: TestReport['failures'][0] = {
        test: 'unknown',
        error: { message: errorLines.substring(0, 500) },
      };
      enrichFailureWithContext(failure, trickleDir);
      failures.push(failure);
    }
  }

  // Gather observability data
  const alerts = readJsonl(path.join(trickleDir, 'alerts.jsonl'));
  const observations = readJsonl(path.join(trickleDir, 'observations.jsonl'));
  const queries = readJsonl(path.join(trickleDir, 'queries.jsonl'));
  const errors = readJsonl(path.join(trickleDir, 'errors.jsonl'));
  const logs = readJsonl(path.join(trickleDir, 'logs.jsonl'));

  const report: TestReport = {
    timestamp: new Date().toISOString(),
    command: testCommand,
    framework: frameworkName,
    exitCode,
    duration,

    summary: parsed.summary,
    failures,
    suites: parsed.suites,

    observability: {
      functionsObserved: new Set(observations.map((o: any) => `${o.module}.${o.functionName}`)).size,
      queriesCaptured: queries.length,
      errorsDetected: errors.length,
      logsCaptured: logs.length,
      alerts: alerts.slice(0, 10).map((a: any) => ({
        severity: a.severity,
        category: a.category,
        message: a.message,
        suggestion: a.suggestion,
      })),
    },
  };

  // Write report
  try {
    fs.writeFileSync(
      path.join(trickleDir, 'test-report.json'),
      JSON.stringify(report, null, 2),
    );
  } catch {}

  // Output
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }

  return report;
}

function printReport(report: TestReport): void {
  const { summary } = report;
  const statusIcon = summary.failed > 0 ? chalk.red('✗ FAIL') : chalk.green('✓ PASS');

  console.log('');
  console.log(chalk.bold('  trickle test results'));
  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(`  Status: ${statusIcon}  (${report.duration}ms)`);
  console.log(`  Tests:  ${chalk.green(String(summary.passed) + ' passed')} | ${summary.failed > 0 ? chalk.red(String(summary.failed) + ' failed') : '0 failed'} | ${summary.skipped} skipped | ${summary.total} total`);
  console.log(`  Suites: ${summary.suites}`);

  if (report.failures.length > 0) {
    console.log('');
    console.log(chalk.bold('  Failures:'));
    for (const f of report.failures.slice(0, 10)) {
      console.log(`  ${chalk.red('✗')} ${f.suite ? f.suite + ' > ' : ''}${f.test}`);
      if (f.file) console.log(chalk.gray(`    ${f.file}`));
      console.log(chalk.red(`    ${f.error.message.split('\n')[0].substring(0, 100)}`));

      if (f.runtimeContext) {
        if (f.runtimeContext.errorContext?.length) {
          console.log(chalk.gray('    Runtime errors:'));
          for (const e of f.runtimeContext.errorContext.slice(0, 2)) {
            console.log(chalk.gray(`      ${e.message.split('\n')[0].substring(0, 80)}`));
          }
        }
        if (f.runtimeContext.queriesDuringTest?.length) {
          console.log(chalk.gray(`    Queries: ${f.runtimeContext.queriesDuringTest.length} captured`));
        }
        if (f.runtimeContext.variablesNearFailure?.length) {
          console.log(chalk.gray(`    Variables: ${f.runtimeContext.variablesNearFailure.length} captured near failure`));
        }
      }
    }
  }

  if (report.observability) {
    console.log('');
    console.log(chalk.bold('  Observability:'));
    console.log(chalk.gray(`    ${report.observability.functionsObserved} functions | ${report.observability.queriesCaptured} queries | ${report.observability.errorsDetected} errors | ${report.observability.logsCaptured} logs`));
    if (report.observability.alerts.length > 0) {
      console.log(chalk.gray(`    ${report.observability.alerts.length} alert(s):`));
      for (const a of report.observability.alerts.slice(0, 3)) {
        const icon = a.severity === 'critical' ? chalk.red('✗') : chalk.yellow('⚠');
        console.log(chalk.gray(`      ${icon} ${a.message}`));
      }
    }
  }

  console.log(chalk.gray('  ' + '─'.repeat(50)));
  console.log(chalk.gray('  Report saved to .trickle/test-report.json'));
  console.log('');
}

function emptyReport(command: string): TestReport {
  return {
    timestamp: new Date().toISOString(),
    command,
    framework: 'unknown',
    exitCode: 1,
    duration: 0,
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, suites: 0 },
    failures: [],
    suites: [],
  };
}
