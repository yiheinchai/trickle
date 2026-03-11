/**
 * Simple app that requires helper functions from a separate module.
 * Has ZERO trickle imports — relies entirely on trickle run for instrumentation.
 */
const { parseConfig, processItems, fetchData, transformResponse, calculateStats } = require('./test-run-helpers');

async function main() {
  console.log('Starting test app...');

  const config = parseConfig({ host: 'api.example.com', port: 8080, debug: true });
  console.log('Config:', JSON.stringify(config));

  const items = processItems([
    { id: 1, name: 'widget' },
    { id: 2, name: 'gadget' },
    { id: 3, name: 'doohickey' },
  ]);
  console.log(`Processed ${items.length} items`);

  const response = await fetchData('https://api.example.com/users');
  console.log(`Fetched data: status ${response.status}`);

  const transformed = await transformResponse(response);
  console.log(`Transformed: ${transformed.count} users`);

  const stats = calculateStats([10, 20, 30, 40, 50]);
  console.log(`Stats: avg=${stats.avg}, sum=${stats.sum}`);

  console.log('Done!');
}

main().catch(console.error);
