/**
 * Vite plugin for trickle observation.
 *
 * Integrates into Vite's (and Vitest's) transform pipeline to wrap
 * user functions with trickle observation AND trace variable assignments —
 * the same thing observe-register.ts does for Node's Module._compile,
 * but for Vite/Vitest.
 *
 * Usage in vitest.config.ts:
 *
 *   import { tricklePlugin } from 'trickle-observe/vite-plugin';
 *   export default defineConfig({
 *     plugins: [tricklePlugin()],
 *   });
 *
 * Or via CLI:
 *
 *   trickle run vitest run tests/
 */
import path from 'path';
import fs from 'fs';
export function tricklePlugin(options = {}) {
    const include = options.include
        ?? (process.env.TRICKLE_OBSERVE_INCLUDE
            ? process.env.TRICKLE_OBSERVE_INCLUDE.split(',').map(s => s.trim())
            : []);
    const exclude = options.exclude
        ?? (process.env.TRICKLE_OBSERVE_EXCLUDE
            ? process.env.TRICKLE_OBSERVE_EXCLUDE.split(',').map(s => s.trim())
            : []);
    const backendUrl = options.backendUrl
        ?? process.env.TRICKLE_BACKEND_URL
        ?? 'http://localhost:4888';
    const debug = options.debug
        ?? (process.env.TRICKLE_DEBUG === '1' || process.env.TRICKLE_DEBUG === 'true');
    const traceVars = options.traceVars ?? (process.env.TRICKLE_TRACE_VARS !== '0');
    function shouldTransform(id) {
        // Only JS/TS files
        const ext = path.extname(id).toLowerCase();
        if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts'].includes(ext))
            return false;
        // Skip node_modules
        if (id.includes('node_modules'))
            return false;
        // Skip trickle internals
        if (id.includes('trickle-observe') || id.includes('client-js/'))
            return false;
        // Include filter
        if (include.length > 0) {
            if (!include.some(p => id.includes(p)))
                return false;
        }
        // Exclude filter
        if (exclude.length > 0) {
            if (exclude.some(p => id.includes(p)))
                return false;
        }
        return true;
    }
    return {
        name: 'trickle-observe',
        enforce: 'post',
        configureServer(server) {
            // Listen for variable data from browser clients via Vite's HMR WebSocket
            const hot = server.hot || server.ws;
            if (hot && hot.on) {
                const varDir = process.env.TRICKLE_LOCAL_DIR || path.join(process.cwd(), '.trickle');
                try {
                    fs.mkdirSync(varDir, { recursive: true });
                }
                catch { }
                const varsFile = path.join(varDir, 'variables.jsonl');
                hot.on('trickle:vars', (data, client) => {
                    try {
                        if (data && data.lines) {
                            fs.appendFileSync(varsFile, data.lines);
                        }
                    }
                    catch { }
                });
                if (debug) {
                    console.log(`[trickle/vite] WebSocket bridge active → ${varsFile}`);
                }
            }
        },
        transform(code, id, options) {
            if (!shouldTransform(id))
                return null;
            const isSSR = options?.ssr === true;
            // Read the original source file to get accurate line numbers.
            // Vite transforms the code before our plugin (enforce: 'post'),
            // so line numbers from `code` don't match the original .ts file.
            let originalSource = null;
            try {
                originalSource = fs.readFileSync(id, 'utf-8');
            }
            catch {
                // If we can't read the original, we'll use transformed line numbers
            }
            const moduleName = path.basename(id).replace(/\.[jt]sx?$/, '');
            const transformed = transformEsmSource(code, id, moduleName, backendUrl, debug, traceVars, originalSource, isSSR);
            if (transformed === code)
                return null;
            if (debug) {
                console.log(`[trickle/vite] Transformed ${moduleName} (${id}) [${isSSR ? 'SSR' : 'browser'}]`);
            }
            return { code: transformed, map: null };
        },
    };
}
/**
 * Find the opening brace of a function body, skipping the parameter list.
 * Starting from the character right after the opening `(` of the parameter list,
 * scans forward matching parens to find the closing `)`, then finds the `{` after it.
 * Returns -1 if not found.
 */
export function findFunctionBodyBrace(source, afterOpenParen) {
    let depth = 1;
    let pos = afterOpenParen;
    // Skip the parameter list (matching parens)
    while (pos < source.length && depth > 0) {
        const ch = source[pos];
        if (ch === '(')
            depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0)
                break;
        }
        else if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch;
            pos++;
            while (pos < source.length && source[pos] !== quote) {
                if (source[pos] === '\\')
                    pos++;
                pos++;
            }
        }
        pos++;
    }
    // Now find the `{` after the closing `)`
    while (pos < source.length) {
        const ch = source[pos];
        if (ch === '{')
            return pos;
        if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== ':') {
            // Hit something unexpected (like '=>' for arrows, or type annotation chars)
            if (ch === '=' && pos + 1 < source.length && source[pos + 1] === '>') {
                // Arrow — find { after =>
                pos += 2;
                continue;
            }
            // Type annotation — keep going (`: ReturnType`)
        }
        pos++;
    }
    return -1;
}
/**
 * Find the closing brace position for a function body starting at `openBrace`.
 */
function findClosingBrace(source, openBrace) {
    let depth = 1;
    let pos = openBrace + 1;
    while (pos < source.length && depth > 0) {
        const ch = source[pos];
        if (ch === '{') {
            depth++;
        }
        else if (ch === '}') {
            depth--;
            if (depth === 0)
                return pos;
        }
        else if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch;
            pos++;
            while (pos < source.length) {
                if (source[pos] === '\\') {
                    pos++;
                }
                else if (source[pos] === quote)
                    break;
                else if (quote === '`' && source[pos] === '$' && pos + 1 < source.length && source[pos + 1] === '{') {
                    pos += 2;
                    let tDepth = 1;
                    while (pos < source.length && tDepth > 0) {
                        if (source[pos] === '{')
                            tDepth++;
                        else if (source[pos] === '}')
                            tDepth--;
                        pos++;
                    }
                    continue;
                }
                pos++;
            }
        }
        else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '/') {
            while (pos < source.length && source[pos] !== '\n')
                pos++;
        }
        else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '*') {
            pos += 2;
            while (pos < source.length - 1 && !(source[pos] === '*' && source[pos + 1] === '/'))
                pos++;
            pos++;
        }
        pos++;
    }
    return -1;
}
/**
 * Find the matching closing paren for an opening paren at openParen.
 * JSX-safe version: counts `(` and `)` depth, handles JSX curly expressions,
 * but does NOT treat `'` as a string delimiter (apostrophes in JSX text content
 * like `I'm` would incorrectly consume parens). Double-quoted strings inside
 * JSX attr values typically contain balanced parens so can be ignored safely.
 */
function findMatchingParen(source, openParen) {
    let depth = 1;
    let pos = openParen + 1;
    while (pos < source.length && depth > 0) {
        const ch = source[pos];
        if (ch === '(') {
            depth++;
        }
        else if (ch === ')') {
            depth--;
            if (depth === 0)
                return pos;
        }
        // Skip JSX expression blocks {expr} — not parens but skip curly content to avoid
        // false paren matches inside template expressions
        pos++;
    }
    return -1;
}
/**
 * Find variable declarations in source and return insertions for tracing.
 * Handles: const x = ...; let x = ...; var x = ...;
 * Skips: destructuring, for-loop vars, require() calls, imports, type annotations.
 */
function findVarDeclarations(source) {
    const varInsertions = [];
    // Match: const/let/var <identifier> = <something>
    const varRegex = /^([ \t]*)(export\s+)?(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[^=]+?)?\s*=[^=]/gm;
    let vmatch;
    while ((vmatch = varRegex.exec(source)) !== null) {
        const varName = vmatch[4];
        // Skip trickle internals
        if (varName.startsWith('__trickle'))
            continue;
        // Skip TS compiled vars and helpers
        if (varName === '_a' || varName === '_b' || varName === '_c')
            continue;
        if (varName === '__createBinding' || varName === '__setModuleDefault' || varName === '__importStar' || varName === '__importDefault')
            continue;
        if (varName === '__decorate' || varName === '__metadata' || varName === '__param' || varName === '__awaiter')
            continue;
        if (varName === 'ownKeys' || varName === 'desc')
            continue;
        // Skip esbuild helpers
        if (varName === '__defProp' || varName === '__defNormalProp' || varName === '__publicField' || varName === '__getOwnPropNames')
            continue;
        if (varName === '__commonJS' || varName === '__toCommonJS' || varName === '__export' || varName === '__copyProps')
            continue;
        // Skip webpack internals
        if (varName.startsWith('__webpack_'))
            continue;
        if (varName === '__unused_webpack_module')
            continue;
        // Skip React Refresh / HMR internals (Vite, webpack, Next.js inject these)
        if (varName === 'prevRefreshReg' || varName === 'prevRefreshSig' || varName === 'inWebWorker' || varName === 'invalidateMessage')
            continue;
        if (varName === '_s' || varName === '_c2' || varName === '_s2')
            continue;
        // Skip single-underscore discard variables
        if (varName === '_')
            continue;
        // Check if this is a require() call or import — skip those
        const restOfLine = source.slice(vmatch.index + vmatch[0].length - 1, vmatch.index + vmatch[0].length + 200);
        if (/^\s*require\s*\(/.test(restOfLine))
            continue;
        // Skip function/class assignments (those are handled by function wrapping)
        if (/^\s*(?:async\s+)?(?:function\s|\([^)]*\)\s*(?::\s*[^=]+?)?\s*=>|\w+\s*=>)/.test(restOfLine))
            continue;
        // Calculate line number
        let lineNo = 1;
        for (let i = 0; i < vmatch.index; i++) {
            if (source[i] === '\n')
                lineNo++;
        }
        // Find the end of this statement
        const startPos = vmatch.index + vmatch[0].length - 1;
        let pos = startPos;
        let depth = 0;
        let foundEnd = -1;
        while (pos < source.length) {
            const ch = source[pos];
            if (ch === '(' || ch === '[' || ch === '{') {
                depth++;
            }
            else if (ch === ')' || ch === ']' || ch === '}') {
                depth--;
                if (depth < 0)
                    break;
            }
            else if (ch === ';' && depth === 0) {
                foundEnd = pos;
                break;
            }
            else if (ch === '\n' && depth === 0) {
                const nextNonWs = source.slice(pos + 1).match(/^\s*(\S)/);
                if (nextNonWs && !'.+=-|&?:,'.includes(nextNonWs[1])) {
                    foundEnd = pos;
                    break;
                }
            }
            else if (ch === '"' || ch === "'" || ch === '`') {
                const quote = ch;
                pos++;
                while (pos < source.length) {
                    if (source[pos] === '\\') {
                        pos++;
                    }
                    else if (source[pos] === quote)
                        break;
                    pos++;
                }
            }
            else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '/') {
                while (pos < source.length && source[pos] !== '\n')
                    pos++;
                continue;
            }
            else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '*') {
                pos += 2;
                while (pos < source.length - 1 && !(source[pos] === '*' && source[pos + 1] === '/'))
                    pos++;
                pos++;
            }
            pos++;
        }
        if (foundEnd === -1)
            continue;
        varInsertions.push({ lineEnd: foundEnd + 1, varName, lineNo });
    }
    return varInsertions;
}
/**
 * Find destructured variable declarations: const { a, b } = ... and const [a, b] = ...
 * Extracts the individual variable names from the destructuring pattern.
 */
