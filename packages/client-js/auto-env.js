// Conditional auto-instrumentation loader.
//
// Use with NODE_OPTIONS or -r flag:
//   TRICKLE_AUTO=1 node -r trickle/auto-env app.js
//   NODE_OPTIONS="--require trickle/auto-env" node app.js
//
// When TRICKLE_AUTO=1 is set, this loads trickle/auto which installs
// all hooks and starts background type generation.
// When TRICKLE_AUTO is not set, this is a no-op.

if (process.env.TRICKLE_AUTO === '1') {
  require('./dist/auto-register');
}
