/**
 * Source-transform helpers used by observe-register to inject
 * __trickle_tv traces and locate function bodies.
 *
 * Extracted from the former Vite plugin so Node's Module._compile
 * path can instrument any JS/TS codebase without framework plugins.
 */

/**
 * Find the opening brace of a function body, skipping the parameter list.
 * Starting from the character right after the opening `(` of the parameter list,
 * scans forward matching parens to find the closing `)`, then finds the `{` after it.
 * Returns -1 if not found.
 */
export function findFunctionBodyBrace(source: string, afterOpenParen: number): number {
  let depth = 1;
  let pos = afterOpenParen;
  // Skip the parameter list (matching parens)
  while (pos < source.length && depth > 0) {
    const ch = source[pos];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) break; }
    else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      pos++;
      while (pos < source.length && source[pos] !== quote) {
        if (source[pos] === '\\') pos++;
        pos++;
      }
    }
    pos++;
  }
  // Now find the `{` after the closing `)`
  while (pos < source.length) {
    const ch = source[pos];
    if (ch === '{') return pos;
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
 * Extract variable names from a destructuring pattern.
 * Handles: { a, b, c: d } → ['a', 'b', 'd']  (renamed vars use the local name)
 * Handles: [a, b, ...rest] → ['a', 'b', 'rest']
 * Handles: { a: { b, c } } → ['b', 'c']  (nested destructuring)
 */
function extractDestructuredNames(pattern: string): string[] {
  const names: string[] = [];
  // Remove outer braces/brackets
  const inner = pattern.slice(1, -1).trim();
  if (!inner) return names;

  // Split by commas at depth 0
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

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
      } else {
        // Rename: key: localName — extract localName (skip if it has another colon for type annotation)
        const localName = afterColon.split(/[\s=]/)[0].trim();
        if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(localName)) {
          names.push(localName);
        }
      }
    } else {
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
 * Find class body ranges in source code. Handles both:
 *   class Foo { ... }
 *   var Foo = class { ... }
 * Returns an array of [start, end] positions (inclusive of braces).
 */
export function findClassBodyRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // Match both class declarations and class expressions
  const classRegex = /\bclass\s*(?:[a-zA-Z_$][a-zA-Z0-9_$]*)?\s*(?:extends\s+[a-zA-Z_$.[\]]+\s*)?\{/g;
  let m;
  while ((m = classRegex.exec(source)) !== null) {
    const openBrace = source.indexOf('{', m.index + 5); // skip past 'class'
    if (openBrace === -1) continue;
    // Find matching close brace
    let depth = 1;
    let pos = openBrace + 1;
    while (pos < source.length && depth > 0) {
      const ch = source[pos];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
      else if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch; pos++;
        while (pos < source.length) {
          if (source[pos] === '\\') pos++;
          else if (source[pos] === q) break;
          else if (q === '`' && source[pos] === '$' && source[pos + 1] === '{') {
            pos += 2; let td = 1;
            while (pos < source.length && td > 0) {
              if (source[pos] === '{') td++;
              else if (source[pos] === '}') td--;
              pos++;
            }
            continue;
          }
          pos++;
        }
      } else if (ch === '/' && source[pos + 1] === '/') {
        while (pos < source.length && source[pos] !== '\n') pos++;
      } else if (ch === '/' && source[pos + 1] === '*') {
        pos += 2;
        while (pos < source.length - 1 && !(source[pos] === '*' && source[pos + 1] === '/')) pos++;
        pos++;
      }
      pos++;
    }
    if (depth === 0) ranges.push([openBrace, pos]);
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
export function findReassignments(source: string): Array<{ lineEnd: number; varName: string; lineNo: number }> {
  const results: Array<{ lineEnd: number; varName: string; lineNo: number }> = [];
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
    if (varName.startsWith('__trickle') || varName.startsWith('_$')) continue;
    // Skip common non-variable patterns
    if (varName === '_a' || varName === '_b' || varName === '_c') continue;
    // Skip 'this', 'self', 'super' (not reassignable in practice)
    if (varName === 'this' || varName === 'super') continue;
    // Skip TS compiler helpers and module internals
    if (varName === 'ownKeys' || varName === 'desc') continue;
    // Skip React Refresh / HMR internals and discard variables
    if (varName === 'prevRefreshReg' || varName === 'prevRefreshSig' || varName === 'inWebWorker') continue;
    if (varName === '_s' || varName === '_c2' || varName === '_s2' || varName === '_') continue;
    // Skip keywords that could look like identifiers
    if (['if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default', 'return', 'throw',
         'break', 'continue', 'try', 'catch', 'finally', 'new', 'delete', 'typeof', 'void',
         'yield', 'await', 'class', 'extends', 'import', 'export', 'from', 'as', 'of', 'in',
         'const', 'let', 'var', 'function', 'true', 'false', 'null', 'undefined'].includes(varName)) continue;

    // Check that this line doesn't start with const/let/var (would be a declaration, already handled)
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    const linePrefix = source.slice(lineStart, match.index + match[1].length).trim();
    if (/^(export\s+)?(const|let|var)\s/.test(source.slice(lineStart).trimStart())) continue;

    // Skip class field declarations (e.g., `tasks = []` inside a class body)
    // Inserting trace calls inside class bodies causes SyntaxError
    if (classRanges.some(([start, end]) => match!.index > start && match!.index < end)) continue;

    // Skip if this looks like a property in an object literal (preceded by a key: pattern on same line)
    // or if it's a label (label: ...)
    const beforeOnLine = source.slice(lineStart, match.index).trim();
    if (beforeOnLine.endsWith(':') || beforeOnLine.endsWith(',')) continue;

    // Skip comma-separated multi-variable declaration continuations:
    //   var X = 'foo',
    //       Y = 'bar';  ← Y looks like a reassignment but is actually a declaration
    // Detect by checking if the previous non-empty line ends with ','
    if (beforeOnLine.length === 0) {
      const prevLineEnd = source.lastIndexOf('\n', lineStart - 1);
      if (prevLineEnd >= 0) {
        const prevLine = source.slice(source.lastIndexOf('\n', prevLineEnd - 1) + 1, prevLineEnd).trimEnd();
        if (prevLine.endsWith(',')) continue;
      }
    }

    // Calculate line number
    let lineNo = 1;
    for (let i = 0; i < match.index; i++) {
      if (source[i] === '\n') lineNo++;
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
      } else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth < 0) break;
      } else if (ch === ';' && depth === 0) {
        foundEnd = pos;
        break;
      } else if (ch === '\n' && depth === 0) {
        const nextNonWs = source.slice(pos + 1).match(/^\s*(\S)/);
        if (nextNonWs && !'.+=-|&?:,'.includes(nextNonWs[1])) {
          // Check if a recent non-empty line ends with an operator
          let checkPos2 = pos;
          let lastCh2 = '';
          for (let back = 0; back < 5; back++) {
            const prevNL2 = source.lastIndexOf('\n', checkPos2 - 1);
            const prevLine2 = source.slice(prevNL2 + 1, checkPos2).trimEnd();
            if (prevLine2.length > 0) { lastCh2 = prevLine2[prevLine2.length - 1]; break; }
            checkPos2 = prevNL2;
            if (prevNL2 <= 0) break;
          }
          if (lastCh2 && '=+-*/%&|^~<>?:,({['.includes(lastCh2)) {
            pos++; continue;
          }
          foundEnd = pos;
          break;
        }
      } else if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        pos++;
        while (pos < source.length) {
          if (source[pos] === '\\') { pos++; }
          else if (source[pos] === quote) break;
          pos++;
        }
      } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] !== '/' && source[pos + 1] !== '*') {
        // Possible regex literal
        let rp = pos - 1;
        while (rp >= 0 && (source[rp] === ' ' || source[rp] === '\t')) rp--;
        const rpCh = rp >= 0 ? source[rp] : '';
        if ('=(!,;:?[{&|^~+-><%'.includes(rpCh) || source.slice(Math.max(0, rp - 5), rp + 1).match(/\b(return|typeof|instanceof|in|of|void|delete|throw|new|case)\s*$/)) {
          pos++;
          while (pos < source.length) {
            if (source[pos] === '\\') pos++;
            else if (source[pos] === '[') { pos++; while (pos < source.length && source[pos] !== ']') { if (source[pos] === '\\') pos++; pos++; } }
            else if (source[pos] === '/') break;
            pos++;
          }
          while (pos + 1 < source.length && /[gimsuy]/.test(source[pos + 1])) pos++;
        }
      } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '/') {
        while (pos < source.length && source[pos] !== '\n') pos++;
        continue;
      } else if (ch === '/' && pos + 1 < source.length && source[pos + 1] === '*') {
        pos += 2;
        while (pos < source.length - 1 && !(source[pos] === '*' && source[pos + 1] === '/')) pos++;
        pos++;
      }
      pos++;
    }

    if (foundEnd === -1) continue;
    results.push({ lineEnd: foundEnd + 1, varName, lineNo });
  }

  return results;
}

