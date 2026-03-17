/**
 * Unit tests for trickle next command.
 *
 * Run with: node --experimental-strip-types --test src/commands/next.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as child_process from 'child_process';
import * as path from 'path';

// npm test runs from packages/cli directory
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

// ── trickle next --help ───────────────────────────────────────────────────────

describe('trickle next --help', () => {
  it('lists next as a registered command', () => {
    const { stdout } = runCli(['--help']);
    assert.ok(stdout.includes('next'), 'trickle --help should list next command');
  });

  it('next --help shows setup subcommand', () => {
    const { stdout } = runCli(['next', '--help']);
    assert.ok(stdout.includes('setup'), 'next --help should list setup subcommand');
  });
});

// ── trickle next setup ────────────────────────────────────────────────────────

describe('trickle next setup', () => {
  it('references withTrickle from trickle-observe/next-plugin', () => {
    const { stdout } = runCli(['next', 'setup']);
    assert.ok(stdout.includes('withTrickle'), 'should mention withTrickle HOC');
    assert.ok(stdout.includes('trickle-observe/next-plugin'), 'should reference next-plugin package');
  });

  it('shows next.config.js setup instructions', () => {
    const { stdout } = runCli(['next', 'setup']);
    assert.ok(stdout.includes('next.config.js'), 'should mention next.config.js');
  });

  it('shows next.config.ts TypeScript variant', () => {
    const { stdout } = runCli(['next', 'setup']);
    assert.ok(stdout.includes('next.config.ts'), 'should mention TypeScript config variant');
  });

  it('shows npm install trickle-observe step', () => {
    const { stdout } = runCli(['next', 'setup']);
    assert.ok(stdout.includes('npm install trickle-observe'), 'should show install command');
  });

  it('shows trickle dev backend command', () => {
    const { stdout } = runCli(['next', 'setup']);
    assert.ok(stdout.includes('trickle dev'), 'should mention trickle dev backend command');
  });

  it('shows TRICKLE_BACKEND_URL env var usage', () => {
    const { stdout } = runCli(['next', 'setup']);
    assert.ok(stdout.includes('TRICKLE_BACKEND_URL'), 'should show TRICKLE_BACKEND_URL env var');
  });

  it('mentions Client Components and Server Components', () => {
    const { stdout } = runCli(['next', 'setup']);
    assert.ok(stdout.includes('Client Component'), 'should mention Client Components');
    assert.ok(stdout.includes('Server Component'), 'should mention Server Components');
  });

  it('uses --backend-url option when provided', () => {
    const { stdout } = runCli(['next', 'setup', '--backend-url', 'http://10.0.0.5:4888']);
    assert.ok(stdout.includes('10.0.0.5:4888'), 'should use provided backend URL');
  });

  it('mentions concise arrow body support', () => {
    const { stdout } = runCli(['next', 'setup']);
    assert.ok(stdout.includes('=>'), 'should mention concise arrow body pattern');
  });
});
