/**
 * Find the places in a TypeScript file where runtime types are worth recording,
 * and rewrite the file so each one reports its value.
 *
 * The same analysis is used twice: `instrument` adds the recording calls that
 * run, and `check.ts` adds type assertions to a shadow copy so the project's own
 * `tsc` can say whether what ran matches what was declared.
 *
 * Insertions never add line breaks, so line numbers in stack traces stay true.
 */
import ts from 'typescript';
import MagicString from 'magic-string';
import { hashText } from './common.js';

export type { Kind, Point } from './points.js';
export { decodePoints } from './points.js';
import type { Kind, Point } from './points.js';

/** Where a type assertion for a point can go in the shadow copy. */
export type CheckSite =
  | { at: 'insert'; pos: number }
  | { at: 'arrow'; start: number; end: number }
  | { at: 'none' };

export interface Site {
  point: Point;
  check: CheckSite;
  /** The expression to assert against: `typeof <name>` for variables and parameters. */
  ref?: string;
  /** Type parameters in scope: a declared type that mentions one has no concrete contract to check. */
  tps?: string[];
}

export interface Analysis {
  sites: Site[];
  /** Runtime edits. */
  wraps: Array<{ start: number; end: number; point: number }>;
  stmts: Array<{ pos: number; text: (id: (p: number) => string) => string; points: number[] }>;
  arrows: Array<{ start: number; end: number; params: number[]; names: string[]; ret?: number }>;
  preludePos: number;
}

export function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

type FnLike = ts.FunctionLikeDeclaration;

function isFunctionLike(n: ts.Node): n is FnLike {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n);
}

function isStatementList(n: ts.Node): boolean {
  return ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n);
}

function hasModifier(n: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === kind);
}

function isAmbient(n: ts.Node): boolean {
  for (let p: ts.Node | undefined = n; p; p = p.parent) {
    if (hasModifier(p, ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return false;
}

function functionName(fn: FnLike): string {
  if (ts.isConstructorDeclaration(fn)) {
    const cls = fn.parent;
    return (ts.isClassLike(cls) && cls.name ? cls.name.text : 'class') + '.constructor';
  }
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name) || ts.isPrivateIdentifier(fn.name))) {
    const own = fn.name.text;
    const cls = fn.parent;
    if ((ts.isMethodDeclaration(fn) || ts.isAccessor(fn)) && ts.isClassLike(cls) && cls.name) return `${cls.name.text}.${own}`;
    return own;
  }
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text;
  if (p && ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isBinaryExpression(p) && ts.isPropertyAccessExpression(p.left)) return p.left.name.text;
  return '(anonymous)';
}

function isFunctionOrClassExpr(e: ts.Expression): boolean {
  let x: ts.Expression = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
  return ts.isArrowFunction(x) || ts.isFunctionExpression(x) || ts.isClassExpression(x);
}

function bindingNames(name: ts.BindingName, out: ts.Identifier[] = []): ts.Identifier[] {
  if (ts.isIdentifier(name)) out.push(name);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  return out;
}

/** Position just after the leading directives ("use strict") of a body. */
function afterDirectives(stmts: ts.NodeArray<ts.Statement>, fallback: number): number {
  let pos = fallback;
  for (const s of stmts) {
    if (ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)) pos = s.end;
    else break;
  }
  return pos;
}

