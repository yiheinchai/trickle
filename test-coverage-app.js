/**
 * App that only calls 3 of 5 functions in test-coverage-lib.
 * Used to test type coverage reporting.
 */
require('trickle/auto');

const { add, subtract, multiply } = require('./test-coverage-lib');

// Only call 3 of 5 functions
console.log('add:', add(10, 5));
console.log('subtract:', subtract(10, 5));
console.log('multiply:', multiply(10, 5));

// divide and modulo are NOT called — should show as untyped

console.log('Done!');