/**
 * Find catch clause variables and return insertions for tracing.
 * Handles: catch (err) { ... } → trace err at start of catch body.
 */
export function findCatchVars(source: string): Array<{ bodyStart: number; varNames: string[]; lineNo: number }> {
  const results: Array<{ bodyStart: number; varNames: string[]; lineNo: number }> = [];
  const catchRegex = /\bcatch\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?::\s*[^)]+?)?\s*\)\s*\{/g;
  let match;

  while ((match = catchRegex.exec(source)) !== null) {
    const varName = match[1];
    if (varName.startsWith('__trickle')) continue;

    const bodyBrace = match.index + match[0].length - 1;
    let lineNo = 1;
    for (let i = 0; i < match.index; i++) {
      if (source[i] === '\n') lineNo++;
    }

    results.push({ bodyStart: bodyBrace + 1, varNames: [varName], lineNo });
  }

  return results;
}

export function findForLoopVars(source: string): Array<{ bodyStart: number; varNames: string[]; lineNo: number }> {
  const results: Array<{ bodyStart: number; varNames: string[]; lineNo: number }> = [];

  // Match: for (const/let/var ...
  const forRegex = /\bfor\s*\(/g;
  let match;

  while ((match = forRegex.exec(source)) !== null) {
    const afterParen = match.index + match[0].length;

    // Skip whitespace
    let pos = afterParen;
    while (pos < source.length && /\s/.test(source[pos])) pos++;

    // Expect const/let/var
    const declMatch = source.slice(pos).match(/^(const|let|var)\s+/);
    if (!declMatch) continue;
    pos += declMatch[0].length;

    // Now we have the variable pattern — could be identifier, {destructure}, or [destructure]
    const varNames: string[] = [];
    const patternStart = pos;

    if (source[pos] === '{' || source[pos] === '[') {
      // Destructured: find matching brace/bracket
      const open = source[pos];
      const close = open === '{' ? '}' : ']';
      let depth = 1;
      let end = pos + 1;
      while (end < source.length && depth > 0) {
        if (source[end] === open) depth++;
        else if (source[end] === close) depth--;
        end++;
      }
      const pattern = source.slice(pos, end);
      const names = extractDestructuredNames(pattern);
      varNames.push(...names);
      pos = end;
    } else {
      // Simple identifier
      const idMatch = source.slice(pos).match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (!idMatch) continue;
      varNames.push(idMatch[1]);
      pos += idMatch[0].length;
    }

    if (varNames.length === 0) continue;

    // Skip trickle internals
    if (varNames.every(n => n.startsWith('__trickle') || n === '_a' || n === '_b' || n === '_c')) continue;

    // Now find the opening `{` of the loop body
    // Skip everything until the `)` that closes the for(...)
    let parenDepth = 1; // We're inside the for(
    while (pos < source.length && parenDepth > 0) {
      const ch = source[pos];
      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
      else if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch; pos++;
        while (pos < source.length && source[pos] !== q) {
          if (source[pos] === '\\') pos++;
          pos++;
        }
      }
      pos++;
    }

    // Now find the `{` after the closing `)`
    while (pos < source.length && /\s/.test(source[pos])) pos++;
    if (pos >= source.length || source[pos] !== '{') continue;

    const bodyBrace = pos;

    // Calculate line number
    let lineNo = 1;
    for (let i = 0; i < match.index; i++) {
      if (source[i] === '\n') lineNo++;
    }

    results.push({ bodyStart: bodyBrace + 1, varNames: varNames.filter(n => !n.startsWith('__trickle')), lineNo });
  }

  return results;
}
