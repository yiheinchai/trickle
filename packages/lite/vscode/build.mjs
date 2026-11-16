// Bundle the extension (CommonJS, for VS Code) and the checker CLI (ESM, run as a child process).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(here, 'src/extension.ts')],
  outfile: path.join(here, 'dist/extension.js'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], minify: true, sourcemap: false,
});
await build({
  entryPoints: [path.join(here, '../src/cli.ts')],
  outfile: path.join(here, 'dist/cli.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node18', minify: true, external: ['postgres'],
  banner: { js: "import { createRequire as __cr } from 'module'; import { fileURLToPath as __fu } from 'url'; import { dirname as __dn } from 'path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);" },
});
console.log('built vscode/dist');