function findDestructuredDeclarations(source) {
    const results = [];
    // Match: const/let/var { ... } = ... or const/let/var [ ... ] = ...
    const destructRegex = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\])\s*(?::\s*[^=]+?)?\s*=[^=]/gm;
    let match;
    while ((match = destructRegex.exec(source)) !== null) {
        const pattern = match[1];
        // Extract variable names from the destructuring pattern
        const varNames = extractDestructuredNames(pattern);
        if (varNames.length === 0)
            continue;
        // Skip if it's a require() call
        const restOfLine = source.slice(match.index + match[0].length - 1, match.index + match[0].length + 200);
        if (/^\s*require\s*\(/.test(restOfLine))
            continue;
        // Calculate line number
        let lineNo = 1;
        for (let i = 0; i < match.index; i++) {
            if (source[i] === '\n')
                lineNo++;
        }
        // Find the end of this statement (same logic as findVarDeclarations)
        const startPos = match.index + match[0].length - 1;
        let pos = startPos;
        let depth = 0;
        let foundEnd = -1;
        while (pos < source.length) {
            const ch = source[pos];
            if (ch === '(' || ch === '[' || ch === '{') {
                depth++;
            }
            else if (ch === ')' || ch === ']' || ch === '}') {
                depth--;
                if (depth < 0)
                    break;
            }
            else if (ch === ';' && depth === 0) {
                foundEnd = pos;
                break;
            }
            else if (ch === '\n' && depth === 0) {
                const nextNonWs = source.slice(pos + 1).match(/^\s*(\S)/);
                if (nextNonWs && !'.+=-|&?:,'.includes(nextNonWs[1])) {
                    foundEnd = pos;
                    break;
                }
            }
            else if (ch === '"' || ch === "'" || ch === '`') {
                const quote = ch;
                pos++;
                while (pos < source.length) {
                    if (source[pos] === '\\') {
                        pos++;
                    }
                    else if (source[pos] === quote)
                        break;
                    pos++;
                }
            }
            else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '/') {
                while (pos < source.length && source[pos] !== '\n')
                    pos++;
                continue;
            }
            else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '*') {
                pos += 2;
                while (pos < source.length - 1 && !(source[pos] === '*' && source[pos + 1] === '/'))
                    pos++;
                pos++;
            }
            pos++;
        }
        if (foundEnd === -1)
            continue;
        results.push({ lineEnd: foundEnd + 1, varNames, lineNo });
    }
    return results;
}
/**
 * Extract variable names from a destructuring pattern.
 * Handles: { a, b, c: d } → ['a', 'b', 'd']  (renamed vars use the local name)
 * Handles: [a, b, ...rest] → ['a', 'b', 'rest']
 * Handles: { a: { b, c } } → ['b', 'c']  (nested destructuring)
 */
function extractDestructuredNames(pattern) {
    const names = [];
    // Remove outer braces/brackets
    const inner = pattern.slice(1, -1).trim();
    if (!inner)
        return names;
    // Split by commas at depth 0
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of inner) {
        if (ch === '{' || ch === '[')
            depth++;
        else if (ch === '}' || ch === ']')
            depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim())
        parts.push(current.trim());
    for (let part of parts) {
        // Remove type annotations: `a: Type` vs `a: b` (rename)
        // Skip rest elements for now: ...rest → rest
        if (part.startsWith('...')) {
            const restName = part.slice(3).trim().split(/[\s:]/)[0];
            if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(restName)) {
                names.push(restName);
            }
            continue;
        }
        // Check for rename pattern: key: localName or key: { nested }
        const colonIdx = part.indexOf(':');
        if (colonIdx !== -1) {
            const afterColon = part.slice(colonIdx + 1).trim();
            // Nested destructuring: key: { a, b } or key: [a, b]
            if (afterColon.startsWith('{') || afterColon.startsWith('[')) {
                const nestedNames = extractDestructuredNames(afterColon);
                names.push(...nestedNames);
            }
            else {
                // Rename: key: localName — extract localName (skip if it has another colon for type annotation)
                const localName = afterColon.split(/[\s=]/)[0].trim();
                if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(localName)) {
                    names.push(localName);
                }
            }
        }
        else {
            // Simple: just the identifier (possibly with default: `a = defaultVal`)
            const name = part.split(/[\s=]/)[0].trim();
            if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
                names.push(name);
            }
        }
    }
    return names;
}
/**
 * Find import declarations and extract imported bindings for tracing.
 * Handles:
 *   import { a, b } from '...'        → trace a, b
 *   import { a as b } from '...'      → trace b (local name)
 *   import X from '...'               → trace X (default import)
 *   import * as X from '...'          → trace X (namespace import)
 *   import X, { a, b } from '...'    → trace X, a, b
 * Returns insertions to place AFTER the import statement.
 */
function findImportDeclarations(source) {
    const results = [];
    // Match import statements (potentially multiline)
    // We scan for `import` at the start of a line (with optional whitespace)
    const importRegex = /^[ \t]*import\s+/gm;
    let match;
    while ((match = importRegex.exec(source)) !== null) {
        const importStart = match.index;
        let pos = importStart + match[0].length;
        const varNames = [];
        // Skip type-only imports: `import type ...`
        if (source.slice(pos).startsWith('type ') || source.slice(pos).startsWith('type{'))
            continue;
        // Skip bare imports: `import '...'` or `import "..."`
        const afterImport = source[pos];
        if (afterImport === '"' || afterImport === "'")
            continue;
        // Parse the import clause
        // Could be:
        //   * as X
        //   X (default)
        //   { a, b, c as d }
        //   X, { a, b }
        //   X, * as Y
        // Check for namespace import: * as X
        if (source[pos] === '*') {
            const nsMatch = source.slice(pos).match(/^\*\s+as\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
            if (nsMatch) {
                varNames.push(nsMatch[1]);
                pos += nsMatch[0].length;
            }
        }
        // Check for default import or named imports
        else if (source[pos] === '{') {
            // Named imports only: { a, b, c as d }
            const closeIdx = source.indexOf('}', pos);
            if (closeIdx === -1)
                continue;
            const namedStr = source.slice(pos + 1, closeIdx);
            const names = parseNamedImports(namedStr);
            varNames.push(...names);
            pos = closeIdx + 1;
        }
        else {
            // Default import: X or X, { ... } or X, * as Y
            const defaultMatch = source.slice(pos).match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/);
            if (defaultMatch) {
                varNames.push(defaultMatch[1]);
                pos += defaultMatch[0].length;
                // Skip whitespace and comma
                while (pos < source.length && /[\s,]/.test(source[pos]))
                    pos++;
                // Check for additional named imports: , { a, b }
                if (source[pos] === '{') {
                    const closeIdx = source.indexOf('}', pos);
                    if (closeIdx !== -1) {
                        const namedStr = source.slice(pos + 1, closeIdx);
                        const names = parseNamedImports(namedStr);
                        varNames.push(...names);
                        pos = closeIdx + 1;
                    }
                }
                // Check for namespace: , * as Y
                else if (source[pos] === '*') {
                    const nsMatch = source.slice(pos).match(/^\*\s+as\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
                    if (nsMatch) {
                        varNames.push(nsMatch[1]);
                        pos += nsMatch[0].length;
                    }
                }
            }
        }
        if (varNames.length === 0)
            continue;
        // Skip trickle internals
        const filtered = varNames.filter(n => !n.startsWith('__trickle'));
        if (filtered.length === 0)
            continue;
        // Find the end of the import statement (semicolon or newline after `from '...'`)
        const fromIdx = source.indexOf('from', pos);
        if (fromIdx === -1)
            continue;
        // Find the end: either `;` or end of line after the string literal
        let endPos = fromIdx + 4;
        // Skip whitespace
        while (endPos < source.length && /\s/.test(source[endPos]))
            endPos++;
        // Skip the string literal
        if (endPos < source.length && (source[endPos] === '"' || source[endPos] === "'")) {
            const quote = source[endPos];
            endPos++;
            while (endPos < source.length && source[endPos] !== quote) {
                if (source[endPos] === '\\')
                    endPos++;
                endPos++;
            }
            endPos++; // skip closing quote
        }
        // Skip optional semicolon
        while (endPos < source.length && (source[endPos] === ';' || source[endPos] === ' ' || source[endPos] === '\t'))
            endPos++;
        // Calculate line number
        let lineNo = 1;
        for (let i = 0; i < importStart; i++) {
            if (source[i] === '\n')
                lineNo++;
        }
        results.push({ lineEnd: endPos, varNames: filtered, lineNo });
    }
    return results;
}
/**
 * Parse named imports from the content between { and }.
 * Handles: a, b, c as d, type e (skips type-only imports)
 * Returns local binding names.
 */
function parseNamedImports(namedStr) {
    const names = [];
    const parts = namedStr.split(',');
    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed)
            continue;
        // Skip type-only: `type Foo` or `type Foo as Bar`
        if (/^type\s+/.test(trimmed))
            continue;
        // Check for alias: `original as local`
        const asMatch = trimmed.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s+as\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
        if (asMatch) {
            names.push(asMatch[1]);
        }
        else {
            const name = trimmed.split(/[\s]/)[0];
            if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
                names.push(name);
            }
        }
    }
    return names;
}
/**
 * Find class body ranges in source code. Handles both:
 *   class Foo { ... }
 *   var Foo = class { ... }
 * Returns an array of [start, end] positions (inclusive of braces).
 */
