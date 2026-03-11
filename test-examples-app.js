/**
 * App that exercises test-examples-lib functions for type observation.
 */
require('trickle/auto');

const { calculateDiscount, formatAddress, sumArray } = require('./test-examples-lib');

// Call functions with specific values (these will appear as @example)
const d = calculateDiscount(99.99, 15);
console.log('discount:', d.final);

const a = formatAddress('123 Main St', 'Springfield', '62704');
console.log('address:', a.full);

const s = sumArray([10, 20, 30, 40, 50]);
console.log('sum:', s.total);

console.log('Done!');
