// Conditional observation loader.
//
// Use with NODE_OPTIONS or -r flag:
//   TRICKLE_AUTO=1 node -r trickle/auto-env app.js
//
// When TRICKLE_AUTO=1 is set, this loads runtime type capture.
// When TRICKLE_AUTO is not set, this is a no-op.

if (process.env.TRICKLE_AUTO === '1') {
  process.env.TRICKLE_LOCAL = process.env.TRICKLE_LOCAL || '1';
  require('./dist/observe-register');
}