export function findClassBodyRanges(source) {
    const ranges = [];
    // Match both class declarations and class expressions
    const classRegex = /\bclass\s*(?:[a-zA-Z_$][a-zA-Z0-9_$]*)?\s*(?:extends\s+[a-zA-Z_$.[\]]+\s*)?\{/g;
    let m;
    while ((m = classRegex.exec(source)) !== null) {
        const openBrace = source.indexOf('{', m.index + 5); // skip past 'class'
        if (openBrace === -1)
            continue;
        // Find matching close brace
        let depth = 1;
        let pos = openBrace + 1;
        while (pos < source.length && depth > 0) {
            const ch = source[pos];
            if (ch === '{')
                depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0)
                    break;
            }
            else if (ch === '"' || ch === "'" || ch === '`') {
                const q = ch;
                pos++;
                while (pos < source.length) {
                    if (source[pos] === '\\')
                        pos++;
                    else if (source[pos] === q)
                        break;
                    else if (q === '`' && source[pos] === '$' && source[pos + 1] === '{') {
                        pos += 2;
                        let td = 1;
                        while (pos < source.length && td > 0) {
                            if (source[pos] === '{')
                                td++;
                            else if (source[pos] === '}')
                                td--;
                            pos++;
                        }
                        continue;
                    }
                    pos++;
                }
            }
            else if (ch === '/' && source[pos + 1] === '/') {
                while (pos < source.length && source[pos] !== '\n')
                    pos++;
            }
            else if (ch === '/' && source[pos + 1] === '*') {
                pos += 2;
                while (pos < source.length - 1 && !(source[pos] === '*' && source[pos + 1] === '/'))
                    pos++;
                pos++;
            }
            pos++;
        }
        if (depth === 0)
            ranges.push([openBrace, pos]);
    }
    return ranges;
}
/**
 * Find variable reassignments (not declarations) and return insertions for tracing.
 * Handles: x = newValue; x += 1; x ||= fallback; etc.
 * Only matches standalone reassignment statements at the start of a line.
 * Skips: property assignments (obj.x = ...), indexed (arr[i] = ...),
 *        comparisons (===, !==), arrow functions (=>), declarations (const/let/var).
 */
export function findReassignments(source) {
    const results = [];
    // Pre-compute class body ranges to skip class field declarations
    const classRanges = findClassBodyRanges(source);
    // Match: <identifier> <assignOp>= <value> at the start of a line
    // Compound operators: +=, -=, *=, /=, %=, **=, &&=, ||=, ??=, <<=, >>=, >>>=, &=, |=, ^=
    // Plain: = (but not ==, ===, =>, !=)
    const reassignRegex = /^([ \t]*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:\+|-|\*\*?|\/|%|&&|\|\||<<|>>>?|&|\||\^|\?\?)?=[^=>]/gm;
    let match;
    while ((match = reassignRegex.exec(source)) !== null) {
        const varName = match[2];
        // Skip trickle internals
        if (varName.startsWith('__trickle') || varName.startsWith('_$'))
            continue;
        // Skip common non-variable patterns
        if (varName === '_a' || varName === '_b' || varName === '_c')
            continue;
        // Skip 'this', 'self', 'super' (not reassignable in practice)
        if (varName === 'this' || varName === 'super')
            continue;
        // Skip TS compiler helpers and module internals
        if (varName === 'ownKeys' || varName === 'desc')
            continue;
        // Skip React Refresh / HMR internals and discard variables
        if (varName === 'prevRefreshReg' || varName === 'prevRefreshSig' || varName === 'inWebWorker')
            continue;
        if (varName === '_s' || varName === '_c2' || varName === '_s2' || varName === '_')
            continue;
        // Skip keywords that could look like identifiers
        if (['if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default', 'return', 'throw',
            'break', 'continue', 'try', 'catch', 'finally', 'new', 'delete', 'typeof', 'void',
            'yield', 'await', 'class', 'extends', 'import', 'export', 'from', 'as', 'of', 'in',
            'const', 'let', 'var', 'function', 'true', 'false', 'null', 'undefined'].includes(varName))
            continue;
        // Check that this line doesn't start with const/let/var (would be a declaration, already handled)
        const lineStart = source.lastIndexOf('\n', match.index) + 1;
        const linePrefix = source.slice(lineStart, match.index + match[1].length).trim();
        if (/^(export\s+)?(const|let|var)\s/.test(source.slice(lineStart).trimStart()))
            continue;
        // Skip class field declarations (e.g., `tasks = []` inside a class body)
        // Inserting trace calls inside class bodies causes SyntaxError
        if (classRanges.some(([start, end]) => match.index > start && match.index < end))
            continue;
        // Skip if this looks like a property in an object literal (preceded by a key: pattern on same line)
        // or if it's a label (label: ...)
        const beforeOnLine = source.slice(lineStart, match.index).trim();
        if (beforeOnLine.endsWith(':') || beforeOnLine.endsWith(','))
            continue;
        // Skip comma-separated multi-variable declaration continuations:
        //   var X = 'foo',
        //       Y = 'bar';  ← Y looks like a reassignment but is actually a declaration
        // Detect by checking if the previous non-empty line ends with ','
        if (beforeOnLine.length === 0) {
            const prevLineEnd = source.lastIndexOf('\n', lineStart - 1);
            if (prevLineEnd >= 0) {
                const prevLine = source.slice(source.lastIndexOf('\n', prevLineEnd - 1) + 1, prevLineEnd).trimEnd();
                if (prevLine.endsWith(','))
                    continue;
            }
        }
        // Calculate line number
        let lineNo = 1;
        for (let i = 0; i < match.index; i++) {
            if (source[i] === '\n')
                lineNo++;
        }
        // Find end of statement
        const startPos = match.index + match[0].length - 1;
        let pos = startPos;
        let depth = 0;
        let foundEnd = -1;
        while (pos < source.length) {
            const ch = source[pos];
            if (ch === '(' || ch === '[' || ch === '{') {
                depth++;
            }
            else if (ch === ')' || ch === ']' || ch === '}') {
                depth--;
                if (depth < 0)
                    break;
            }
            else if (ch === ';' && depth === 0) {
                foundEnd = pos;
                break;
            }
            else if (ch === '\n' && depth === 0) {
                const nextNonWs = source.slice(pos + 1).match(/^\s*(\S)/);
                if (nextNonWs && !'.+=-|&?:,'.includes(nextNonWs[1])) {
                    // Check if a recent non-empty line ends with an operator
                    let checkPos2 = pos;
                    let lastCh2 = '';
                    for (let back = 0; back < 5; back++) {
                        const prevNL2 = source.lastIndexOf('\n', checkPos2 - 1);
                        const prevLine2 = source.slice(prevNL2 + 1, checkPos2).trimEnd();
                        if (prevLine2.length > 0) {
                            lastCh2 = prevLine2[prevLine2.length - 1];
                            break;
                        }
                        checkPos2 = prevNL2;
                        if (prevNL2 <= 0)
                            break;
                    }
                    if (lastCh2 && '=+-*/%&|^~<>?:,({['.includes(lastCh2)) {
                        pos++;
                        continue;
                    }
                    foundEnd = pos;
                    break;
                }
            }
            else if (ch === '"' || ch === "'" || ch === '`') {
                const quote = ch;
                pos++;
                while (pos < source.length) {
                    if (source[pos] === '\\') {
                        pos++;
                    }
                    else if (source[pos] === quote)
                        break;
                    pos++;
                }
            }
            else if (ch === '/' && pos + 1 < source.length && source[pos + 1] !== '/' && source[pos + 1] !== '*') {
                // Possible regex literal
                let rp = pos - 1;
                while (rp >= 0 && (source[rp] === ' ' || source[rp] === '\t'))
                    rp--;
                const rpCh = rp >= 0 ? source[rp] : '';
                if ('=(!,;:?[{&|^~+-><%'.includes(rpCh) || source.slice(Math.max(0, rp - 5), rp + 1).match(/\b(return|typeof|instanceof|in|of|void|delete|throw|new|case)\s*$/)) {
                    pos++;
                    while (pos < source.length) {
                        if (source[pos] === '\\')
                            pos++;
                        else if (source[pos] === '[') {
                            pos++;
                            while (pos < source.length && source[pos] !== ']') {
                                if (source[pos] === '\\')
                                    pos++;
                                pos++;
                            }
                        }
                        else if (source[pos] === '/')
                            break;
                        pos++;
                    }
                    while (pos + 1 < source.length && /[gimsuy]/.test(source[pos + 1]))
                        pos++;
                }
            }
            else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '/') {
                while (pos < source.length && source[pos] !== '\n')
                    pos++;
                continue;
            }
            else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '*') {
                pos += 2;
                while (pos < source.length - 1 && !(source[pos] === '*' && source[pos + 1] === '/'))
                    pos++;
                pos++;
            }
            pos++;
        }
        if (foundEnd === -1)
            continue;
        results.push({ lineEnd: foundEnd + 1, varName, lineNo });
    }
    return results;
}
/**
 * Find for-loop variable declarations and return insertions for tracing.
 * Handles:
 *   for (const item of items) { ... }         → trace item
 *   for (const [key, val] of entries) { ... }  → trace key, val
 *   for (const { a, b } of items) { ... }      → trace a, b
 *   for (const key in obj) { ... }             → trace key
 *   for (let i = 0; i < n; i++) { ... }        → trace i
 * Inserts trace calls at the start of the loop body.
 */
/**
 * Find catch clause variables and return insertions for tracing.
 * Handles: catch (err) { ... } → trace err at start of catch body.
 */
export function findCatchVars(source) {
    const results = [];
    const catchRegex = /\bcatch\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[^)]+?)?\s*\)\s*\{/g;
    let match;
    while ((match = catchRegex.exec(source)) !== null) {
        const varName = match[1];
        if (varName.startsWith('__trickle'))
            continue;
        const bodyBrace = match.index + match[0].length - 1;
        let lineNo = 1;
        for (let i = 0; i < match.index; i++) {
            if (source[i] === '\n')
                lineNo++;
        }
        results.push({ bodyStart: bodyBrace + 1, varNames: [varName], lineNo });
    }
    return results;
}
/**
 * Find simple JSX text expressions and return insertions for tracing.
 * Only traces simple expressions in text content positions (after > or between tags):
 *   <p>{count}</p>              → trace count
 *   <span>{user.name}</span>    → trace user.name
 *   <div>{a + b}</div>          → trace a + b (simple binary)
 *   <p>{x ? 'a' : 'b'}</p>     → trace ternary
 * Skips: attribute expressions, .map() calls, JSX elements, spread, complex calls.
 * Uses comma operator: {(__trickle_tv(expr, name, line), expr)} — safe, returns original value.
 */
