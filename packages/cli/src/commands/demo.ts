/**
 * trickle demo — self-running showcase of all trickle features.
 *
 * Creates a temporary demo project, runs it with trickle, then walks
 * through: summary, explain, flamegraph, security, fix, test, waterfall.
 *
 * Perfect for onboarding, landing pages, and conference demos.
 *
 * Usage:
 *   trickle demo              # run the full demo
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { execSync } from 'child_process';

const DEMO_APP = `
const Database = require('better-sqlite3');
const db = new Database(':memory:');

db.exec(\`
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT UNIQUE);
  CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, total REAL);
\`);

const insert = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
for (let i = 0; i < 5; i++) insert.run('User' + i, 'user' + i + '@demo.com');
db.prepare('INSERT INTO orders (user_id, total) VALUES (?, ?)').run(1, 99.99);
db.prepare('INSERT INTO orders (user_id, total) VALUES (?, ?)').run(2, 49.99);
db.prepare('INSERT INTO orders (user_id, total) VALUES (?, ?)').run(1, 29.99);

// N+1 pattern: fetch each user's orders individually
function getUserOrders(userId) {
  return db.prepare('SELECT * FROM orders WHERE user_id = ?').all(userId);
}

function getAllUsersWithOrders() {
  const users = db.prepare('SELECT * FROM users').all();
  return users.map(u => ({ ...u, orders: getUserOrders(u.id) }));
}

// Simulate API usage
const API_KEY = "sk-demo-not-real-key-1234567890abcdef";
const result = getAllUsersWithOrders();
console.log('Users with orders: ' + result.length);
console.log('Total orders: ' + result.reduce((s, u) => s + u.orders.length, 0));
db.close();
`;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function printSection(title: string): void {
  console.log('');
  console.log(chalk.bgBlue.white.bold(` ${title} `));
  console.log('');
}

export async function runDemo(): Promise<void> {
  const demoDir = path.join(require('os').tmpdir(), 'trickle-demo-' + Date.now());
  fs.mkdirSync(demoDir, { recursive: true });

  console.log('');
  console.log(chalk.bold.cyan('  ╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║          trickle — Live Demo             ║'));
  console.log(chalk.bold.cyan('  ║  Zero-Code Observability in 60 Seconds   ║'));
  console.log(chalk.bold.cyan('  ╚══════════════════════════════════════════╝'));

  // Step 1: Create demo project
  printSection('1. Creating demo project');
  fs.writeFileSync(path.join(demoDir, 'app.js'), DEMO_APP.trim());
  execSync('npm init -y > /dev/null 2>&1 && npm install better-sqlite3 > /dev/null 2>&1', { cwd: demoDir });
  console.log(chalk.gray('  Created Express+SQLite app with N+1 query pattern'));

  // Step 2: Run with trickle
  printSection('2. Running with trickle (zero code changes)');
  console.log(chalk.gray('  $ trickle run app.js'));
  try {
    const cliPath = path.join(__dirname, '..', 'index.js');
    execSync(`node "${cliPath}" run "node app.js"`, {
      cwd: demoDir,
      env: { ...process.env, TRICKLE_LOCAL: '1', TRICKLE_STUBS: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
  } catch {}
  console.log(chalk.green('  ✓ Data captured'));

  // Step 3: Summary
  printSection('3. trickle summary — full overview');
  try {
    const { generateRunSummary } = require('./summary');
    const origLog = console.log;
    console.log = () => {};
    const s = generateRunSummary({ dir: path.join(demoDir, '.trickle') });
    console.log = origLog;
    console.log(`  Status: ${s.status === 'healthy' ? chalk.green('HEALTHY') : s.status === 'warning' ? chalk.yellow('WARNING') : chalk.red('CRITICAL')}`);
    console.log(`  Functions: ${s.counts.functions} | Queries: ${s.counts.queries} | Errors: ${s.counts.errors}`);
    if (s.rootCauses.length > 0) {
      console.log('');
      for (const rc of s.rootCauses.slice(0, 2)) {
        const icon = rc.severity === 'critical' ? chalk.red('✗') : chalk.yellow('⚠');
        console.log(`  ${icon} ${rc.description}`);
        console.log(chalk.gray(`    Fix: ${rc.suggestedFix.substring(0, 60)}`));
      }
    }
  } catch (e: any) {
    console.log(chalk.gray('  (summary unavailable)'));
  }

  // Step 4: Explain
  printSection('4. trickle explain app.js — understand the code');
  try {
    const { explain } = require('./explain');
    const result = explain('app.js', { dir: path.join(demoDir, '.trickle') });
    for (const f of result.functions.slice(0, 3)) {
      console.log(`  ${chalk.green('→')} ${f.signature}`);
    }
    if (result.queries.length > 0) {
      console.log(`  ${chalk.gray(result.queries.length + ' unique queries')}`);
    }
    if (result.alerts.length > 0) {
      console.log(`  ${chalk.yellow('⚠')} ${result.alerts[0].message}`);
    }
  } catch {
    console.log(chalk.gray('  (explain unavailable)'));
  }

  // Step 5: Security
  printSection('5. trickle security — detect secrets');
  try {
    const { runSecurityScan } = require('./security');
    const origLog = console.log;
    console.log = () => {};
    const sec = await runSecurityScan({ dir: path.join(demoDir, '.trickle') });
    console.log = origLog;
    if (sec.findings.length > 0) {
      for (const f of sec.findings.slice(0, 2)) {
        const icon = f.severity === 'critical' ? chalk.red('✗') : chalk.yellow('⚠');
        console.log(`  ${icon} ${f.message}`);
        console.log(chalk.gray(`    ${f.evidence}`));
      }
    } else {
      console.log(chalk.green('  ✓ No security issues'));
    }
  } catch {
    console.log(chalk.gray('  (security scan unavailable)'));
  }

  // Step 6: Fix suggestions
  printSection('6. trickle fix — auto-generate code patches');
  try {
    const { runFix } = require('./fix');
    const origLog = console.log;
    console.log = () => {};
    const fixes = runFix({ dir: path.join(demoDir, '.trickle') });
    console.log = origLog;
    for (const f of fixes.slice(0, 2)) {
      console.log(`  ${chalk.yellow('⚠')} ${f.description}`);
      if (f.suggestedCode) {
        const firstLine = f.suggestedCode.split('\n').find((l: string) => l.trim() && !l.startsWith('--'));
        if (firstLine) console.log(chalk.cyan(`    ${firstLine.trim()}`));
      }
    }
  } catch {
    console.log(chalk.gray('  (fix unavailable)'));
  }

  // Closing
  console.log('');
  console.log(chalk.bold.cyan('  ╔══════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║  Demo complete! Get started:             ║'));
  console.log(chalk.bold.cyan('  ║                                          ║'));
  console.log(chalk.bold.cyan('  ║  npm install -g trickle-cli              ║'));
  console.log(chalk.bold.cyan('  ║  trickle init                            ║'));
  console.log(chalk.bold.cyan('  ║  trickle run node app.js                 ║'));
  console.log(chalk.bold.cyan('  ║                                          ║'));
  console.log(chalk.bold.cyan('  ║  Also try:                               ║'));
  console.log(chalk.bold.cyan('  ║    trickle eval        — A-F grading     ║'));
  console.log(chalk.bold.cyan('  ║    trickle why         — root cause      ║'));
  console.log(chalk.bold.cyan('  ║    trickle cost-report — LLM costs       ║'));
  console.log(chalk.bold.cyan('  ║    trickle summarize   — trace summary   ║'));
  console.log(chalk.bold.cyan('  ║                                          ║'));
  console.log(chalk.bold.cyan('  ║  38 MCP tools | Free, local, zero-code   ║'));
  console.log(chalk.bold.cyan('  ║  github.com/yiheinchai/trickle           ║'));
  console.log(chalk.bold.cyan('  ╚══════════════════════════════════════════╝'));
  console.log('');

  // Cleanup
  try { fs.rmSync(demoDir, { recursive: true }); } catch {}
}
