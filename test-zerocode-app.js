/**
 * Plain app with NO trickle code at all.
 * Instrumented externally: node -r trickle/auto test-zerocode-app.js
 */

const { parseCSV, slugify, mergeConfig } = require('./test-zerocode-lib');

const csv = parseCSV("name,age,city\nAlice,30,NYC\nBob,25,LA", ',');
console.log("Parsed", csv.rowCount, "rows");

const slug = slugify("Hello World! This is a Test");
console.log("Slug:", slug.slug);

const config = mergeConfig(
  { host: 'localhost', port: 3000, debug: false },
  { port: 8080, debug: true }
);
console.log("Config keys:", config.totalKeys);

console.log("Done!");
