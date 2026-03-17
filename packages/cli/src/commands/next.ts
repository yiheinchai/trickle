/**
 * trickle next — Next.js observability commands.
 *
 * Subcommands:
 *   trickle next setup   — Print setup instructions for a Next.js app
 */

import { Command } from 'commander';

export function nextCommand(program: Command): void {
  const next = program
    .command('next')
    .description('Next.js observability — instrument Next.js apps (App Router + Pages Router) with zero code changes');

  // trickle next setup
  next
    .command('setup')
    .description('Print setup instructions for adding trickle to a Next.js app')
    .option('--backend-url <url>', 'Trickle backend URL (default: http://localhost:4888)')
    .action((opts) => {
      const backendUrl = opts.backendUrl || 'http://localhost:4888';

      console.log(`
╔════════════════════════════════════════════════════════════════╗
║         trickle Next.js Setup                                  ║
╚════════════════════════════════════════════════════════════════╝

Step 1 — Install trickle:
─────────────────────────
  npm install trickle-observe

Step 2 — Wrap your Next.js config (next.config.js):
────────────────────────────────────────────────────
  const { withTrickle } = require('trickle-observe/next-plugin');

  /** @type {import('next').NextConfig} */
  const nextConfig = {
    reactStrictMode: true,
    // ... your existing config
  };

  module.exports = withTrickle(nextConfig);

  Or with TypeScript (next.config.ts):

  import { withTrickle } from 'trickle-observe/next-plugin';
  import type { NextConfig } from 'next';

  const nextConfig: NextConfig = {
    reactStrictMode: true,
  };

  export default withTrickle(nextConfig);

Step 3 — Start trickle alongside Next.js:
──────────────────────────────────────────
  # Terminal 1 — trickle backend
  npx trickle dev

  # Terminal 2 — Next.js dev server
  npm run dev

Step 4 — Open VSCode and see inline hints:
────────────────────────────────────────────
  After navigating your app, your components will show render counts
  and state change hints inline in VSCode:

  export default function ProductPage({ params }) {    // 📊 rendered ×3
    const [open, setOpen] = useState(false);           // 📊 open ×2 → true
    useEffect(() => { fetchData(); }, [params.id]);    // 📊 ran ×2  8ms
    ...
  }

What gets tracked:
──────────────────
  ✓ Client Components ('use client') — render counts, useState changes,
    useEffect/useMemo/useCallback execution counts and duration
  ✓ Server Components — render counts per request
  ✓ All component patterns: function declarations, named exports,
    export default, React.FC, React.memo, React.forwardRef
  ✓ Concise arrow bodies (=> (...)) — e.g. const Layout = ({ children }) => (<div>...</div>)

Advanced options:
─────────────────
  # Use a custom backend URL (e.g. for remote/staging access via ngrok)
  TRICKLE_BACKEND_URL=${backendUrl} npm run dev

  # Pass options to withTrickle for fine-grained control
  module.exports = withTrickle(nextConfig, {
    backendUrl: process.env.TRICKLE_BACKEND_URL,
    include: ['src/components'],   // only instrument these paths
    exclude: ['src/ui/icons'],     // skip these paths
    debug: process.env.TRICKLE_DEBUG === '1',
  });

Real-device / remote access (via ngrok):
─────────────────────────────────────────
  npx ngrok http 4888
  TRICKLE_BACKEND_URL=https://your-ngrok-url.ngrok.io npm run dev
`);
    });
}
