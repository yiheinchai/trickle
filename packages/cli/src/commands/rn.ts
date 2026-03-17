/**
 * trickle rn — React Native observability commands.
 *
 * Subcommands:
 *   trickle rn setup    — Print setup instructions for a React Native / Expo app
 *   trickle rn ip       — Print this machine's LAN IP for real-device configuration
 */

import { Command } from 'commander';
import * as os from 'os';

function getLanIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    // Skip loopback and virtual interfaces
    if (name.toLowerCase().includes('lo') || name.toLowerCase().includes('virtual')) continue;
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

export function rnCommand(program: Command): void {
  const rn = program
    .command('rn')
    .description('React Native observability — instrument React Native / Expo apps with zero code changes');

  // trickle rn setup
  rn
    .command('setup')
    .description('Print setup instructions for adding trickle to a React Native / Expo app')
    .option('--expo', 'Show Expo-specific instructions (default: auto-detected)')
    .option('--ip <address>', 'LAN IP of this machine for real-device access (auto-detected if omitted)')
    .action((opts) => {
      const ip = opts.ip || getLanIp() || '192.168.x.x';
      const backendUrl = `http://${ip}:4888`;

      console.log(`
╔════════════════════════════════════════════════════════════════╗
║         trickle React Native Setup                             ║
╚════════════════════════════════════════════════════════════════╝

Step 1 — Install trickle:
─────────────────────────
  npm install trickle-observe

Step 2 — Add the Metro transformer (metro.config.js):
──────────────────────────────────────────────────────
  // For Expo:
  const { getDefaultConfig } = require('expo/metro-config');
  const config = getDefaultConfig(__dirname);
  config.transformer.babelTransformerPath = require.resolve('trickle-observe/metro-transformer');
  module.exports = config;

  // For bare React Native:
  const { getDefaultConfig } = require('@react-native/metro-config');
  const config = getDefaultConfig(__dirname);
  config.transformer.babelTransformerPath = require.resolve('trickle-observe/metro-transformer');
  module.exports = config;

Step 3 — Start the trickle backend:
─────────────────────────────────────
  npx trickle dev

Step 4 — Start your app with the backend URL:
──────────────────────────────────────────────
  Simulator (same machine — localhost works):
    npx expo start
    # trickle uses http://localhost:4888 by default

  Real device (device must be on same WiFi):
    TRICKLE_BACKEND_URL=${backendUrl} npx expo start

  Android emulator (use 10.0.2.2 instead of localhost):
    TRICKLE_BACKEND_URL=http://10.0.2.2:4888 npx expo start

Step 5 — Open a component in VSCode:
──────────────────────────────────────
  Run the app on your device/simulator, then open any .tsx component
  file in VSCode to see inline hints:

    📊 MyScreen rendered ×3
    📊 count ×5 → 42
    📊 useEffect ×2  145ms

What gets tracked automatically:
  ✓ Component render counts + props (function, arrow, memo, forwardRef, React.FC)
  ✓ useState setter calls with latest value
  ✓ useEffect / useMemo / useCallback execution counts
  ✓ All function argument types

Detected LAN IP: ${ip}
  → Real device backend URL: ${backendUrl}
  → Run "trickle rn ip" to re-check your IP at any time
`);
    });

  // trickle rn ip
  rn
    .command('ip')
    .description("Print this machine's LAN IP address for real-device React Native setup")
    .action(() => {
      const ip = getLanIp();
      if (!ip) {
        console.error('[trickle] Could not detect a LAN IP. Are you connected to a network?');
        process.exit(1);
      }
      console.log(`\nLAN IP: ${ip}`);
      console.log(`\nSet this in your terminal before starting the app:`);
      console.log(`  TRICKLE_BACKEND_URL=http://${ip}:4888 npx expo start`);
      console.log(`\nOr add to your .env:`);
      console.log(`  TRICKLE_BACKEND_URL=http://${ip}:4888`);
    });
}