export function analyze(source: string, fileName: string): Analysis {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const sites: Site[] = [];
  const wraps: Analysis['wraps'] = [];
  const stmts: Analysis['stmts'] = [];
  const arrows: Analysis['arrows'] = [];

  const lc = (pos: number) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(pos);
    return { l: line + 1, c: character };
  };

  const typeParams: string[] = [];

  function addPoint(k: Kind, n: string, anchor: number, hint: number, extra: Partial<Point>, check: CheckSite, ref?: string): number {
    const a = lc(anchor), h = lc(hint);
    const point: Point = { i: sites.length, k, n, l: a.l, c: a.c, hl: h.l, hc: h.c, ...extra };
    const site: Site = ref ? { point, check, ref } : { point, check };
    if (typeParams.length) site.tps = [...new Set(typeParams)];
    sites.push(site);
    return point.i;
  }

  /** Where statements can be added at the start of a function body (after directives and a leading super()). */
  function bodyInsertPos(fn: FnLike): number | undefined {
    const body = fn.body;
    if (!body || !ts.isBlock(body)) return undefined;
    let pos = afterDirectives(body.statements, body.getStart(sf) + 1);
    if (ts.isConstructorDeclaration(fn) && ts.isClassLike(fn.parent) &&
        fn.parent.heritageClauses?.some((h) => h.token === ts.SyntaxKind.ExtendsKeyword)) {
      const sup = body.statements.find((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) &&
        s.expression.expression.kind === ts.SyntaxKind.SuperKeyword);
      if (!sup) return undefined; // super() is nested somewhere; leave this constructor alone
      pos = sup.end;
    }
    return pos;
  }

  const fnStack: Array<{ fn: FnLike; ret?: number }> = [];

  function visitFunction(fn: FnLike) {
    if (!fn.body || isAmbient(fn)) { ts.forEachChild(fn, visit); return; }
    const pushed = fn.typeParameters?.length ?? 0;
    for (const tp of fn.typeParameters ?? []) typeParams.push(tp.name.text);
    const name = functionName(fn);
    const isGen = !!fn.asteriskToken;
    const isAsync = hasModifier(fn, ts.SyntaxKind.AsyncKeyword);
    const insertPos = bodyInsertPos(fn);
    const exprArrow = ts.isArrowFunction(fn) && !ts.isBlock(fn.body);
    const checkSite: CheckSite = insertPos !== undefined ? { at: 'insert', pos: insertPos }
      : exprArrow ? { at: 'arrow', start: fn.body.getStart(sf), end: fn.body.end } : { at: 'none' };

    const paramPoints: number[] = [];
    const paramIds: ts.Identifier[] = [];
    if (insertPos !== undefined || exprArrow) {
      for (const p of fn.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === 'this') continue;
        for (const id of bindingNames(p.name)) {
          const direct = ts.isIdentifier(p.name);
          const hint = direct && p.type ? p.type.end : direct && p.questionToken ? p.questionToken.end : id.end;
          const extra: Partial<Point> = { fn: name };
          if (direct && p.type) extra.ann = 1;
          paramPoints.push(addPoint('p', id.text, id.getStart(sf), hint, extra, checkSite, `typeof ${id.text}`));
          paramIds.push(id);
        }
      }
    }

    // One return point per function, anchored at its name (or its start when anonymous).
    let ret: number | undefined;
    const voidish = fn.type && (fn.type.kind === ts.SyntaxKind.VoidKeyword ||
      (isAsync && ts.isTypeReferenceNode(fn.type) && fn.type.typeArguments?.[0]?.kind === ts.SyntaxKind.VoidKeyword));
    if (!isGen && !ts.isConstructorDeclaration(fn) && !ts.isSetAccessorDeclaration(fn) && !voidish) {
      const parent = fn.parent;
      const named = fn.name ?? ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent)) && ts.isIdentifier(parent.name) ? parent.name : undefined);
      const anchor = named ? named.getStart(sf) : fn.getStart(sf);
      let hint = fn.parameters.end;
      if (fn.type) hint = fn.type.end;
      else {
        const first = fn.parameters[0];
        const bare = ts.isArrowFunction(fn) && first && !/\(\s*$/.test(source.slice(fn.getStart(sf), first.getStart(sf)));
        const close = source.indexOf(')', fn.parameters.end);
        if (bare) hint = first.end;
        else if (close >= 0) hint = close + 1;
      }
      const extra: Partial<Point> = { fn: name };
      if (isAsync) extra.a = 1;
      if (fn.type) extra.ann = 1;
      // Only annotated returns can drift from a contract; unannotated ones are still recorded for display.
      // The declared return type, written in the body's scope. Type predicates and `asserts` are not contracts on a value.
      const declared = fn.type && !ts.isTypePredicateNode(fn.type) ? fn.type.getText(sf) : undefined;
      const ref = declared && (isAsync ? `Awaited<${declared}>` : `(${declared})`);
      ret = addPoint('r', name, anchor, hint, extra, ref ? checkSite : { at: 'none' }, ref);
    }

    if (insertPos !== undefined && paramPoints.length) {
      const ids = paramIds.map((x) => x.text);
      const pts = paramPoints.slice();
      stmts.push({ pos: insertPos, points: pts, text: (id) => pts.map((p, j) => `${id(p)}(${p},${ids[j]});`).join('') });
    }
    if (exprArrow) {
      arrows.push({ start: fn.body.getStart(sf), end: fn.body.end, params: paramPoints, names: paramIds.map((x) => x.text), ret });
    }

    fnStack.push({ fn, ret });
    ts.forEachChild(fn, visit);
    fnStack.pop();
    typeParams.length -= pushed;
  }

  function visit(node: ts.Node): void {
    if (isFunctionLike(node)) return visitFunction(node);
    if (ts.isClassLike(node) && node.typeParameters?.length) {
      const pushed = node.typeParameters.length;
      for (const tp of node.typeParameters) typeParams.push(tp.name.text);
      ts.forEachChild(node, visit);
      typeParams.length -= pushed;
      return;
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) return;
    if (ts.isModuleDeclaration(node) && isAmbient(node)) return;

    if (ts.isReturnStatement(node) && node.expression) {
      const top = fnStack[fnStack.length - 1];
      if (top?.ret !== undefined) wraps.push({ start: node.expression.getStart(sf), end: node.expression.end, point: top.ret });
    }

    if (ts.isVariableStatement(node) && isAmbient(node)) return;

    const scoped = node.flags & ts.NodeFlags.BlockScoped;
    const isUsing = scoped === ts.NodeFlags.Using || scoped === ts.NodeFlags.AwaitUsing;
    if (ts.isVariableDeclarationList(node) && !isUsing) {
      const loop = node.parent;
      const inForOf = ts.isForOfStatement(loop) || ts.isForInStatement(loop);
      const inFor = ts.isForStatement(loop);
      const stmt = ts.isVariableStatement(loop) ? loop : undefined;
      const fn = fnStack[fnStack.length - 1]?.fn;
      const fnName = fn ? functionName(fn) : undefined;
      for (const decl of node.declarations) {
        const loopBody = inForOf || inFor ? (loop as ts.IterationStatement).statement : undefined;
        // A `for (let i = ...; cond; ...)` variable is narrowed by the condition inside the body, so it is not checked.
        const checkSite: CheckSite = inFor ? { at: 'none' }
          : loopBody && ts.isBlock(loopBody) ? { at: 'insert', pos: loopBody.getStart(sf) + 1 }
          : stmt && isStatementList(stmt.parent) ? { at: 'insert', pos: stmt.end } : { at: 'none' };
        const extra = (ann: boolean): Partial<Point> => {
          const e: Partial<Point> = {};
          if (fnName) e.fn = fnName;
          if (ann) e.ann = 1;
          return e;
        };
        if (ts.isIdentifier(decl.name) && !inForOf) {
          if (!decl.initializer || isFunctionOrClassExpr(decl.initializer)) continue;
          const hint = decl.type ? decl.type.end : decl.name.end;
          const p = addPoint('v', decl.name.text, decl.name.getStart(sf), hint, extra(!!decl.type), checkSite, `typeof ${decl.name.text}`);
          wraps.push({ start: decl.initializer.getStart(sf), end: decl.initializer.end, point: p });
        } else {
          // Destructuring, or the variable of a for-of/for-in loop: record each bound name after it is bound.
          const ids = bindingNames(decl.name);
          let pos: number | undefined;
          if (inForOf && loopBody && ts.isBlock(loopBody)) pos = loopBody.getStart(sf) + 1;
          else if (stmt && isStatementList(stmt.parent)) pos = stmt.end;
          if (pos === undefined || ids.length === 0) continue;
          const pts = ids.map((id) => addPoint('v', id.text, id.getStart(sf), id.end, extra(!!decl.type), checkSite, `typeof ${id.text}`));
          const names = ids.map((x) => x.text);
          const lead = stmt ? ';' : '';
          stmts.push({ pos, points: pts, text: (id) => lead + pts.map((p, j) => `${id(p)}(${p},${names[j]});`).join('') });
        }
      }
    }

    // `x = value` as a statement.
    if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) &&
        node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.expression.left) &&
        !isFunctionOrClassExpr(node.expression.right)) {
      const left = node.expression.left;
      const fn = fnStack[fnStack.length - 1]?.fn;
      const extra: Partial<Point> = fn ? { fn: functionName(fn) } : {};
      const checkSite: CheckSite = isStatementList(node.parent) ? { at: 'insert', pos: node.end } : { at: 'none' };
      const p = addPoint('v', left.text, left.getStart(sf), left.end, extra, checkSite, `typeof ${left.text}`);
      wraps.push({ start: node.expression.right.getStart(sf), end: node.expression.right.end, point: p });
    }

    // catch (e) { ... }
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
      const id = node.variableDeclaration.name;
      const fn = fnStack[fnStack.length - 1]?.fn;
      const extra: Partial<Point> = fn ? { fn: functionName(fn) } : {};
      const p = addPoint('v', id.text, id.getStart(sf), id.end, extra, { at: 'none' });
      const name = id.text;
      stmts.push({ pos: node.block.getStart(sf) + 1, points: [p], text: (fid) => `${fid(p)}(${p},${name});` });
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sf, visit);

  let preludePos = 0;
  if (source.startsWith('#!')) preludePos = source.indexOf('\n') + 1 || source.length;
  preludePos = Math.max(preludePos, afterDirectives(sf.statements, preludePos));
  return { sites, wraps, stmts, arrows, preludePos };
}

