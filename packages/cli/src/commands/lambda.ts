/**
 * trickle lambda — AWS Lambda observability commands.
 *
 * Subcommands:
 *   trickle lambda layer   — Package trickle-observe as a Lambda Layer zip
 *   trickle lambda setup   — Print setup instructions for a Lambda function
 *   trickle lambda pull    — Extract trickle observations from CloudWatch Logs
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';

export function lambdaCommand(program: Command): void {
  const lambda = program
    .command('lambda')
    .description('AWS Lambda observability — instrument Lambda functions with zero code changes');

  // trickle lambda setup
  lambda
    .command('setup')
    .description('Print setup instructions for adding trickle to a Lambda function')
    .option('--backend-url <url>', 'URL of your trickle backend (use ngrok for local dev)')
    .action((opts) => {
      const backendUrl = opts.backendUrl || 'https://YOUR-NGROK-URL';
      console.log(`
╔════════════════════════════════════════════════════════════════╗
║         trickle AWS Lambda Setup                               ║
╚════════════════════════════════════════════════════════════════╝

Option A — Zero code changes (NODE_OPTIONS hook):
─────────────────────────────────────────────────
1. Install trickle in your Lambda project:
   npm install trickle-observe

2. Add these environment variables to your Lambda function:
   NODE_OPTIONS   = --require trickle-observe/auto-env
   TRICKLE_AUTO   = 1
   TRICKLE_LOCAL_DIR = /tmp/.trickle

3. (Optional) To see observations in VSCode, expose your local backend:
   npx ngrok http 4888        # start ngrok
   # Then set:
   TRICKLE_BACKEND_URL = ${backendUrl}

Option B — Explicit wrapper (wrapLambda):
──────────────────────────────────────────
import { wrapLambda } from 'trickle-observe/lambda';

export const handler = wrapLambda(async (event, context) => {
  const result = await processOrder(event.orderId);
  return { statusCode: 200, body: JSON.stringify(result) };
});

trickle automatically:
  ✓ Detects Lambda environment (AWS_LAMBDA_FUNCTION_NAME)
  ✓ Writes observations to /tmp/.trickle/ (Lambda's writable FS)
  ✓ Flushes to backend before Lambda freezes the process
  ✓ Captures types of all variables and function calls

Option C — CloudWatch Logs (no backend needed):
─────────────────────────────────────────────────
Add printObservations() at end of your handler:

  import { wrapLambda, printObservations } from 'trickle-observe/lambda';

  export const handler = wrapLambda(async (event, context) => {
    const result = await processOrder(event.orderId);
    printObservations();   // streams [trickle] JSON lines to CloudWatch
    return result;
  });

Then pull observations from CloudWatch:
  trickle lambda pull --function MY_FUNCTION_NAME --region us-east-1
`);
    });

  // trickle lambda layer
  lambda
    .command('layer')
    .description('Create a Lambda Layer zip containing trickle-observe')
    .option('--out <path>', 'Output zip file path', 'trickle-lambda-layer.zip')
    .action(async (opts) => {
      const outPath = path.resolve(opts.out);
      console.log(`[trickle] Creating Lambda Layer zip: ${outPath}`);

      // Create temp dir structure: nodejs/node_modules/trickle-observe/
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trickle-layer-'));
      const nodeModulesDir = path.join(tmpDir, 'nodejs', 'node_modules');
      fs.mkdirSync(nodeModulesDir, { recursive: true });

      try {
        // Install trickle-observe into the temp dir
        console.log('[trickle] Installing trickle-observe...');
        child_process.execSync(
          `npm install trickle-observe --prefix ${path.join(tmpDir, 'nodejs')} --no-save`,
          { stdio: 'inherit' },
        );

        // Create the zip
        console.log('[trickle] Packaging zip...');
        child_process.execSync(
          `cd ${tmpDir} && zip -r ${outPath} nodejs/`,
          { stdio: 'inherit' },
        );

        const size = fs.statSync(outPath).size;
        console.log(`\n✓ Layer created: ${outPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
        console.log(`
Next steps:
  1. Upload to AWS Lambda Layers:
     aws lambda publish-layer-version \\
       --layer-name trickle-observe \\
       --zip-file fileb://${outPath} \\
       --compatible-runtimes nodejs18.x nodejs20.x

  2. Add the layer to your function and set:
     NODE_OPTIONS   = --require /opt/nodejs/node_modules/trickle-observe/auto-env
     TRICKLE_AUTO   = 1
     TRICKLE_LOCAL_DIR = /tmp/.trickle
`);
      } finally {
        // Clean up temp dir
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

  // trickle lambda pull
  lambda
    .command('pull')
    .description('Extract trickle observations from CloudWatch Logs')
    .requiredOption('--function <name>', 'Lambda function name')
    .option('--region <region>', 'AWS region', process.env.AWS_REGION || 'us-east-1')
    .option('--minutes <n>', 'Look back N minutes', '30')
    .option('--out <path>', 'Output JSONL file', '.trickle/variables.jsonl')
    .action(async (opts) => {
      const outPath = path.resolve(opts.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });

      console.log(`[trickle] Pulling observations for ${opts.function} (last ${opts.minutes}min, ${opts.region})`);

      const startTime = Date.now() - parseInt(opts.minutes) * 60 * 1000;

      // Use AWS CLI to get CloudWatch Logs (avoids AWS SDK dependency)
      const cmd = [
        'aws', 'logs', 'filter-log-events',
        '--log-group-name', `/aws/lambda/${opts.function}`,
        '--start-time', String(startTime),
        '--filter-pattern', '"[trickle]"',
        '--region', opts.region,
        '--output', 'json',
      ].join(' ');

      let output: string;
      try {
        output = child_process.execSync(cmd, { encoding: 'utf-8' });
      } catch (err) {
        console.error('[trickle] Failed to fetch CloudWatch Logs. Ensure AWS CLI is configured and you have logs:FilterLogEvents permission.');
        console.error(`Command: ${cmd}`);
        process.exit(1);
      }

      const logData = JSON.parse(output);
      const events: Array<{ message: string }> = logData.events || [];

      let count = 0;
      const lines: string[] = [];
      for (const event of events) {
        // Extract [trickle] JSON lines from CloudWatch messages
        for (const line of event.message.split('\n')) {
          const match = line.match(/\[trickle\]\s+(\{.+\})\s*$/);
          if (match) {
            lines.push(match[1]);
            count++;
          }
        }
      }

      if (count === 0) {
        console.log('[trickle] No trickle observations found. Make sure:');
        console.log('  1. printObservations() is called in your handler');
        console.log('  2. The function has been invoked recently');
      } else {
        fs.writeFileSync(outPath, lines.join('\n') + '\n');
        console.log(`✓ Extracted ${count} observations → ${outPath}`);
        console.log('Open any instrumented file in VSCode to see inline hints.');
      }
    });
}
