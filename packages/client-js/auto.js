// Entry point for: require('trickle/auto')
process.env.TRICKLE_LOCAL = process.env.TRICKLE_LOCAL || '1';
require('./dist/observe-register');
