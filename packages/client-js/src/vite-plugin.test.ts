/**
 * Unit tests for the Vite plugin transform (React component tracking).
 *
 * Run with: node --experimental-strip-types --test src/vite-plugin.test.ts
 * Or after build: node --test dist/vite-plugin.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tricklePlugin } from '../dist/vite-plugin.js';

// Helper: transform code as if it came from a .tsx file
function transformTsx(code: string): string | null {
  const plugin = tricklePlugin({ debug: false, traceVars: false });
  const result = plugin.transform(code, '/test/App.tsx');
  return result ? result.code : null;
}

function transformTs(code: string): string | null {
  const plugin = tricklePlugin({ debug: false, traceVars: false });
  const result = plugin.transform(code, '/test/util.ts');
  return result ? result.code : null;
}

// ── React file detection ─────────────────────────────────────────────────────

describe('React file detection', () => {
  it('tracks uppercase components in .tsx files', () => {
    const code = `function UserCard(props) { return null; }`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes('__trickle_rc'), 'should inject render tracker');
  });

  it('does not inject render tracker for .ts files', () => {
    const code = `function UserCard(props) { return null; }`;
    const out = transformTs(code);
    // May still transform for function wrapping, but not for render tracking
    if (out) {
      assert.ok(!out.includes('__trickle_rc'), 'should NOT inject render tracker in .ts files');
    }
  });

  it('does not track lowercase functions as components', () => {
    const code = `function helper(x) { return x + 1; }`;
    const out = transformTsx(code);
    if (out) {
      assert.ok(!out.includes('__trickle_rc'), 'lowercase function should not be tracked');
    }
  });
});

// ── Props capture: function declarations ─────────────────────────────────────

describe('Props capture — function declarations', () => {
  it('uses arguments[0] for simple param: function Component(props)', () => {
    const code = `function MyComponent(props) { return null; }`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes('arguments[0]'), 'should pass arguments[0] as props');
  });

  it('uses arguments[0] for destructured param: function Component({ name })', () => {
    const code = `function UserCard({ name, age }) { return null; }`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes('arguments[0]'), 'should pass arguments[0] for destructured params');
  });

  it('injects __trickle_rc call at start of function body', () => {
    const code = `function MyComponent(props) {\n  const x = 1;\n  return null;\n}`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    // __trickle_rc should appear before body statements
    const rcIdx = out!.indexOf('__trickle_rc');
    const bodyIdx = out!.indexOf('const x = 1');
    assert.ok(rcIdx !== -1, '__trickle_rc should be present');
    assert.ok(bodyIdx !== -1, 'body code should be present');
    assert.ok(rcIdx < bodyIdx, '__trickle_rc should come before body statements');
  });

  it('includes correct component name and line in __trickle_rc call', () => {
    const code = `function UserCard(props) { return null; }`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes('"UserCard"'), 'should include component name');
    assert.ok(out!.includes('__trickle_rc("UserCard"'), 'should call with component name');
  });
});

// ── Props capture: arrow function components ──────────────────────────────────

describe('Props capture — arrow function components', () => {
  it('uses single param name for simple arrow: const C = (props) => {}', () => {
    const code = `const Dashboard = (props) => { return null; };`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes('__trickle_rc'), 'should inject render tracker');
    // props should be the param variable, not arguments[0]
    assert.ok(out!.includes('__trickle_rc("Dashboard"'), 'should use component name');
    // should NOT use arguments[0] for arrow functions
    const rcCall = out!.match(/__trickle_rc\("Dashboard",[^)]+\)/);
    assert.ok(rcCall, 'should have __trickle_rc call');
    assert.ok(!rcCall![0].includes('arguments[0]'), 'arrow functions should not use arguments[0]');
  });

  it('reconstructs object for destructured arrow: const C = ({ a, b }) => {}', () => {
    const code = `const Counter = ({ count, label }) => { return null; };`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes('__trickle_rc'), 'should inject render tracker');
    // Should reconstruct { count, label }
    const rcCall = out!.match(/__trickle_rc\("Counter",[^,]+,([^)]+)\)/);
    if (rcCall) {
      assert.ok(
        rcCall[1].includes('count') && rcCall[1].includes('label'),
        'should reconstruct props object from destructured fields',
      );
    }
  });

  it('handles TypeScript type annotations in destructured props: const C = ({ a }: Props) => {}', () => {
    const code = `const Form = ({ onSubmit, title }: FormProps) => { return null; };`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes('__trickle_rc'), 'should inject render tracker');
    // Should capture onSubmit and title, not include ': FormProps' in prop names
    const rcCall = out!.match(/__trickle_rc\("Form",[^,]+,([^)]+)\)/);
    if (rcCall) {
      assert.ok(rcCall[1].includes('onSubmit'), 'should include onSubmit in props');
      assert.ok(rcCall[1].includes('title'), 'should include title in props');
      assert.ok(!rcCall[1].includes('FormProps'), 'should NOT include type annotation');
    }
  });

  it('handles rest spread in destructured props: const C = ({ a, ...rest }) => {}', () => {
    const code = `const Card = ({ children, ...props }: CardProps) => { return null; };`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    if (out!.includes('__trickle_rc')) {
      assert.ok(out!.includes('children'), 'should include children');
      assert.ok(out!.includes('props'), 'should include rest spread as props');
    }
  });

  it('passes undefined for no-param arrow: const C = () => {}', () => {
    const code = `const NoProps = () => { return null; };`;
    const out = transformTsx(code);
    if (out && out.includes('__trickle_rc')) {
      assert.ok(out.includes('undefined'), 'should pass undefined for no-param component');
    }
  });
});

// ── render count tracking ─────────────────────────────────────────────────────

describe('Render count tracking', () => {
  it('includes react_render kind in emitted record code', () => {
    const code = `function Card(props) { return null; }`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes("'react_render'"), 'emitted record should have kind react_render');
  });

  it('includes props data in emitted record', () => {
    const code = `function Card(props) { return null; }`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes('rec.props'), 'should capture props onto the record');
    assert.ok(out!.includes('propKeys'), 'should include propKeys');
  });

  it('tracks multiple components in one file', () => {
    const code = [
      `function Header(props) { return null; }`,
      `function Footer(props) { return null; }`,
      `function helper(x) { return x; }`,
    ].join('\n');
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes('"Header"'), 'should track Header');
    assert.ok(out!.includes('"Footer"'), 'should track Footer');
    // helper should not be tracked as a component
    const rcCalls = out!.match(/__trickle_rc\("helper"/g);
    assert.ok(!rcCalls, 'lowercase helper should not be tracked');
  });
});

// ── findFunctionBodyBrace — destructured params don't confuse brace finding ───

describe('Correct function body brace detection', () => {
  it('finds body brace even with destructured object params', () => {
    const code = `function Form({ onSubmit, title }) {\n  const x = 1;\n  return null;\n}`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    // __trickle_rc should be INSIDE the function body (before 'const x = 1')
    const rcIdx = out!.indexOf('__trickle_rc');
    const bodyIdx = out!.indexOf('const x = 1');
    assert.ok(rcIdx < bodyIdx, 'render tracker must be inside the function body, before first statement');
    // The wrap insertion (Form=__trickle_wrap(...)) should be AFTER the function body
    const wrapIdx = out!.indexOf('Form=__trickle_wrap');
    assert.ok(wrapIdx > bodyIdx, 'function wrap should be after the function body');
  });
});

// ── React hook observability ──────────────────────────────────────────────────

describe('React hook observability', () => {
  it('wraps useEffect callback with __trickle_hw', () => {
    const code = `function App() {\n  useEffect(() => {\n    console.log('hi');\n  }, []);\n  return null;\n}`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes('__trickle_hw'), 'should inject hook wrapper');
    assert.ok(out!.includes('"useEffect"'), 'should include hook name');
  });

  it('wraps useMemo callback with __trickle_hw', () => {
    const code = `function App() {\n  const val = useMemo(() => {\n    return expensive();\n  }, [dep]);\n  return null;\n}`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes('__trickle_hw'), 'should inject hook wrapper');
    assert.ok(out!.includes('"useMemo"'), 'should include hook name');
  });

  it('wraps useCallback callback with __trickle_hw', () => {
    const code = `function App() {\n  const fn = useCallback(() => {\n    doSomething();\n  }, [dep]);\n  return null;\n}`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes('__trickle_hw'), 'should inject hook wrapper');
    assert.ok(out!.includes('"useCallback"'), 'should include hook name');
  });

  it('wraps all three hook types in the same component', () => {
    const code = [
      `function Dashboard() {`,
      `  useEffect(() => { fetch('/api'); }, []);`,
      `  const data = useMemo(() => { return transform(raw); }, [raw]);`,
      `  const handler = useCallback(() => { handleClick(); }, []);`,
      `  return null;`,
      `}`,
    ].join('\n');
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    const hwCount = (out!.match(/__trickle_hw/g) || []).length;
    // preamble definition + 3 call sites = 4 occurrences
    assert.ok(hwCount >= 4, `should have at least 4 __trickle_hw occurrences (preamble + 3 wraps), got ${hwCount}`);
  });

  it('includes react_hook kind in emitted record code', () => {
    const code = `function App() {\n  useEffect(() => {\n    console.log('hi');\n  }, []);\n  return null;\n}`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes("'react_hook'"), 'emitted record should have kind react_hook');
  });

  it('does NOT inject hook tracking in .ts files', () => {
    const code = `function helper() {\n  useEffect(() => { doStuff(); }, []);\n  return null;\n}`;
    const out = transformTs(code);
    if (out) {
      assert.ok(!out.includes('__trickle_hw'), 'should NOT inject hook tracker in .ts files');
    }
  });

  it('wraps useEffect with single identifier param callback', () => {
    const code = `function App() {\n  useEffect(function() {\n    console.log('hi');\n  }, []);\n  return null;\n}`;
    const out = transformTsx(code);
    assert.ok(out, 'should transform');
    assert.ok(out!.includes('__trickle_hw'), 'should inject hook wrapper for function() {} form');
  });
});
