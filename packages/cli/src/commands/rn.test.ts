/**
 * Unit tests for trickle rn command.
 *
 * Run with: node --experimental-strip-types --test src/commands/rn.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
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

// ── trickle rn --help ─────────────────────────────────────────────────────────

describe('trickle rn --help', () => {
  it('lists rn as a registered command', () => {
    const { stdout } = runCli(['--help']);
    assert.ok(stdout.includes('rn'), 'trickle --help should list rn command');
  });

  it('rn --help shows setup and ip subcommands', () => {
    const { stdout } = runCli(['rn', '--help']);
    assert.ok(stdout.includes('setup'), 'rn --help should list setup subcommand');
    assert.ok(stdout.includes('ip'), 'rn --help should list ip subcommand');
  });
});

// ── trickle rn setup ──────────────────────────────────────────────────────────

describe('trickle rn setup', () => {
  it('outputs metro.config.js setup instructions', () => {
    const { stdout } = runCli(['rn', 'setup']);
    assert.ok(stdout.includes('metro.config.js'), 'should mention metro.config.js');
  });

  it('outputs babelTransformerPath configuration', () => {
    const { stdout } = runCli(['rn', 'setup']);
    assert.ok(stdout.includes('babelTransformerPath'), 'should show babelTransformerPath config');
  });

  it('references trickle-observe/metro-transformer', () => {
    const { stdout } = runCli(['rn', 'setup']);
    assert.ok(stdout.includes('trickle-observe/metro-transformer'), 'should reference metro-transformer package');
  });

  it('shows Expo and bare RN variants', () => {
    const { stdout } = runCli(['rn', 'setup']);
    assert.ok(stdout.includes('expo/metro-config'), 'should show Expo config import');
    assert.ok(stdout.includes('@react-native/metro-config'), 'should show bare RN config import');
  });

  it('shows Android emulator IP (10.0.2.2)', () => {
    const { stdout } = runCli(['rn', 'setup']);
    assert.ok(stdout.includes('10.0.2.2'), 'should mention Android emulator IP');
  });

  it('uses --ip option when provided', () => {
    const { stdout } = runCli(['rn', 'setup', '--ip', '10.1.2.3']);
    assert.ok(stdout.includes('10.1.2.3'), 'should use provided IP address');
  });

  it('shows npx trickle dev instruction', () => {
    const { stdout } = runCli(['rn', 'setup']);
    assert.ok(stdout.includes('trickle dev'), 'should mention trickle dev backend command');
  });
});

// ── trickle rn ip ─────────────────────────────────────────────────────────────

describe('trickle rn ip', () => {
  it('outputs a valid IPv4 address', () => {
    const { stdout } = runCli(['rn', 'ip']);
    // Extract IP-like patterns
    const ipMatch = stdout.match(/\b(\d{1,3}\.){3}\d{1,3}\b/);
    assert.ok(ipMatch, `should output a valid IPv4 address, got: ${stdout}`);
  });

  it('outputs TRICKLE_BACKEND_URL env var line', () => {
    const { stdout } = runCli(['rn', 'ip']);
    assert.ok(stdout.includes('TRICKLE_BACKEND_URL'), 'should show TRICKLE_BACKEND_URL env var');
  });
});

// ── LAN IP detection ──────────────────────────────────────────────────────────

describe('LAN IP detection (os.networkInterfaces)', () => {
  it('finds at least one non-loopback IPv4 interface', () => {
    const interfaces = os.networkInterfaces();
    let found = false;
    for (const ifaces of Object.values(interfaces)) {
      for (const iface of ifaces ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          found = true;
          assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(iface.address),
            `${iface.address} should be a valid IPv4 address`);
        }
      }
    }
    assert.ok(found, 'should find at least one non-loopback IPv4 interface');
  });
});
