/**
 * App that calls test-annotate-helpers functions — used by trickle run to observe types.
 */
const helpers = require('./test-annotate-helpers');

const config = helpers.parseConfig({ host: 'api.example.com', port: 8080, debug: true });
console.log('config:', config);

const items = helpers.processItems([
  { id: 1, name: 'foo' },
  { id: 2, name: 'bar' },
]);
console.log('items:', items.length);

const totals = helpers.calculateTotal([10.5, 20.0, 5.25], 0.1);
console.log('totals:', totals);

console.log('Done!');
