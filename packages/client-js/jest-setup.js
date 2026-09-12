/**
 * Jest/Vitest setup file for trickle type capture.
 *
 * Usage in jest.config.js:
 *   setupFiles: ['trickle-observe/jest-setup']
 */
try {
  require('./dist/observe-register');
} catch {}
