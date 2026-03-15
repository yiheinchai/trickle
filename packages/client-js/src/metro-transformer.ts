/**
 * trickle/metro-transformer — Metro bundler transform for React Native observability.
 *
 * Drop-in Metro transformer that instruments React Native components with
 * trickle's render tracking, useState change tracking, and hook observability —
 * the same tracking trickle's Vite plugin provides for web React apps.
 *
 * Setup in metro.config.js:
 *
 *   const { getDefaultConfig } = require('expo/metro-config');
 *   // or: const { getDefaultConfig } = require('@react-native/metro-config');
 *
 *   const config = getDefaultConfig(__dirname);
 *   config.transformer.babelTransformerPath = require.resolve('trickle-observe/metro-transformer');
 *   module.exports = config;
 *
 * Environment variables:
 *   TRICKLE_BACKEND_URL   — URL of your trickle backend (default: http://localhost:4888)
 *                           For real device: use your machine's LAN IP, e.g. http://192.168.1.5:4888
 *   TRICKLE_DEBUG         — Set to "1" for debug logging
 */

import path from 'path';
import { transformEsmSource } from './vite-plugin';

// The upstream Babel transformer — try Expo first, fall back to bare RN
function getUpstreamTransformer() {
  const candidates = [
    '@expo/metro-config/babel-transformer',
    'metro-react-native-babel-transformer',
  ];
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(candidate);
    } catch {
      // not installed, try next
    }
  }
  throw new Error(
    '[trickle/metro-transformer] Could not find a Metro Babel transformer. ' +
    'Install either @expo/metro-config or metro-react-native-babel-transformer.',
  );
}

interface MetroTransformArgs {
  src: string;
  filename: string;
  options: Record<string, unknown>;
}

const backendUrl = process.env.TRICKLE_BACKEND_URL ?? 'http://localhost:4888';
const debug = process.env.TRICKLE_DEBUG === '1';

export async function transform({ src, filename, options }: MetroTransformArgs) {
  const upstreamTransformer = getUpstreamTransformer();

  // Only instrument React Native component files
  const ext = path.extname(filename).toLowerCase();
  const isReactFile = ext === '.tsx' || ext === '.jsx';
  const isJsFile = ext === '.ts' || ext === '.js';

  if ((isReactFile || isJsFile) && !filename.includes('node_modules') && !filename.includes('trickle-observe')) {
    const moduleName = path.basename(filename).replace(/\.[jt]sx?$/, '');
    // React Native has a JS runtime with fs access, use SSR mode
    const transformed = transformEsmSource(src, filename, moduleName, backendUrl, debug, false, null, true);
    if (transformed !== src) {
      if (debug) {
        console.log(`[trickle/metro] Instrumented ${filename}`);
      }
      return upstreamTransformer.transform({ src: transformed, filename, options });
    }
  }

  return upstreamTransformer.transform({ src, filename, options });
}