function findJsxExpressions(source) {
    const results = [];
    // Find JSX text expressions: characters `>` followed (with optional whitespace/text) by `{expr}`
    // We look for `{` that follows `>` (possibly with whitespace or text between)
    // and is NOT preceded by `=` (which would be an attribute value)
    const jsxExprRegex = /\{/g;
    let match;
    while ((match = jsxExprRegex.exec(source)) !== null) {
        const bracePos = match.index;
        // Skip if this `{` is part of an import statement: `import { ... } from '...'`
        const lineStart = source.lastIndexOf('\n', bracePos - 1) + 1;
        const linePrefix = source.slice(lineStart, bracePos).trimStart();
        if (/^import\s/.test(linePrefix) || /^import\s/.test(linePrefix.replace(/^export\s+/, '')))
            continue;
        // Skip if inside a string or comment
        // Simple check: look at the character before `{`
        const charBefore = bracePos > 0 ? source[bracePos - 1] : '';
        // Skip if this is an attribute value: preceded by `=` (with optional whitespace)
        const beforeSlice = source.slice(Math.max(0, bracePos - 5), bracePos).trimEnd();
        if (beforeSlice.endsWith('='))
            continue;
        // Skip if this looks like a template literal expression `${`
        if (charBefore === '$')
            continue;
        // Skip if preceded (past whitespace) by `,`, `(`, or `:` — function arguments, object literals, attribute values
        if (charBefore === ',')
            continue;
        {
            let scanBack = bracePos - 1;
            while (scanBack >= 0 && (source[scanBack] === ' ' || source[scanBack] === '\t' || source[scanBack] === '\n' || source[scanBack] === '\r'))
                scanBack--;
            if (scanBack >= 0 && (source[scanBack] === ',' || source[scanBack] === '(' || source[scanBack] === ':' || source[scanBack] === ')'))
                continue;
        }
        // Skip if this `{` is part of a variable declaration destructuring: `const { ... }` or `let { ... }`
        if (/(?:const|let|var)\s*$/.test(source.slice(Math.max(0, bracePos - 10), bracePos)))
            continue;
        // Must be in a JSX context: look backward for `>` or `}` (closing tag bracket or prev expression)
        // before hitting structural JS characters like `{`, `(`, `;`
        let inJsx = false;
        let scanPos = bracePos - 1;
        while (scanPos >= 0) {
            const ch = source[scanPos];
            if (ch === '>') {
                inJsx = true;
                break;
            }
            if (ch === '}') {
                inJsx = true;
                break;
            } // After a previous JSX expression
            if (ch === '{' || ch === ';')
                break;
            // `(` breaks scan in code context, but in JSX text `(` is normal
            // Check: if `(` is preceded by `>` or text, it's JSX text
            if (ch === '(') {
                const before = source.slice(Math.max(0, scanPos - 20), scanPos).trim();
                if (before.endsWith('>') || /[a-zA-Z0-9\s]$/.test(before)) {
                    // Could be JSX text like "Users ({count})" — keep scanning
                    scanPos--;
                    continue;
                }
                break;
            }
            // `=` only breaks if NOT preceded by other text (could be JSX text like "count = 5")
            if (ch === '=' && scanPos > 0 && /\s/.test(source[scanPos - 1])) {
                // Check if this `=` is a JSX attribute assignment: look further back for tag
                const attrCheck = source.slice(Math.max(0, scanPos - 30), scanPos).trim();
                if (/^[a-zA-Z]/.test(attrCheck))
                    break; // Likely an attribute
            }
            if (ch === '\n') {
                // Check context of previous lines
                const lineAbove = source.slice(Math.max(0, scanPos - 100), scanPos);
                if (/<|>|\}/.test(lineAbove)) {
                    inJsx = true;
                    break;
                }
                break;
            }
            scanPos--;
        }
        if (!inJsx)
            continue;
        // Find the matching closing `}` for this expression
        let depth = 1;
        let pos = bracePos + 1;
        while (pos < source.length && depth > 0) {
            const ch = source[pos];
            if (ch === '{')
                depth++;
            else if (ch === '}')
                depth--;
            else if (ch === '"' || ch === "'" || ch === '`') {
                const q = ch;
                pos++;
                while (pos < source.length && source[pos] !== q) {
                    if (source[pos] === '\\')
                        pos++;
                    pos++;
                }
            }
            pos++;
        }
        if (depth !== 0)
            continue;
        const exprEnd = pos - 1; // position of closing `}`
        const exprText = source.slice(bracePos + 1, exprEnd).trim();
        // Skip empty expressions
        if (!exprText)
            continue;
        // Skip complex expressions that we don't want to trace:
        // - JSX elements: contains `<` (could be a component)
        // - .map/.filter/.reduce calls (return arrays of elements)
        // - Spread: starts with `...`
        // - Arrow functions: contains `=>`
        // - Already traced: starts with `__trickle`
        if (exprText.includes('<') || exprText.includes('=>'))
            continue;
        if (exprText.startsWith('...'))
            continue;
        if (exprText.startsWith('__trickle'))
            continue;
        if (/\.(map|filter|reduce|forEach|flatMap)\s*\(/.test(exprText))
            continue;
        // Skip function calls with parens (complex expressions) — but allow property access
        // Allow: user.name, count, x ? 'a' : 'b', a + b
        // Skip: fn(), obj.method(), Component()
        if (/\w\s*\(/.test(exprText) && !exprText.includes('?'))
            continue;
        // Only trace if it's a "simple" expression:
        // - Identifier: count, name
        // - Property access: user.name, item.price.formatted
        // - Simple ternary: x ? 'a' : 'b'
        // - Simple arithmetic: count * 2, price + tax
        const isSimple = /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$/.test(exprText) || // identifier/property
            /^[a-zA-Z_$]/.test(exprText); // starts with identifier (covers ternary, arithmetic)
        if (!isSimple)
            continue;
        // Calculate line number
        let lineNo = 1;
        for (let i = 0; i < bracePos; i++) {
            if (source[i] === '\n')
                lineNo++;
        }
        results.push({ exprStart: bracePos + 1, exprEnd, exprText, lineNo });
    }
    return results;
}
export function findForLoopVars(source) {
    const results = [];
    // Match: for (const/let/var ...
    const forRegex = /\bfor\s*\(/g;
    let match;
    while ((match = forRegex.exec(source)) !== null) {
        const afterParen = match.index + match[0].length;
        // Skip whitespace
        let pos = afterParen;
        while (pos < source.length && /\s/.test(source[pos]))
            pos++;
        // Expect const/let/var
        const declMatch = source.slice(pos).match(/^(const|let|var)\s+/);
        if (!declMatch)
            continue;
        pos += declMatch[0].length;
        // Now we have the variable pattern — could be identifier, {destructure}, or [destructure]
        const varNames = [];
        const patternStart = pos;
        if (source[pos] === '{' || source[pos] === '[') {
            // Destructured: find matching brace/bracket
            const open = source[pos];
            const close = open === '{' ? '}' : ']';
            let depth = 1;
            let end = pos + 1;
            while (end < source.length && depth > 0) {
                if (source[end] === open)
                    depth++;
                else if (source[end] === close)
                    depth--;
                end++;
            }
            const pattern = source.slice(pos, end);
            const names = extractDestructuredNames(pattern);
            varNames.push(...names);
            pos = end;
        }
        else {
            // Simple identifier
            const idMatch = source.slice(pos).match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/);
            if (!idMatch)
                continue;
            varNames.push(idMatch[1]);
            pos += idMatch[0].length;
        }
        if (varNames.length === 0)
            continue;
        // Skip trickle internals
        if (varNames.every(n => n.startsWith('__trickle') || n === '_a' || n === '_b' || n === '_c'))
            continue;
        // Now find the opening `{` of the loop body
        // Skip everything until the `)` that closes the for(...)
        let parenDepth = 1; // We're inside the for(
        while (pos < source.length && parenDepth > 0) {
            const ch = source[pos];
            if (ch === '(')
                parenDepth++;
            else if (ch === ')')
                parenDepth--;
            else if (ch === '"' || ch === "'" || ch === '`') {
                const q = ch;
                pos++;
                while (pos < source.length && source[pos] !== q) {
                    if (source[pos] === '\\')
                        pos++;
                    pos++;
                }
            }
            pos++;
        }
        // Now find the `{` after the closing `)`
        while (pos < source.length && /\s/.test(source[pos]))
            pos++;
        if (pos >= source.length || source[pos] !== '{')
            continue;
        const bodyBrace = pos;
        // Calculate line number
        let lineNo = 1;
        for (let i = 0; i < match.index; i++) {
            if (source[i] === '\n')
                lineNo++;
        }
        results.push({ bodyStart: bodyBrace + 1, varNames: varNames.filter(n => !n.startsWith('__trickle')), lineNo });
    }
    return results;
}
/**
 * Find function parameter names and return insertions for tracing at the start
 * of function bodies. Traces the runtime values of all parameters.
 * Handles: function declarations, arrow functions, method definitions.
 * Skips: React components (already tracked via __trickle_rc with props).
 */
export function findFunctionParams(source, isReactFile) {
    const results = [];
    // Match function declarations: function name(params) {
    const funcDeclRegex = /\b(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
    let match;
    while ((match = funcDeclRegex.exec(source)) !== null) {
        const name = match[1];
        if (name === 'require' || name === 'exports' || name === 'module')
            continue;
        if (name.startsWith('__trickle'))
            continue;
        // Skip React components (uppercase) in React files — already tracked
        if (isReactFile && /^[A-Z]/.test(name))
            continue;
        const afterParen = match.index + match[0].length;
        const bodyBrace = findFunctionBodyBrace(source, afterParen);
        if (bodyBrace === -1)
            continue;
        // Extract parameter names from between ( and )
        const paramStr = source.slice(afterParen, bodyBrace);
        const closeParen = paramStr.indexOf(')');
        if (closeParen === -1)
            continue;
        const rawParams = paramStr.slice(0, closeParen).trim();
        const paramNames = extractParamNames(rawParams);
        if (paramNames.length === 0)
            continue;
        let lineNo = 1;
        for (let i = 0; i < match.index; i++) {
            if (source[i] === '\n')
                lineNo++;
        }
        results.push({ bodyStart: bodyBrace + 1, paramNames, lineNo });
    }
    // Match arrow functions: const name = (params) => {
    const arrowFuncRegex = /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*:\s*[^=]+?)?\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*[^=]+?)?\s*=>\s*\{/g;
    while ((match = arrowFuncRegex.exec(source)) !== null) {
        const name = match[1];
        if (name.startsWith('__trickle'))
            continue;
        // Skip React components in React files
        if (isReactFile && /^[A-Z]/.test(name))
            continue;
        const rawParams = match[2].trim();
        const paramNames = extractParamNames(rawParams);
        if (paramNames.length === 0)
            continue;
        // Find the { position
        const bracePos = match.index + match[0].length - 1;
        let lineNo = 1;
        for (let i = 0; i < match.index; i++) {
            if (source[i] === '\n')
                lineNo++;
        }
        results.push({ bodyStart: bracePos + 1, paramNames, lineNo });
    }
    return results;
}
/**
 * Extract parameter names from a function parameter string.
 * Handles: simple names, destructured { a, b }, defaults (a = 1), rest (...args).
 * Skips type annotations.
 */
function extractParamNames(rawParams) {
    if (!rawParams)
        return [];
    const names = [];
    // Split by commas at depth 0
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of rawParams) {
        if (ch === '{' || ch === '[' || ch === '(' || ch === '<')
            depth++;
        else if (ch === '}' || ch === ']' || ch === ')' || ch === '>')
            depth--;
        else if (ch === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim())
        parts.push(current.trim());
    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed)
            continue;
        // Destructured params — extract individual names
        if (trimmed.startsWith('{')) {
            const closeBrace = trimmed.indexOf('}');
            if (closeBrace !== -1) {
                const destructNames = extractDestructuredNames(trimmed.slice(0, closeBrace + 1));
                names.push(...destructNames);
            }
            continue;
        }
        if (trimmed.startsWith('[')) {
            const closeBracket = trimmed.indexOf(']');
            if (closeBracket !== -1) {
                const destructNames = extractDestructuredNames(trimmed.slice(0, closeBracket + 1));
                names.push(...destructNames);
            }
            continue;
        }
        // Rest parameter: ...args
        if (trimmed.startsWith('...')) {
            const restName = trimmed.slice(3).split(/[\s:=]/)[0].trim();
            if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(restName)) {
                names.push(restName);
            }
            continue;
        }
        // Simple param: name or name: Type or name = default
        const paramName = trimmed.split(/[\s:=]/)[0].trim();
        if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(paramName)) {
            names.push(paramName);
        }
    }
    return names;
}
/**
 * Transform ESM source code to wrap function declarations and trace variables.
 *
 * Prepends imports of the wrap/trace helpers, then inserts wrapper calls after
 * each function declaration body and trace calls after variable declarations.
 */
