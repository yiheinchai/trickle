/**
 * `node --import trickle-lite/register app.ts` (or NODE_OPTIONS): observe project
 * TypeScript in this process. `trickle-lite run` sets this up for you.
 */
import { register } from 'node:module';
import './runtime.js';

if (process.env.TRICKLE_DISABLE !== '1') register('./hooks.js', import.meta.url);