export interface InstrumentResult {
  code: string;
  map: ReturnType<MagicString['generateMap']>;
  points: Point[];
}

/**
 * Rewrite `source` so every point reports its value through `__tt(point, value)`.
 * `fileKey` is the path that observations are filed under (relative to the project root).
 */
export function instrument(source: string, fileName: string, fileKey: string): InstrumentResult | null {
  const a = analyze(source, fileName);
  if (a.sites.length === 0) return null;
  const s = new MagicString(source);
  const id = () => '__tt';
  for (const w of a.wraps) {
    s.appendRight(w.start, `__tt(${w.point},(`);
    s.prependLeft(w.end, '))');
  }
  for (const st of a.stmts) s.appendRight(st.pos, st.text(id));
  for (const ar of a.arrows) {
    const pre = ar.params.map((p, j) => `__tt(${p},${ar.names[j]}),`).join('');
    if (ar.ret !== undefined) {
      s.appendRight(ar.start, `(${pre}__tt(${ar.ret},(`);
      s.prependLeft(ar.end, ')))');
    } else if (pre) {
      s.appendRight(ar.start, `(${pre}(`);
      s.prependLeft(ar.end, '))');
    }
  }
  const points = a.sites.map((x) => x.point);
  const meta = JSON.stringify(points.map((p) => [p.k, p.n, p.l, p.c, p.hl, p.hc, p.fn ?? '', (p.a ? 1 : 0) | (p.ann ? 2 : 0)]));
  // Hoisted function declarations, so modules caught in an import cycle can call them before the body runs.
  // `var __tf` is hoisted too; the handle is looked up on first use, so there is one Map lookup per module.
  const prelude = `var __tf;function __tt(i,v){if(__tf===undefined){var t=globalThis.__trickle;` +
    `__tf=t?t.f(${JSON.stringify(fileKey)},${JSON.stringify(hashText(source))},__ttm):null}return __tf?__tf.o(i,v):v}` +
    `function __ttm(){return ${meta}};`;
  if (a.preludePos === 0) s.prepend(prelude);
  else s.appendLeft(a.preludePos, prelude);
  return { code: s.toString(), map: s.generateMap({ hires: 'boundary', source: fileName, includeContent: true }), points };
}