/**
 * Find the original line number for a simple variable declaration.
 * Searches the original source lines for `const/let/var <varName>` near the expected position.
 * Vite transforms typically remove lines (types, imports), so the original line is usually
 * >= the transformed line. We search forward-biased (up to +80) but also a bit backward (-10).
 */
function findOriginalLine(origLines, varName, transformedLine) {
    const pattern = new RegExp(`\\b(const|let|var)\\s+${escapeRegexStr(varName)}\\b`);
    // Search: first try exact, then expand forward (more likely) and a bit backward
    for (let delta = 0; delta <= 80; delta++) {
        // Forward first (original line is usually after transformed line due to removed TS types)
        const fwd = transformedLine - 1 + delta;
        if (fwd >= 0 && fwd < origLines.length && pattern.test(origLines[fwd])) {
            return fwd + 1;
        }
        // Also check backward (small range)
        if (delta > 0 && delta <= 10) {
            const bwd = transformedLine - 1 - delta;
            if (bwd >= 0 && bwd < origLines.length && pattern.test(origLines[bwd])) {
                return bwd + 1;
            }
        }
    }
    return -1;
}
/**
 * Find the original line number for a destructured declaration.
 * Searches for const/let/var { or [ patterns containing at least one of the variable names.
 */
function findOriginalLineDestructured(origLines, varNames, transformedLine) {
    // Match names as actual bindings (not renamed property keys).
    // In `{ data: customer }`, 'data' is a key (followed by ':'), 'customer' is the binding.
    // In `{ data, error }`, 'data' is a binding (followed by ',' or '}').
    // We check: name followed by comma, }, ], =, whitespace, or end — NOT followed by ':' (rename).
    const namePatterns = varNames.map(n => new RegExp(`\\b${escapeRegexStr(n)}\\b(?!\\s*:)`));
    for (let delta = 0; delta <= 80; delta++) {
        const fwd = transformedLine - 1 + delta;
        if (fwd >= 0 && fwd < origLines.length) {
            const line = origLines[fwd];
            if (/\b(const|let|var)\s+[\[{]/.test(line) && namePatterns.some(p => p.test(line))) {
                return fwd + 1;
            }
        }
        if (delta > 0 && delta <= 10) {
            const bwd = transformedLine - 1 - delta;
            if (bwd >= 0 && bwd < origLines.length) {
                const line = origLines[bwd];
                if (/\b(const|let|var)\s+[\[{]/.test(line) && namePatterns.some(p => p.test(line))) {
                    return bwd + 1;
                }
            }
        }
    }
    return -1;
}
function escapeRegexStr(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function transformEsmSource(source, filename, moduleName, backendUrl, debug, traceVars, originalSource, isSSR, 
/** URL for fetch-based browser transport (Next.js client). When set and isSSR=false, uses fetch() instead of import.meta.hot */
ingestUrl) {
    // Detect React files for component render tracking
    const isReactFile = /\.(tsx|jsx)$/.test(filename);
    // Match top-level and nested function declarations (including async, export, export default)
    const funcRegex = /^[ \t]*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/gm;
    const funcInsertions = [];
    // Body insertions: insert at start of function body (for React render tracking)
    // propsExpr: JS expression to evaluate as the props object at render time
    const bodyInsertions = [];
    let match;
    while ((match = funcRegex.exec(source)) !== null) {
        const name = match[1];
        if (name === 'require' || name === 'exports' || name === 'module')
            continue;
        const afterMatch = match.index + match[0].length;
        // Use findFunctionBodyBrace to correctly skip destructured params like ({ a, b }) =>
        const openBrace = findFunctionBodyBrace(source, afterMatch);
        if (openBrace === -1)
            continue;
        // Extract parameter names (between the opening ( and the body {)
        const paramStr = source.slice(afterMatch, openBrace).replace(/[()]/g, '').trim();
        const paramNames = paramStr
            ? paramStr.split(',').map(p => {
                const trimmed = p.trim().split('=')[0].trim().split(':')[0].trim();
                if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('...'))
                    return '';
                return trimmed;
            }).filter(Boolean)
            : [];
        const closeBrace = findClosingBrace(source, openBrace);
        if (closeBrace === -1)
            continue;
        funcInsertions.push({ position: closeBrace + 1, name, paramNames });
        // React component render tracking: uppercase function name in .tsx/.jsx
        // function declarations have `arguments`, so arguments[0] is the raw props object
        if (isReactFile && /^[A-Z]/.test(name)) {
            let lineNo = 1;
            for (let i = 0; i < match.index; i++) {
                if (source[i] === '\n')
                    lineNo++;
            }
            bodyInsertions.push({ position: openBrace + 1, name, lineNo, propsExpr: 'arguments[0]' });
        }
    }
    // Also match arrow functions assigned to const/let/var
    // Handles: const X = () => {}, const X: React.FC = () => {}, const X: React.FC<Props> = ({ a }) => {}
    // Also handles concise bodies: const X = (props) => (<div/>)
    const arrowRegex = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*:\s*[^=]+?)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[^=]+?)?\s*=>\s*(?:\{|\()/gm;
    // Concise body insertions: for `=> (expr)`, wrap with block body for render tracking
    const conciseBodyInsertions = [];
    while ((match = arrowRegex.exec(source)) !== null) {
        const name = match[1];
        const bodyStartPos = match.index + match[0].length - 1;
        const isConcise = source[bodyStartPos] === '(';
        const arrowStr = match[0];
        const arrowParamMatch = arrowStr.match(/=\s*(?:async\s+)?(?:\(([^)]*)\)|([a-zA-Z_$][a-zA-Z0-9_$]*))\s*(?::\s*[^=]+?)?\s*=>/);
        let paramNames = [];
        if (arrowParamMatch) {
            const paramStr = (arrowParamMatch[1] || arrowParamMatch[2] || '').trim();
            if (paramStr) {
                paramNames = paramStr.split(',').map(p => {
                    const trimmed = p.trim().split('=')[0].trim().split(':')[0].trim();
                    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('...'))
                        return '';
                    return trimmed;
                }).filter(Boolean);
            }
        }
        // Helper to build propsExpr from arrowParamMatch
        const buildPropsExpr = () => {
            if (!arrowParamMatch)
                return 'undefined';
            const rawParams = (arrowParamMatch[1] || '').trim();
            if (!rawParams)
                return 'undefined';
            if (rawParams.startsWith('{')) {
                let depth2 = 0, endBrace = -1;
                for (let i = 0; i < rawParams.length; i++) {
                    if (rawParams[i] === '{')
                        depth2++;
                    else if (rawParams[i] === '}') {
                        depth2--;
                        if (depth2 === 0) {
                            endBrace = i;
                            break;
                        }
                    }
                }
                const destructPattern = endBrace !== -1 ? rawParams.slice(0, endBrace + 1) : rawParams;
                const fields = extractDestructuredNames(destructPattern);
                return fields.length > 0 ? `{ ${fields.join(', ')} }` : 'undefined';
            }
            else if (arrowParamMatch[2]) {
                return arrowParamMatch[2];
            }
            else if (paramNames.length === 1) {
                return paramNames[0];
            }
            return 'undefined';
        };
        if (isConcise) {
            // Concise body: `const X = (props) => (<div/>)` — no block body
            // Only add render tracking for React components (uppercase names in .tsx/.jsx)
            if (isReactFile && /^[A-Z]/.test(name)) {
                const closeParen = findMatchingParen(source, bodyStartPos);
                if (closeParen === -1)
                    continue;
                let lineNo = 1;
                for (let i = 0; i < match.index; i++) {
                    if (source[i] === '\n')
                        lineNo++;
                }
                conciseBodyInsertions.push({ beforeParen: bodyStartPos, afterCloseParen: closeParen + 1, name, lineNo, propsExpr: buildPropsExpr() });
            }
        }
        else {
            // Block body: `const X = (props) => { ... }`
            const openBrace = bodyStartPos;
            const closeBrace = findClosingBrace(source, openBrace);
            if (closeBrace === -1)
                continue;
            funcInsertions.push({ position: closeBrace + 1, name, paramNames });
            // React component render tracking: uppercase arrow function in .tsx/.jsx
            if (isReactFile && /^[A-Z]/.test(name)) {
                let lineNo = 1;
                for (let i = 0; i < match.index; i++) {
                    if (source[i] === '\n')
                        lineNo++;
                }
                bodyInsertions.push({ position: openBrace + 1, name, lineNo, propsExpr: buildPropsExpr() });
            }
        }
    }
    // Match React.memo() and React.forwardRef() wrapped components
    // Pattern: const Name = (React.)?memo(  or  const Name = (React.)?forwardRef<T,P>(
    // Then scan forward to find the inner arrow => { body
    if (isReactFile) {
        const memoRefRegex = /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Z][a-zA-Z0-9_$]*)(?:\s*:\s*[^=]+?)?\s*=\s*(?:React\.)?(?:memo|forwardRef)\s*(?:<[^(]*>)?\s*\(/gm;
        let memoMatch;
        while ((memoMatch = memoRefRegex.exec(source)) !== null) {
            const name = memoMatch[1];
            // Position after the opening `(` of memo/forwardRef call
            const afterMemoOpen = memoMatch.index + memoMatch[0].length;
            // Scan forward to find `=> {` — the arrow body of the inner function.
            // We need to skip over the inner function's parameter list (which may contain nested parens).
            // Strategy: find the next `=>` that is followed by optional whitespace and `{`.
            let pos = afterMemoOpen;
            let arrowPos = -1;
            let parenDepth = 0;
            while (pos < source.length - 1) {
                const ch = source[pos];
                if (ch === '(')
                    parenDepth++;
                else if (ch === ')')
                    parenDepth--;
                else if (ch === '=' && source[pos + 1] === '>' && parenDepth <= 0) {
                    arrowPos = pos;
                    break;
                }
                pos++;
            }
            if (arrowPos === -1)
                continue;
            // Skip `=>` and whitespace to find `{`
            let bracePos = arrowPos + 2;
            while (bracePos < source.length && /[\s]/.test(source[bracePos]))
                bracePos++;
            if (source[bracePos] !== '{')
                continue;
            const openBrace = bracePos;
            const closeBrace = findClosingBrace(source, openBrace);
            if (closeBrace === -1)
                continue;
            // Extract the param list: everything between memo( and arrowPos
            const innerParamStr = source.slice(afterMemoOpen, arrowPos).trim();
            // innerParamStr is like `({ item, onSelect })` or `(props, ref)` or `props`
            let propsExpr = 'undefined';
            if (innerParamStr.startsWith('(')) {
                // Peel outer parens
                const inner = innerParamStr.slice(1, innerParamStr.lastIndexOf(')')).trim();
                if (inner.startsWith('{')) {
                    // Find the matching `}` of the destructuring pattern, ignoring any type annotation after it
                    let depth3 = 0, destructEnd = -1;
                    for (let i = 0; i < inner.length; i++) {
                        if (inner[i] === '{')
                            depth3++;
                        else if (inner[i] === '}') {
                            depth3--;
                            if (depth3 === 0) {
                                destructEnd = i;
                                break;
                            }
                        }
                    }
                    const destructPart = destructEnd !== -1 ? inner.slice(0, destructEnd + 1) : inner;
                    const fields = extractDestructuredNames(destructPart);
                    if (fields.length > 0)
                        propsExpr = `{ ${fields.join(', ')} }`;
                }
                else {
                    const firstParam = inner.split(',')[0].trim().split(':')[0].trim();
                    if (firstParam)
                        propsExpr = firstParam;
                }
            }
            else if (innerParamStr && /^[a-zA-Z_$]/.test(innerParamStr)) {
                propsExpr = innerParamStr.split(/[\s,:(]/)[0];
            }
            let lineNo = 1;
            for (let i = 0; i < memoMatch.index; i++) {
                if (source[i] === '\n')
                    lineNo++;
            }
            bodyInsertions.push({ position: openBrace + 1, name, lineNo, propsExpr });
        }
    }
    const hookInsertions = [];
    if (isReactFile) {
        // Match useEffect(, useMemo(, useCallback( — also handles React.useEffect(, etc.
        const hookCallRegex = /\b(useEffect|useMemo|useCallback)\s*\(/g;
        let hookMatch;
        while ((hookMatch = hookCallRegex.exec(source)) !== null) {
            const hookName = hookMatch[1];
            const afterParen = hookMatch.index + hookMatch[0].length;
            // Skip past optional 'async '
            let pos = afterParen;
            while (pos < source.length && (source[pos] === ' ' || source[pos] === '\t' || source[pos] === '\n'))
                pos++;
            if (source.slice(pos, pos + 6) === 'async ') {
                pos += 6;
                while (pos < source.length && (source[pos] === ' ' || source[pos] === '\t'))
                    pos++;
            }
            // Expect a callback: arrow fn `(` or `identifier =>` or `function`
            if (source[pos] !== '(' && !/^[a-zA-Z_$]/.test(source[pos]) && source.slice(pos, pos + 8) !== 'function')
                continue;
            // Find the opening `{` of the callback body depending on callback form:
            // 1. Arrow with parens: (x, y) => {  — call findFunctionBodyBrace from inside the (
            // 2. Named/anon function: function() {  — find the ( first
            // 3. Single identifier: props => {  — skip identifier, find =>, find {
            let callbackBodyBrace = -1;
            if (source[pos] === '(') {
                // Arrow function with param list: () => { ... } or (x) => { ... }
                callbackBodyBrace = findFunctionBodyBrace(source, pos + 1);
            }
            else if (source.slice(pos, pos + 8) === 'function') {
                // function() {} or function name() {}
                let funcPos = pos + 8;
                while (funcPos < source.length && /\s/.test(source[funcPos]))
                    funcPos++;
                if (/[a-zA-Z_$]/.test(source[funcPos])) {
                    while (funcPos < source.length && /[a-zA-Z0-9_$]/.test(source[funcPos]))
                        funcPos++;
                }
                while (funcPos < source.length && source[funcPos] !== '(')
                    funcPos++;
                if (funcPos < source.length) {
                    callbackBodyBrace = findFunctionBodyBrace(source, funcPos + 1);
                }
            }
            else {
                // Single identifier param: props => { ... }
                let idEnd = pos;
                while (idEnd < source.length && /[a-zA-Z0-9_$]/.test(source[idEnd]))
                    idEnd++;
                let arrowPos = idEnd;
                while (arrowPos < source.length && (source[arrowPos] === ' ' || source[arrowPos] === '\t'))
                    arrowPos++;
                if (source.slice(arrowPos, arrowPos + 2) === '=>') {
                    arrowPos += 2;
                    while (arrowPos < source.length && (source[arrowPos] === ' ' || source[arrowPos] === '\t' || source[arrowPos] === '\n'))
                        arrowPos++;
                    if (source[arrowPos] === '{')
                        callbackBodyBrace = arrowPos;
                }
            }
            if (callbackBodyBrace === -1)
                continue;
            // Verify nothing suspicious between pos and the `{` (no semicolons, no other hook calls)
            const between = source.slice(pos, callbackBodyBrace);
            if (between.includes(';') || /\buseEffect\b|\buseMemo\b|\buseCallback\b/.test(between))
                continue;
            const closeBrace = findClosingBrace(source, callbackBodyBrace);
            if (closeBrace === -1)
                continue;
            let lineNo = 1;
            for (let i = 0; i < hookMatch.index; i++) {
                if (source[i] === '\n')
                    lineNo++;
            }
            hookInsertions.push({ wrapStart: afterParen, wrapEnd: closeBrace + 1, hookName, lineNo });
        }
    }
    const stateInsertions = [];
    if (isReactFile) {
        const useStateRegex = /const\s+\[([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\]\s*=\s*(?:React\.)?useState\s*(?:<[^(]*>)?\s*\(/gm;
        let sm;
        while ((sm = useStateRegex.exec(source)) !== null) {
            const stateName = sm[1];
            const setterName = sm[2];
            // Find the position of setterName within the match (after the comma)
            const matchStr = sm[0];
            const commaIdx = matchStr.indexOf(',');
            const setterInMatch = matchStr.indexOf(setterName, commaIdx);
            if (setterInMatch === -1)
                continue;
            const renamePos = sm.index + setterInMatch;
            // Skip the useState(...) argument list to find the end of the statement
            let pos = sm.index + sm[0].length;
            let depth = 1;
            while (pos < source.length && depth > 0) {
                const ch = source[pos];
                if (ch === '(')
                    depth++;
                else if (ch === ')')
                    depth--;
                else if (ch === '"' || ch === "'" || ch === '`') {
                    const q = ch;
                    pos++;
                    while (pos < source.length && source[pos] !== q) {
                        if (source[pos] === '\\')
                            pos++;
                        pos++;
                    }
                }
                pos++;
            }
            // Skip to end of line (past semicolon or newline)
            while (pos < source.length && source[pos] !== ';' && source[pos] !== '\n')
                pos++;
            const afterLine = pos + 1;
            let lineNo = 1;
            for (let i = 0; i < sm.index; i++) {
                if (source[i] === '\n')
                    lineNo++;
            }
            stateInsertions.push({ renamePos, afterLine, stateName, setterName, lineNo });
        }
    }
    // Find import declarations for tracing (trace imported bindings after import statement)
    const importInsertions = traceVars ? findImportDeclarations(source) : [];
    // Find variable declarations for tracing
    const varInsertions = traceVars ? findVarDeclarations(source) : [];
    // Find destructured variable declarations for tracing
    const destructInsertions = traceVars ? findDestructuredDeclarations(source) : [];
    // Find variable reassignments for tracing
    const reassignInsertions = traceVars ? findReassignments(source) : [];
    // Find for-loop variable declarations for tracing
    const forLoopInsertions = traceVars ? findForLoopVars(source) : [];
    // Find catch clause variables for tracing
    const catchInsertions = traceVars ? findCatchVars(source) : [];
    // Find function parameter names for tracing
    const funcParamInsertions = traceVars ? findFunctionParams(source, isReactFile) : [];
    // Find JSX text expressions for tracing (React files only).
    // Skip if JSX has already been compiled to _jsxDEV/jsx/jsxs calls (e.g. by Vite's React plugin).
    // In that case, the `{` characters in the source are plain JS (function bodies, object literals)
    // and findJsxExpressions would corrupt them by injecting __trickle_tv() calls.
    const jsxAlreadyCompiled = /\b_?jsxDEV\b|\bjsxs?\s*\(/.test(source);
    const jsxExprInsertions = (traceVars && isReactFile && !jsxAlreadyCompiled) ? findJsxExpressions(source) : [];
    if (funcInsertions.length === 0 && importInsertions.length === 0 && varInsertions.length === 0 && destructInsertions.length === 0 && reassignInsertions.length === 0 && forLoopInsertions.length === 0 && catchInsertions.length === 0 && funcParamInsertions.length === 0 && jsxExprInsertions.length === 0 && bodyInsertions.length === 0 && hookInsertions.length === 0 && stateInsertions.length === 0 && conciseBodyInsertions.length === 0)
        return source;
    // Fix line numbers: Vite transforms (TypeScript stripping) may change line numbers.
    // Map transformed line numbers to original source line numbers.
    if (originalSource && originalSource !== source) {
        const origLines = originalSource.split('\n');
        // For each variable insertion, find the declaration in the original source
        for (const vi of varInsertions) {
            const origLine = findOriginalLine(origLines, vi.varName, vi.lineNo);
            if (origLine !== -1)
                vi.lineNo = origLine;
        }
        for (const di of destructInsertions) {
            // Use the first variable name to locate the line
            if (di.varNames.length > 0) {
                const origLine = findOriginalLineDestructured(origLines, di.varNames, di.lineNo);
                if (origLine !== -1)
                    di.lineNo = origLine;
            }
        }
        // Fix reassignment line numbers
        for (const ri of reassignInsertions) {
            const origLine = findOriginalLine(origLines, ri.varName, ri.lineNo);
            if (origLine !== -1)
                ri.lineNo = origLine;
        }
        // Fix for-loop var line numbers
        for (const fi of forLoopInsertions) {
            if (fi.varNames.length > 0) {
                // Search for 'for' keyword near the expected line
                const pattern = /\bfor\s*\(/;
                for (let delta = 0; delta <= 80; delta++) {
                    const fwd = fi.lineNo - 1 + delta;
                    if (fwd >= 0 && fwd < origLines.length && pattern.test(origLines[fwd])) {
                        fi.lineNo = fwd + 1;
                        break;
                    }
                    if (delta > 0 && delta <= 10) {
                        const bwd = fi.lineNo - 1 - delta;
                        if (bwd >= 0 && bwd < origLines.length && pattern.test(origLines[bwd])) {
                            fi.lineNo = bwd + 1;
                            break;
                        }
                    }
                }
            }
        }
        // Fix function param line numbers
        for (const fp of funcParamInsertions) {
            if (fp.paramNames.length > 0) {
                const pattern = /\bfunction\s+\w+\s*\(|=>\s*\{/;
                for (let delta = 0; delta <= 80; delta++) {
                    const fwd = fp.lineNo - 1 + delta;
                    if (fwd >= 0 && fwd < origLines.length && pattern.test(origLines[fwd])) {
                        fp.lineNo = fwd + 1;
                        break;
                    }
                    if (delta > 0 && delta <= 10) {
                        const bwd = fp.lineNo - 1 - delta;
                        if (bwd >= 0 && bwd < origLines.length && pattern.test(origLines[bwd])) {
                            fp.lineNo = bwd + 1;
                            break;
                        }
                    }
                }
            }
        }
    }
    // Build prefix — ALL imports first (ESM requires imports before any statements)
    const needsTracing = importInsertions.length > 0 || varInsertions.length > 0 || destructInsertions.length > 0 || reassignInsertions.length > 0 || forLoopInsertions.length > 0 || catchInsertions.length > 0 || funcParamInsertions.length > 0 || jsxExprInsertions.length > 0 || bodyInsertions.length > 0 || hookInsertions.length > 0 || stateInsertions.length > 0 || conciseBodyInsertions.length > 0;
    const importLines = [];
    if (isSSR) {
        // SSR/Node.js — import trickle-observe for function wrapping + file system for writing
        importLines.push(`import { wrapFunction as __trickle_wrapFn, configure as __trickle_configure } from 'trickle-observe';`);
        if (needsTracing) {
            importLines.push(`import { mkdirSync as __trickle_mkdirSync, appendFileSync as __trickle_appendFileSync } from 'node:fs';`, `import { join as __trickle_join } from 'node:path';`);
        }
    }
    // Browser mode: no imports needed — variable tracers are self-contained,
    // function wrapping is a no-op, and transport uses import.meta.hot
    const prefixLines = [...importLines];
    if (isSSR) {
        prefixLines.push(`__trickle_configure({ backendUrl: ${JSON.stringify(backendUrl)}, batchIntervalMs: 2000, debug: ${debug}, enabled: true, environment: 'node' });`, `function __trickle_wrap(fn, name, paramNames) {`, `  const opts = {`, `    functionName: name,`, `    module: ${JSON.stringify(moduleName)},`, `    trackArgs: true,`, `    trackReturn: true,`, `    sampleRate: 1,`, `    maxDepth: 5,`, `    environment: 'node',`, `    enabled: true,`, `  };`, `  if (paramNames && paramNames.length) opts.paramNames = paramNames;`, `  return __trickle_wrapFn(fn, opts);`, `}`);
    }
    else {
        // Browser mode: __trickle_wrap is a no-op (function wrapping uses Node.js APIs)
        prefixLines.push(`function __trickle_wrap(fn) { return fn; }`);
    }
    // Add unified __trickle_send() transport — browser uses HMR WebSocket, SSR uses fs
    if (needsTracing) {
        if (isSSR) {
            // SSR/Node.js mode — write directly to file system
            prefixLines.push(`let __trickle_varsFile = null;`, `function __trickle_send(line) {`, `  try {`, `    if (!__trickle_varsFile) {`, `      const dir = process.env.TRICKLE_LOCAL_DIR || __trickle_join(process.cwd(), '.trickle');`, `      try { __trickle_mkdirSync(dir, { recursive: true }); } catch(e) {}`, `      __trickle_varsFile = __trickle_join(dir, 'variables.jsonl');`, `    }`, `    __trickle_appendFileSync(__trickle_varsFile, line + '\\n');`, `  } catch(e) {}`, `}`);
        }
        else if (ingestUrl) {
            // Browser mode with fetch transport (Next.js client)
            prefixLines.push(`const __trickle_sendBuf = [];`, `let __trickle_sendTimer = null;`, `function __trickle_flush() {`, `  if (__trickle_sendBuf.length === 0) return;`, `  const lines = __trickle_sendBuf.join('\\n') + '\\n';`, `  __trickle_sendBuf.length = 0;`, `  try { fetch(${JSON.stringify(ingestUrl)}, { method: 'POST', body: lines, headers: { 'Content-Type': 'text/plain' } }).catch(function(){}); } catch(e) {}`, `}`, `function __trickle_send(line) {`, `  __trickle_sendBuf.push(line);`, `  if (!__trickle_sendTimer) {`, `    __trickle_sendTimer = setTimeout(function() { __trickle_sendTimer = null; __trickle_flush(); }, 300);`, `  }`, `}`);
        }
        else {
            // Browser mode — buffer and send via Vite HMR WebSocket
            prefixLines.push(`const __trickle_sendBuf = [];`, `let __trickle_sendTimer = null;`, `function __trickle_flush() {`, `  if (__trickle_sendBuf.length === 0) return;`, `  const lines = __trickle_sendBuf.join('\\n') + '\\n';`, `  __trickle_sendBuf.length = 0;`, `  try { if (import.meta.hot) import.meta.hot.send('trickle:vars', { lines }); } catch(e) {}`, `}`, `function __trickle_send(line) {`, `  __trickle_sendBuf.push(line);`, `  if (!__trickle_sendTimer) {`, `    __trickle_sendTimer = setTimeout(function() { __trickle_sendTimer = null; __trickle_flush(); }, 300);`, `  }`, `}`);
        }
    }
    // Add variable tracing if needed — inlined to avoid import resolution issues in Vite SSR.
    if (importInsertions.length > 0 || varInsertions.length > 0 || destructInsertions.length > 0 || reassignInsertions.length > 0 || forLoopInsertions.length > 0 || catchInsertions.length > 0 || funcParamInsertions.length > 0 || jsxExprInsertions.length > 0) {
        prefixLines.push(`if (!globalThis.__trickle_var_tracer) {`, `  const _cache = new Map();`, `  const _sampleCount = new Map();`, `  const _MAX_SAMPLES = 5;`, `  function _inferType(v, d) {`, `    if (d <= 0) return { kind: 'primitive', name: 'unknown' };`, `    if (v === null) return { kind: 'primitive', name: 'null' };`, `    if (v === undefined) return { kind: 'primitive', name: 'undefined' };`, `    const t = typeof v;`, `    if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint' || t === 'symbol') return { kind: 'primitive', name: t };`, `    if (t === 'function') return { kind: 'function' };`, `    if (Array.isArray(v)) { return v.length === 0 ? { kind: 'array', element: { kind: 'primitive', name: 'unknown' } } : { kind: 'array', element: _inferType(v[0], d-1) }; }`, `    if (t === 'object') {`, `      if (v instanceof Date) return { kind: 'object', properties: { __date: { kind: 'primitive', name: 'string' } } };`, `      if (v instanceof RegExp) return { kind: 'object', properties: { __regexp: { kind: 'primitive', name: 'string' } } };`, `      if (v instanceof Error) return { kind: 'object', properties: { __error: { kind: 'primitive', name: 'string' } } };`, `      if (v instanceof Promise) return { kind: 'promise', resolved: { kind: 'primitive', name: 'unknown' } };`, `      const props = {}; const keys = Object.keys(v).slice(0, 20);`, `      for (const k of keys) { try { props[k] = _inferType(v[k], d-1); } catch(e) { props[k] = { kind: 'primitive', name: 'unknown' }; } }`, `      return { kind: 'object', properties: props };`, `    }`, `    return { kind: 'primitive', name: 'unknown' };`, `  }`, `  function _sanitize(v, d) {`, `    if (d <= 0) return '[truncated]'; if (v === null || v === undefined) return v; const t = typeof v;`, `    if (t === 'string') return v.length > 100 ? v.substring(0, 100) + '...' : v;`, `    if (t === 'number' || t === 'boolean') return v; if (t === 'bigint') return String(v);`, `    if (t === 'function') return '[Function: ' + (v.name || 'anonymous') + ']';`, `    if (Array.isArray(v)) return v.slice(0, 20).map(i => _sanitize(i, d-1));`, `    if (t === 'object') { if (v instanceof Date) return v.toISOString(); if (v instanceof RegExp) return String(v); if (v instanceof Error) return { error: v.message }; if (v instanceof Promise) return '[Promise]';`, `      const r = {}; const keys = Object.keys(v).slice(0, 10); for (const k of keys) { try { r[k] = _sanitize(v[k], d-1); } catch(e) { r[k] = '[unreadable]'; } } return r; }`, `    return String(v);`, `  }`, `  globalThis.__trickle_var_tracer = function(v, n, l, mod, file) {`, `    try {`, `      const type = _inferType(v, 3);`, `      const th = JSON.stringify(type).substring(0, 32);`, `      const sample = _sanitize(v, 2);`, `      const sv = typeof v === 'object' && v !== null ? JSON.stringify(sample).substring(0, 60) : String(v).substring(0, 60);`, `      const ck = file + ':' + l + ':' + n;`, `      const cnt = _sampleCount.get(ck) || 0;`, `      if (cnt >= _MAX_SAMPLES) return;`, `      const prev = _cache.get(ck);`, `      const now = Date.now();`, `      if (prev && prev.sv === sv && now - prev.ts < 5000) return;`, `      _cache.set(ck, { sv: sv, ts: now });`, `      _sampleCount.set(ck, cnt + 1);`, `      __trickle_send(JSON.stringify({ kind: 'variable', varName: n, line: l, module: mod, file: file, type: type, typeHash: th, sample: sample }));`, `    } catch(e) {}`, `  };`, `}`, `function __trickle_tv(v, n, l) { try { globalThis.__trickle_var_tracer(v, n, l, ${JSON.stringify(moduleName)}, ${JSON.stringify(filename)}); } catch(e) {} }`);
    }
    // Add React component render tracker if needed
    if (bodyInsertions.length > 0 || conciseBodyInsertions.length > 0) {
        prefixLines.push(`if (!globalThis.__trickle_react_renders) { globalThis.__trickle_react_renders = new Map(); }`, `if (!globalThis.__trickle_react_prev_props) { globalThis.__trickle_react_prev_props = new Map(); }`, `function __trickle_rc(name, line, props) {`, `  try {`, `    const key = ${JSON.stringify(filename)} + ':' + line;`, `    const count = (globalThis.__trickle_react_renders.get(key) || 0) + 1;`, `    globalThis.__trickle_react_renders.set(key, count);`, `    const rec = { kind: 'react_render', file: ${JSON.stringify(filename)}, line: line, component: name, renderCount: count, timestamp: Date.now() / 1000 };`, `    if (props !== undefined && props !== null && typeof props === 'object') {`, `      try {`, `        const propKeys = Object.keys(props).filter(k => k !== 'children');`, `        const propSample = {};`, `        for (const k of propKeys.slice(0, 10)) {`, `          const v = props[k];`, `          const t = typeof v;`, `          if (t === 'string') propSample[k] = v.length > 40 ? v.slice(0, 40) + '...' : v;`, `          else if (t === 'number' || t === 'boolean') propSample[k] = v;`, `          else if (v === null || v === undefined) propSample[k] = v;`, `          else if (Array.isArray(v)) propSample[k] = '[arr:' + v.length + ']';`, `          else if (t === 'function') propSample[k] = '[fn]';`, `          else propSample[k] = '[object]';`, `        }`, `        rec.props = propSample;`, `        rec.propKeys = propKeys;`, `        const prevProps = globalThis.__trickle_react_prev_props.get(key);`, `        if (prevProps && count > 1) {`, `          const changedProps = [];`, `          const allKeys = new Set([...Object.keys(prevProps), ...Object.keys(propSample)]);`, `          for (const k of allKeys) {`, `            const prev = prevProps[k];`, `            const curr = propSample[k];`, `            if (String(prev) !== String(curr)) {`, `              changedProps.push({ key: k, from: prev, to: curr });`, `            }`, `          }`, `          if (changedProps.length > 0) rec.changedProps = changedProps;`, `        }`, `        globalThis.__trickle_react_prev_props.set(key, propSample);`, `      } catch(e2) {}`, `    }`, `    __trickle_send(JSON.stringify(rec));`, `  } catch(e) {}`, `}`);
    }
    // Add React hook tracker if needed
    if (hookInsertions.length > 0) {
        prefixLines.push(`if (!globalThis.__trickle_hook_counts) { globalThis.__trickle_hook_counts = new Map(); }`, `function __trickle_hw(hookName, line, cb) {`, `  return function(...args) {`, `    try {`, `      const key = ${JSON.stringify(filename)} + ':' + line + ':' + hookName;`, `      const n = (globalThis.__trickle_hook_counts.get(key) || 0) + 1;`, `      globalThis.__trickle_hook_counts.set(key, n);`, `      __trickle_send(JSON.stringify({ kind: 'react_hook', hookName, file: ${JSON.stringify(filename)}, line, invokeCount: n, timestamp: Date.now() / 1000 }));`, `    } catch(e) {}`, `    return cb(...args);`, `  };`, `}`);
    }
    // Add useState setter tracker if needed
    if (stateInsertions.length > 0) {
        prefixLines.push(`if (!globalThis.__trickle_state_counts) { globalThis.__trickle_state_counts = new Map(); }`, `function __trickle_ss(stateName, line, origSetter) {`, `  return function(newVal) {`, `    try {`, `      const key = ${JSON.stringify(filename)} + ':' + line + ':' + stateName;`, `      const n = (globalThis.__trickle_state_counts.get(key) || 0) + 1;`, `      globalThis.__trickle_state_counts.set(key, n);`, `      const t = typeof newVal;`, `      let sample;`, `      if (t === 'function') sample = '[fn updater]';`, `      else if (t === 'string') sample = newVal.length > 40 ? newVal.slice(0,40)+'...' : newVal;`, `      else if (t === 'number' || t === 'boolean') sample = newVal;`, `      else if (newVal === null || newVal === undefined) sample = newVal;`, `      else if (Array.isArray(newVal)) sample = '[arr:'+newVal.length+']';`, `      else sample = '[object]';`, `      __trickle_send(JSON.stringify({ kind: 'react_state', file: ${JSON.stringify(filename)}, line, stateName, updateCount: n, value: sample, timestamp: Date.now()/1000 }));`, `    } catch(e) {}`, `    return origSetter(newVal);`, `  };`, `}`);
    }
    prefixLines.push('');
    const prefix = prefixLines.join('\n');
    const allInsertions = [];
    for (const { position, name, paramNames } of funcInsertions) {
        const paramNamesArg = paramNames.length > 0 ? JSON.stringify(paramNames) : 'null';
        allInsertions.push({
            position,
            code: `\ntry{${name}=__trickle_wrap(${name},'${name}',${paramNamesArg})}catch(__e){}\n`,
        });
    }
    // Import insertions: trace imported bindings after the import statement
    for (const { lineEnd, varNames, lineNo } of importInsertions) {
        const calls = varNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo})`).join(';');
        allInsertions.push({
            position: lineEnd,
            code: `\n;try{${calls}}catch(__e){}\n`,
        });
    }
    for (const { lineEnd, varName, lineNo } of varInsertions) {
        allInsertions.push({
            position: lineEnd,
            code: `\n;try{__trickle_tv(${varName},${JSON.stringify(varName)},${lineNo})}catch(__e){}\n`,
        });
    }
    for (const { lineEnd, varNames, lineNo } of destructInsertions) {
        const calls = varNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo})`).join(';');
        allInsertions.push({
            position: lineEnd,
            code: `\n;try{${calls}}catch(__e){}\n`,
        });
    }
    // Reassignment insertions: trace after the reassignment statement
    for (const { lineEnd, varName, lineNo } of reassignInsertions) {
        allInsertions.push({
            position: lineEnd,
            code: `\n;try{__trickle_tv(${varName},${JSON.stringify(varName)},${lineNo})}catch(__e){}\n`,
        });
    }
    // Catch clause insertions: insert trace at start of catch body
    for (const { bodyStart, varNames, lineNo } of catchInsertions) {
        const calls = varNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo})`).join(';');
        allInsertions.push({
            position: bodyStart,
            code: `\ntry{${calls}}catch(__e2){}\n`,
        });
    }
    // For-loop variable insertions: insert trace at start of loop body
    for (const { bodyStart, varNames, lineNo } of forLoopInsertions) {
        const calls = varNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo})`).join(';');
        allInsertions.push({
            position: bodyStart,
            code: `\ntry{${calls}}catch(__e){}\n`,
        });
    }
    // Function parameter insertions: insert trace at start of function body
    for (const { bodyStart, paramNames, lineNo } of funcParamInsertions) {
        const calls = paramNames.map(n => `__trickle_tv(${n},${JSON.stringify(n)},${lineNo})`).join(';');
        allInsertions.push({
            position: bodyStart,
            code: `\ntry{${calls}}catch(__e){}\n`,
        });
    }
    // JSX expression insertions: wrap with comma operator to trace without changing value
    // {expr} → {(__trickle_tv(expr, "expr", lineNo), expr)}
    for (const { exprStart, exprEnd, exprText, lineNo } of jsxExprInsertions) {
        // Use a display name: truncate long expressions, use the raw text
        const displayName = exprText.length > 30 ? exprText.slice(0, 27) + '...' : exprText;
        allInsertions.push({
            position: exprStart,
            code: `(__trickle_tv(`,
        });
        allInsertions.push({
            position: exprEnd,
            code: `,${JSON.stringify(displayName)},${lineNo}),${exprText})`,
        });
    }
    for (const { position, name, lineNo, propsExpr } of bodyInsertions) {
        allInsertions.push({
            position,
            code: `\ntry{__trickle_rc(${JSON.stringify(name)},${lineNo},${propsExpr})}catch(__e){}\n`,
        });
    }
    // Hook insertions: each hook needs TWO insertions (wrapper start before callback, `)` after)
    for (const { wrapStart, wrapEnd, hookName, lineNo } of hookInsertions) {
        allInsertions.push({ position: wrapStart, code: `__trickle_hw(${JSON.stringify(hookName)},${lineNo},` });
        allInsertions.push({ position: wrapEnd, code: `)` });
    }
    // useState insertions: TWO insertions per useState
    // 1. Prefix setter name with '__trickle_s_' (rename in destructuring)
    // 2. After statement end, declare tracked wrapper: const setter = __trickle_ss(...)
    for (const { renamePos, afterLine, stateName, setterName, lineNo } of stateInsertions) {
        allInsertions.push({ position: renamePos, code: `__trickle_s_` });
        allInsertions.push({
            position: afterLine,
            code: `const ${setterName}=__trickle_ss(${JSON.stringify(stateName)},${lineNo},__trickle_s_${setterName});\n`,
        });
    }
    // Concise arrow body insertions: convert `=> (expr)` to `=> { try{__trickle_rc(...)} return (expr); }`
    // Two insertions per component: one before `(`, one after matching `)`
    for (const { beforeParen, afterCloseParen, name, lineNo, propsExpr } of conciseBodyInsertions) {
        allInsertions.push({
            position: beforeParen,
            code: `{ try{__trickle_rc(${JSON.stringify(name)},${lineNo},${propsExpr})}catch(__e){} return `,
        });
        allInsertions.push({
            position: afterCloseParen,
            code: `\n}`,
        });
    }
    // Sort by position descending (insert from end to preserve earlier positions)
    allInsertions.sort((a, b) => b.position - a.position);
    let result = source;
    for (const { position, code } of allInsertions) {
        result = result.slice(0, position) + code + result.slice(position);
    }
    // Preserve 'use client' / 'use server' directives — they must be the first expression
    // in the file (before any imports or code). Extract them from result and prepend before prefix.
    let directive = '';
    const directiveMatch = result.match(/^(\s*(?:'use client'|"use client"|'use server'|"use server")\s*;?\s*\n?)/);
    if (directiveMatch) {
        directive = directiveMatch[1];
        result = result.slice(directiveMatch[0].length);
    }
    return directive + prefix + result;
}
export default tricklePlugin;
