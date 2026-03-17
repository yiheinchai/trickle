/**
 * Unit tests for trickle python command.
 *
 * Run with: node --experimental-strip-types --test src/commands/python.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as child_process from 'child_process';
import * as path from 'path';

const CLI = path.resolve(process.cwd(), 'dist/index.js');

function runCli(args: string[]): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = child_process.execSync(`node ${CLI} ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
  }
}

// ── trickle python --help ─────────────────────────────────────────────────────

describe('trickle python --help', () => {
  it('lists python as a registered command', () => {
    const { stdout } = runCli(['--help']);
    assert.ok(stdout.includes('python'), 'trickle --help should list python command');
  });

  it('python --help shows setup subcommand', () => {
    const { stdout } = runCli(['python', '--help']);
    assert.ok(stdout.includes('setup'), 'python --help should list setup subcommand');
  });
});

// ── trickle python setup ──────────────────────────────────────────────────────

describe('trickle python setup', () => {
  it('shows pip install trickle-observe step', () => {
    const { stdout } = runCli(['python', 'setup']);
    assert.ok(stdout.includes('pip install trickle-observe'), 'should show pip install command');
  });

  it('shows import trickle.auto approach', () => {
    const { stdout } = runCli(['python', 'setup']);
    assert.ok(stdout.includes('import trickle.auto'), 'should show import trickle.auto approach');
  });

  it('shows trickle run python CLI wrapper approach', () => {
    const { stdout } = runCli(['python', 'setup']);
    assert.ok(stdout.includes('trickle run python'), 'should show trickle run python approach');
  });

  it('shows python -m trickle module runner approach', () => {
    const { stdout } = runCli(['python', 'setup']);
    assert.ok(stdout.includes('python -m trickle'), 'should show python -m trickle approach');
  });

  it('mentions VSCode inline hints', () => {
    const { stdout } = runCli(['python', 'setup']);
    assert.ok(stdout.includes('VSCode'), 'should mention VSCode for viewing hints');
  });

  it('mentions pytest integration', () => {
    const { stdout } = runCli(['python', 'setup']);
    assert.ok(stdout.includes('pytest'), 'should mention pytest integration');
  });

  it('mentions Jupyter/IPython support', () => {
    const { stdout } = runCli(['python', 'setup']);
    assert.ok(stdout.includes('Jupyter') || stdout.includes('IPython'), 'should mention Jupyter support');
  });

  it('shows TRICKLE_OBSERVE_INCLUDE env var for filtering', () => {
    const { stdout } = runCli(['python', 'setup']);
    assert.ok(stdout.includes('TRICKLE_OBSERVE_INCLUDE'), 'should show include filter env var');
  });

  it('--venv flag shows virtual environment setup instructions', () => {
    const { stdout } = runCli(['python', 'setup', '--venv']);
    assert.ok(stdout.includes('venv') || stdout.includes('.venv'), 'should show venv instructions with --venv flag');
  });

  it('mentions async function support', () => {
    const { stdout } = runCli(['python', 'setup']);
    assert.ok(stdout.includes('Async') || stdout.includes('async'), 'should mention async function support');
  });
});
