# TypeScript Handbook → Trickle TypeNode catalog

Trickle infers types from **captured runtime values** (JS/TS and Python) and then **calculates types like TypeScript**: unify observations, check assignability, apply operators (`keyof`, indexed access, mapped/conditional/template types), and emit signatures. This file maps every Handbook and Reference page onto that algebra.

Do not treat TypeScript syntax as the product. The product is:

1. **Capture** a value → a `TypeNode`.
2. **Unify** many captures of the same function/arg/return → one type (best common type / union).
3. **Operate** on `TypeNode`s the way `tsc` operates on types (`Partial`, `ReturnType`, narrowing, structural assignability).
4. **Check** later observations against the accumulated type (and against user-written TS/Python annotations when present).

## Current TypeNode IR (as of this catalog)

Shared kinds already used by JS capture (`packages/client-js`) and Python capture (`packages/client-python`):

| kind | meaning |
| --- | --- |
| `primitive` | JS: `string \| number \| boolean \| null \| undefined \| bigint \| symbol`. Python also emits `integer`, `bytes`, `datetime`, `date`, `time`, and a few display names. |
| `array` | Homogeneous sequence (`T[]` / `list[T]`). |
| `tuple` | Fixed-position sequence (`[A, B]` / `tuple[A, B]`). Python also uses this for small heterogeneous lists. |
| `object` | Structural properties; optional `class_name` (class/dataclass/Tensor/ndarray/…). |
| `union` | `A \| B \| …` (flattened, structurally deduped). |
| `function` | Call signature: `params[]` + `returnType` (JS). Python currently stores `{kind:"function", name}`. |
| `promise` | `Promise<T>` (JS). Python awaitables are not yet a first-class kind. |
| `map` | `Map<K,V>` / large homogeneous `dict`. |
| `set` | `Set<T>` / `set[T]`. |
| `unknown` | Could not / would not inspect (depth cap, cycle, opaque). |

**Not in the IR today** (called out per page): `any`, `never`, `void`, literals, intersections, optional/readonly property flags, index signatures, rest/optional params, overloads, construct signatures, `this`, generic type parameters, template-literal types, `unique symbol`, enum kinds.

### Status legend

- **must-implement** — checker / capture must support this for the product.
- **N/A declaration-only** — exists only as TS declaration, tsconfig, `.d.ts` publishing, or compiler plumbing. No TypeNode algebra.
- **emit-only** — only about JS emit / downleveling / factories. Capture may observe the *result*, but Trickle does not emit that syntax.

---

## The Basics

- URL: https://www.typescriptlang.org/docs/handbook/2/basic-types.html
- Type-system behaviors:
  - Every runtime value has a type: the set of operations it supports (property access, call, construct).
  - Static checking predicts those operations before run; Trickle instead **observes** them after run and still needs the same predicates (`isCallable`, `hasProperty`, `isAssignable`).
  - Missing properties on objects are `undefined` at runtime, but TS flags them as errors (`user.location`). Checker must distinguish “property absent” from “property present with `undefined`”.
  - Typos, uncalled functions (`fn < 0.5`), and comparisons of non-overlapping types (`"a" !== "b"` after a narrowing) are type errors.
  - Type annotations are optional; inference from initializers is preferred when it matches the annotation.
  - Type annotations **erase** at runtime — they never change JS behavior. Trickle’s source of truth is the value, not the annotation; annotations are a second input for checking, not capture.
  - `noImplicitAny`: unconstrained holes are `any` unless forbidden. Trickle should prefer `unknown` for unobserved holes (safer default) and only emit `any` when explicitly requested.
  - `strictNullChecks`: `null`/`undefined` are **not** assignable to every type; they must be unioned in (`string | null`) and narrowed out.
- Runtime equivalent:
  - **JS/TS:** `typeof x`, `x === null`, `x === undefined`, `typeof x === "function"`, property `in` / `Object.hasOwn`. Capture already maps `null`/`undefined`/primitives/functions.
  - **Python:** `None` → `primitive:null`; missing dict keys vs `None` values must be distinguished the same way. `callable(x)` vs attribute presence (`hasattr` / `getattr`).
- Required TypeNode ops / capture changes:
  - `isCallable(t)`, `hasProperty(t, key)`, `getProperty(t, key)`.
  - `strictNull` assignability (null/undefined not members of every type).
  - Property-absence vs `{ prop: undefined }` (optional flag on object properties).
  - Overlap test for comparisons (`typesOverlap(a, b)` → empty ⇒ `never` / unintentional comparison).
- Status: **must-implement** for null/undefined, callability, property access, overlap. **N/A declaration-only** for `tsc`, `noEmitOnError`, downleveling/`target`, editor tooling. **emit-only** for template-string downlevel to `.concat`.

---

## Everyday Types

- URL: https://www.typescriptlang.org/docs/handbook/2/everyday-types.html
- Type-system behaviors:
  - **Primitives:** `string`, `number`, `boolean`. Prefer lowercase names; boxed `String`/`Number`/`Boolean` are distinct object wrappers (almost never wanted). JS has **no int/float split** — everything numeric that is not `bigint` is `number` (including `NaN`, `Infinity`).
  - **Arrays:** `T[]` ≡ `Array<T>`. `[number]` is a **tuple**, not an array. Empty arrays infer as `never[]` (strict) or `any[]` depending on context; capture of `[]` is currently `array(unknown)`.
  - **`any`:** disables checking. Property access, calls, and assignment to/from anything are allowed. Implicit `any` when inference fails; `noImplicitAny` makes that an error.
  - **`unknown`:** top type that is **not** freely usable; must narrow first. Capture already uses `unknown` for depth/cycles — keep it as the safe top, not `any`.
  - **Variable annotations:** postfix `x: T`. Inference from initializer: `const myName = "Alice"` → `string` (widened) vs literal (see literals / `as const`).
  - **Functions:** parameter annotations are checked at call sites; **arity is checked even without annotations**. Return type inferred from `return` statements. Async: annotate/infer `Promise<T>`.
  - **Contextual typing:** callbacks in `forEach` etc. take parameter types from the callee’s type, not from the function’s own annotation.
  - **Object types:** `{ x: number; y: number }` — comma or semicolon separators; omitted property type ⇒ `any`.
  - **Optional properties:** `last?: string` means the property may be absent **or** `undefined`. Reading requires a check (`obj.last` possibly undefined). `?.` optional chaining is a runtime + narrowing form.
  - **Unions:** `A | B | …`. Providing a value is easy (must match **some** member). Using a value requires operations valid for **every** member (union of values ⇒ intersection of capabilities). Shared methods (`slice` on `string | string[]`) are allowed without narrowing. Leading `|` in union syntax is cosmetic.
  - **Type aliases:** `type ID = number | string` is a **name**, not a new nominal type. Aliases of `string` are still `string` (no branding unless extra structure).
  - **Interfaces:** named object types; **structural** (shape, not heritage). Differences vs aliases: interfaces can be **re-opened** (declaration merging); type aliases cannot; interfaces don’t rename primitives; `extends` vs `&`.
  - **Type assertions:** `x as T` / `<T>x` erase at runtime. Only allowed when T is more or less specific (overlap); otherwise go through `unknown`/`any`. No runtime check.
  - **Non-null assertion:** `x!` strips `null | undefined` with no runtime check.
  - **Literal types:** `"hello"`, `1`, `-1`, `true`/`false`. `boolean` ≡ `true | false`. `const` string/number infers the literal; `let` widens to `string`/`number`.
  - **Literal unions:** `"left" | "right" | "center"`; numeric `"compare"` returns `-1 | 0 | 1`; mix with object types (`Options | "auto"`).
  - **Literal inference / widening:** object properties widen (`{ method: "GET" }` ⇒ `method: string`) because they are mutable. Workarounds: `as "GET"`, `as const` (deep readonly literals).
  - **`null` / `undefined`:** two distinct primitives. `strictNullChecks` off ⇒ assignable everywhere (unsound). On ⇒ must narrow. Optional properties interact with this.
  - **Enums:** mentioned; full rules on the Enums page. They **exist at runtime** (unlike most TS types).
  - **`bigint`:** `100n` / `BigInt(100)` → primitive `bigint`, not `number`.
  - **`symbol`:** `Symbol()` uniqueness; two `unique symbol`s do not overlap.
- Runtime equivalent:
  - **JS/TS:** `typeof` for primitives; `Array.isArray` vs tuple heuristic (fixed length + heterogeneous elements, or `as const` arrays); `value === null`; boxed primitives via `new String()` (`typeof` `"object"` + `instanceof String`); `Promise` via `instanceof Promise` / thenable; functions via `typeof === "function"`. Capture today: primitives yes; arrays unified to one element type (loses tuples unless positions differ and we special-case); **no literals** (all strings collapse to `string`); **no optional property flag** (missing keys simply omitted; later unification must union `undefined` or mark optional); `any` not produced.
  - **Python:** `str`→`string`, `bool`→`boolean` (before `int`), `int`→`integer` (must remain distinct from JS `number`), `float`→`number`, `None`→`null`. No `undefined`. `list`→`array` (or `tuple` if small heterogeneous). `dict`→`object` or `map`. `Optional[T]` is observed as `T | null` across calls. Python `True`/`False` are literals of `boolean`. Enum instances currently collapse to `string` — too lossy.
- Required TypeNode ops / capture changes:
  - **Literal nodes:** `{ kind: "literal", value }` for string/number/boolean/bigint; widening `widen(t)` (literal → primitive) vs `asConst` (keep literals, mark readonly).
  - **`any` vs `unknown` vs `never` vs `void`** as first-class kinds or primitive names.
  - **Optional properties:** `optional?: boolean` on each object property; unify missing keys across samples as optional, not as “property disappeared”.
  - **Union flatten/dedup** (already in JS `unifyTypes`); also **literal union collapse** (`"a" | "b" | string` → `string`).
  - **Boxed vs primitive** (`String` object vs `string`).
  - **Tuple vs array heuristic:** heterogeneous short arrays; Python already does this (`class_name: "list"` on tuple nodes).
  - **Alias identity is structural** — no extra IR; named interfaces are emit/display only (`class_name` / extracted interface name).
  - **Assertion / `!`:** checker ops `assertAs(t, target)` (overlap check) and `nonNull(t)` = `Exclude<t, null | undefined>`. Capture does not need them (they don’t exist at runtime).
- Status: **must-implement** (this is the product core). Enums: see Enums page. Boxed wrappers: must-implement if observed.

---

## Narrowing

- URL: https://www.typescriptlang.org/docs/handbook/2/narrowing.html
- Type-system behaviors:
  - Narrowing = control-flow refinement from a declared/observed union to a more specific type.
  - **`typeof` type guards:** results are `"string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function"`. **`typeof null === "object"`** — `typeof x === "object"` on `string | string[] | null` yields `string[] | null`, not `string[]`.
  - **Truthiness:** `0`, `NaN`, `""`, `0n`, `null`, `undefined` are falsy. `if (x)` strips those from the true branch; `if (!x)` keeps them. Dangerous on `string` (drops `""`) and `number` (drops `0`). `Boolean(x)` infers `boolean`; `!!x` infers literal `true` when x is always truthy.
  - **Equality narrowing:** `===` / `!==` / `==` / `!=` / `switch`. If `x === y` and both are unions, each is narrowed to the **intersection of their types**. Literal equality (`x === null`) removes that member. **`== null` / `== undefined` remove both `null` and `undefined`.**
  - **`in` operator:** `"swim" in animal` — true branch: members that have required **or optional** `swim`; false branch: members where `swim` is optional **or absent**. Optional keys appear on **both** sides.
  - **`instanceof`:** prototype-chain guard. Narrows to the instance type of the constructor.
  - **Assignments:** a variable’s **declared** type is the union of initializer possibilities; each assignment narrows the *observed* type but later assignments must still inhabit the declared type.
  - **Control-flow analysis:** early `return`/`throw` makes the rest of the function see the complement. Splits re-merge at join points (`if`/`else`, loops).
  - **Type predicates:** `function isFish(p: Fish | Bird): p is Fish`. True ⇒ `Fish`; else ⇒ complement. Also `this is Type` on methods. Array `.filter(isFish)` yields `Fish[]`.
  - **Assertion functions:** `function assert(cond: any): asserts cond` and `asserts x is T` — after the call, `cond` is truthy / `x` is `T`. They throw on failure.
  - **Discriminated unions:** a shared property with **literal** types (e.g. `kind: "circle" | "square"`) is a discriminant. Checking `shape.kind === "circle"` selects the matching member; `switch` does the same. **Do not encode as one object with optional fields** (`radius?: number`) — the discriminant cannot prove presence. Separate members with required fields.
  - **`never`:** the empty type; appears when a union is fully eliminated.
  - **Exhaustiveness:** `const _x: never = shape` in `default` fails when a new union member is added (`Triangle` not assignable to `never`).
- Runtime equivalent:
  - **JS/TS:** these *are* runtime checks. Capture of a single call sees only the branch taken. Across many calls, unify args/returns into the **declared union**; the checker then replays guards on TypeNodes. Discriminants: capture literal tags (`kind: "circle"`) — **requires literal nodes**, otherwise all tags collapse to `string` and discriminants die.
  - **Python:** `isinstance(x, int)`, `x is None`, `type(x) is …`, `hasattr(x, "swim")`, match/case on tagged dataclasses (`kind` field), `isinstance` on ABCs. Truthiness: `None`, `0`, `""`, `[]`, `{}` are falsy (note: empty containers are falsy in Python, **not** in JS). `Optional[T]` narrowing is `if x is None`. Enums/discriminated unions: tagged dataclasses or `Literal` fields.
- Required TypeNode ops / capture changes:
  - `narrowTypeof(t, "string" | …)` including the `null` is `"object"` quirk.
  - `narrowTruthy(t)` / `narrowFalsy(t)` with language-specific falsy sets (JS vs Python).
  - `narrowEq(t, other)` / `narrowNeq`; `narrowEqNullish` for `== null`.
  - `narrowIn(t, key)` with optional-property both-sides rule.
  - `narrowInstanceof(t, ctorName)` using `class_name` + heritage if captured.
  - `discriminate(union, key, literal)`.
  - `complement(t, union)` for else-branches and predicates.
  - `never` kind; `isNever`; exhaustiveness `assignable(remaining, never)`.
  - Capture: **literal property values** for tags; keep `class_name` for `instanceof`; record optional vs missing across samples.
  - Type predicates / asserts: checker-only (no runtime type); optional capture of user annotations `x is T`.
- Status: **must-implement**. Control-flow over *source* is optional (static CFA); control-flow over *observed unions* + replaying known guards is required. Full CFA of user source is N/A unless Trickle later type-checks source text.

---

## More on Functions

- URL: https://www.typescriptlang.org/docs/handbook/2/functions.html
- Type-system behaviors:
  - **Function type expressions:** `(a: string) => void`. Parameter **name is required** in the type; `(string) => void` means param named `string` of type `any`.
  - **Call signatures in object types:** `{ description: string; (n: number): boolean }` — callable + properties.
  - **Construct signatures:** `{ new (s: string): Date }`. Some values (`Date`) have both call and construct signatures.
  - **Generic functions:** type parameters relate inputs/outputs (`firstElement<T>(arr: T[]): T`). Inference from arguments; multiple params (`map<Input, Output>`). **Constraints:** `T extends { length: number }`. Cannot return a fresh `{ length }` as `T` (T might be a subtype). Manual type arguments when inference fails (`combine<string | number>(…)`).
  - **Generic hygiene:** push type parameters down (`T[]` not `T extends any[]`); use as few as possible; a param should appear at least twice (relating values).
  - **Optional parameters:** `x?: number` ⇒ `number | undefined`; callers may omit or pass `undefined`. Defaults (`x = 10`) make `x` `number` **inside** the body. **Callbacks:** do not mark callback params optional unless the implementation might omit them; extra args are ignored at runtime; fewer-params functions are assignable to more-params function types.
  - **Overloads:** one or more **overload signatures** + a hidden **implementation signature**. Callers only see overloads. Implementation must be compatible with all overloads. Prefer a union-parameter function when all overloads share arity/return. Overload resolution does **not** accept a union that straddles two overloads (`string | string[]` won’t match `len(s: string)` | `len(a: any[])`). Last overload is used by `infer` / `Parameters` / `ReturnType`.
  - **`this` parameters:** `function (this: DB)`; forbidden as a real JS param. Arrow functions capture outer `this` (often `globalThis`).
  - **`void`:** inferred when no useful return. **Not** `undefined`. Contextual `() => void` **may** return a value (ignored) — so `forEach(x => arr.push(x))` is legal. A **literal** function annotated `: void` must not return a value.
  - **`object`:** non-primitive (not `string|number|bigint|boolean|symbol|null|undefined`). Functions are `object`s. Distinct from `{}` and from `Object`.
  - **`unknown`:** accept anything; cannot use without narrowing. Opposite of `any`.
  - **`never`:** functions that always throw / diverge; also empty remaining union.
  - **`Function`:** untyped callable; calls return `any`. Prefer `(...args: never[]) => unknown` or `() => void` if not invoking.
  - **Rest parameters:** `...m: number[]` or a **tuple** rest. Implicit annotation is `any[]`.
  - **Rest arguments / spread:** spreading a `number[]` into a fixed-arity function is an error; `as const` tuples work. `downlevelIteration` is emit.
  - **Parameter destructuring:** type the **whole object** after the pattern: `({ a, b }: { a: number; b: number })`. Cannot annotate inside the pattern (`{ a: number }` is a rename).
- Runtime equivalent:
  - **JS/TS:** `fn.length` is arity **without** rest/defaults (already used as `params: unknown[]` of that length). Optional vs required: observe some calls omitting a trailing arg → mark optional. Rest: `arguments.length` beyond declared arity, or `...args` captured as `array`/`tuple`. Overloads: **unify** observed call shapes into a union of signatures (or a single signature with unions). `this` is the receiver: capture `this` when wrapping methods. `new fn()` vs `fn()`: capture `new.target` / construct vs call. Properties on functions (`fn.description`) need object+call. `async` → `promise` of resolved type (unwrap thenables on return).
  - **Python:** `inspect.signature` for params/defaults/VAR_POSITIONAL/VAR_KEYWORD; missing args vs `None` defaults; `*args`/`**kwargs`; bound methods (`self`/`cls`); `@overload` stubs (typing) vs one runtime function — capture sees the implementation, so unify call sites like TS overloads. Return `None` is closer to `None` (null) than to `void`; Python has no `void`.
- Required TypeNode ops / capture changes:
  - Function node fields: `params: { name?, type, optional?, rest? }[]`, `returnType`, `thisType?`, `construct?: boolean`, `props?` (call+properties), `overloads?: Signature[]`.
  - Assignability: parameter **bivariance** (compat page) vs `strictFunctionTypes` contravariance; extra optional params OK; rest ≡ infinite optionals; void-return special case; fewer params assignable to more.
  - Generic function IR: `{ typeParams: { name, constraint?, default? }[], ... }` **or** just instantiate from captures (product can start with **instantiated** signatures and add generic reconstruction later).
  - `ReturnType`, `Parameters`, `ThisParameterType`, `OmitThisParameter` (utility types).
  - Capture JS method `this`; capture Python `self` as first param or bind it away for instance methods.
  - Distinguish `void` (no meaningful return) from `undefined`/`null` (observed `undefined`/`None`).
- Status: **must-implement**. `downlevelIteration`: **emit-only**. Generic *reconstruction* from examples is must-implement at the instantiated level; full `T extends` syntax emit is must-implement for codegen quality.

---

## Object Types

- URL: https://www.typescriptlang.org/docs/handbook/2/objects.html
- Type-system behaviors:
  - Objects are structural: anonymous `{ name: string; age: number }`, `interface`, or `type` alias — same checking.
  - **Optional properties:** `xPos?: number` — may omit; reads are `T | undefined`. Destructuring defaults make the local binding defined without changing the caller’s optional type. Cannot annotate *inside* a destructuring pattern.
  - **`readonly` properties:** no reassignment of the binding; nested fields remain mutable unless also readonly. **`readonly` is ignored for compatibility** (unsound aliasing: `ReadonlyPerson` aliased as `Person` can mutate). Mapping modifiers can add/remove `readonly`.
  - **Index signatures:** `[k: string]: T`, `[n: number]: U`, `symbol`, template patterns, unions of those. Numeric index type must be a **subtype** of string index type (`obj[100]` ≡ `obj["100"]`). All declared properties must be assignable to the string index type (or the index type must be a union that includes them). `readonly` index signatures forbid writes.
  - **Excess property checks:** **fresh object literals** may not specify unknown properties (`colour` vs `color`). Bypasses: assertion, string index signature, assign to an intermediate variable (only if some property overlaps; else “no properties in common”).
  - **Extending interfaces:** `interface A extends B, C`. Copy members; conflicts on the same property name with different types error.
  - **Intersection types:** `A & B` has all members. Conflicting same-name properties become `never` (e.g. `name: string & number`). Intersections vs `extends`: conflict handling differs (interface merge errors; `&` yields `never`).
  - **Generic object types:** `Box<T> { contents: T }`. Type aliases can be generic too (`OrNull<T> = T | null`). `Array<T>`, `Map<K,V>`, `Set<T>`, `Promise<T>` are generic containers.
  - **`ReadonlyArray<T>` / `readonly T[]`:** no mutating methods; `T[]` assignable to `readonly T[]` but **not** vice versa.
  - **Tuples:** `[string, number]` — fixed length + position types. Optional elements only at the end (`[number, number, number?]` ⇒ `length: 2 | 3`). Rest elements: `[string, number, ...boolean[]]`, leading/middle rest. Tuples correspond to parameter lists. Equivalent to objects with numeric keys + `length` literal.
  - **`readonly` tuples:** `readonly [string, number]`; `as const` array literals infer readonly tuples of literals. Readonly tuples are **not** assignable to mutable tuples.
- Runtime equivalent:
  - **JS/TS:** `Object.keys` / own enumerable strings (capture today, capped). Missing keys across samples → optional. `Object.freeze` → readonly (if detected). Index signatures: large objects with uniform values already become `map` (Python) / should become `{ [key: string]: V }` in JS too. Arrays: `Array.isArray`; tuples: heterogeneous short arrays or `arguments`-like pairs. `Map`/`Set`/`Promise` already have kinds. Excess property checks apply when **checking a fresh literal against a TypeNode**, not when capturing (capture records what was there).
  - **Python:** `dict` → object (small, mixed values) or `map` (large, uniform). Dataclass / Pydantic / namedtuple → `object` + `class_name`. `tuple` → `tuple` kind. `list` → `array` or heterogeneous `tuple` with `class_name: "list"`. Optional dataclass fields defaulting to `None` → optional **or** `T | null` (see Python mapping: Python has no `undefined`). `frozen=True` dataclass / `MappingProxyType` / `frozenset` → readonly intent. `TypedDict` totality (`total=False`) ≡ optional keys.
- Required TypeNode ops / capture changes:
  - Property flags: `optional`, `readonly`.
  - Object `index?: { key: TypeNode, value: TypeNode, readonly?: boolean }` (string/number/symbol).
  - `intersect(a, b)` including property-wise `never` on conflicts.
  - `extend(base, extra)` (interface extends = intersect + conflict errors).
  - Excess property check: `checkFreshLiteral(source, target)`.
  - Tuple ops: `length`, optional tail, rest, `readonly` flag; convert ↔ param lists.
  - `ReadonlyArray` as `array` + `readonly` (or a flag on array/tuple).
  - Unify objects: key in all samples → required; key in some → optional; value types unioned.
  - JS capture: stop dropping keys beyond 12 without recording an index signature; consider emitting `index` when keys are uniform and numerous.
- Status: **must-implement**.

---

## Type Manipulation (Creating Types from Types)

- URL: https://www.typescriptlang.org/docs/handbook/2/types-from-types.html
- Type-system behaviors:
  - Types can be computed from other types: generics, `keyof`, `typeof` (type position), indexed access, conditionals, mapped types, template literals.
  - These operators are **pure TypeNode transformations** — they do not need new runtime values, only an existing type graph.
- Runtime equivalent:
  - **JS/TS and Python:** after capture has produced TypeNodes for values, apply the same operators in the checker. No extra capture except what’s needed so the input types are rich enough (literals, property names, function signatures).
- Required TypeNode ops / capture changes:
  - Implement the six operator families below as functions on TypeNode. This page is the table of contents.
- Status: **must-implement** (the operators). The page itself has no extra rules.

---

## Generics

- URL: https://www.typescriptlang.org/docs/handbook/2/generics.html
- Type-system behaviors:
  - Type variables capture a type and reuse it (`identity<T>(arg: T): T`) — unlike `any`, information is preserved.
  - Call with explicit type args `identity<string>("myString")` or **type argument inference** from value args.
  - Using `T` in the body only allows operations common to **all** possible instantiations; need `T[]` or `T extends { length: number }` to use `.length`.
  - **Generic function types:** `<T>(arg: T) => T`. Names of type params need only match by position/usage.
  - **Generic interfaces:** type param on the call signature (generic function) vs on the interface (`GenericIdentityFn<T>` locks T for all members).
  - **Generic classes:** type params after the class name; apply to **instance** side only — **static members cannot reference the class type param**. No generic enums or namespaces.
  - **Constraints:** `T extends Lengthwise`. Constrained calls reject types missing required members.
  - **Type params in constraints:** `K extends keyof T` for `getProperty(obj, key)`.
  - **Class types in generics:** factories take `{ new (): T }` / `new (...args) => T`. Mixins use constructor generics (see Mixins).
  - **Defaults:** `T extends HTMLElement = HTMLDivElement`. Rules: optional iff defaulted; required params cannot follow optional; default must satisfy constraint; omitted args use defaults; inference failure → default; merging may add defaults/new defaulted params.
  - **Variance annotations:** `in T` (contravariant), `out T` (covariant), `in out T` (invariant). Only consulted for **instantiation-based** comparison of the **same** generic; structural comparison ignores them. Must match structural variance. Marker for performance/debugging, not for forcing unsound variance.
  - Covariance example: `Producer<Cat>` assignable to `Producer<Animal>`. Contravariance: `Consumer<Animal>` assignable to `Consumer<Cat>`.
- Runtime equivalent:
  - **JS/TS:** runtime is erased. Capture sees **instantiations**: `identity(3)` → `(number) => number`, `identity("x")` → `(string) => string`. Reconstructing `<T>(x: T) => T` is a **generalization** pass over many instantiated signatures (same shape, related positions). Constraints are the **intersection of operations actually performed** or the structural bound from samples (`{length: number}`).
  - **Python:** `typing.TypeVar`, `Generic[T]`, `list[T]`, `ParamSpec` — also erased. Capture of `def identity(x): return x` across ints and strs should generalize to `T -> T`, not collapse to `integer | string -> integer | string` when input/output **correlate per call**. That correlation is the whole point of generics and **must not** be lost by naively unioning all args and all returns independently. Python `TypeVar(bound=…)` ≡ `extends`. `TypeVar(default=…)` (PEP 696) ≡ generic defaults.
- Required TypeNode ops / capture changes:
  - **Call-level correlation:** store per-observation `(argsType, returnType)` pairs, not only the union of all args and union of all returns.
  - `generalize(signatures[])` → type params where positions vary together.
  - `instantiate(generic, typeArgs)` / `inferTypeArgs(generic, args)`.
  - Constraint check `assignable(arg, constraint)`.
  - Constructor types `{ new (...p): R }` as a function flag `construct: true`.
  - Variance: `isAssignable(G<A>, G<B>)` using inferred variance of `G` (structural: properties covariant, function params bivariant/contravariant).
  - Defaults when inference yields no candidate.
- Status: **must-implement**. Variance annotations themselves: must-implement only as documentation/perf; structural assignability is the product. Generic enums/namespaces: N/A.

---

## Keyof Type Operator

- URL: https://www.typescriptlang.org/docs/handbook/2/keyof-types.html
- Type-system behaviors:
  - `keyof Point` for `{ x: number; y: number }` ⇒ `"x" | "y"` (string **literal** union).
  - String index signature ⇒ `keyof` is `string | number` (JS coerces keys; `obj[0]` ≡ `obj["0"]`).
  - Number index signature ⇒ `keyof` is `number`.
  - Combined with mapped types and `K extends keyof T`.
- Runtime equivalent:
  - **JS/TS:** `Object.keys(value)` plus symbol keys if captured (`Object.getOwnPropertySymbols`). For classes, public own + prototype enumerable names. Index-signature objects: keys are `string` (and `number` if numeric).
  - **Python:** `dict.keys()`, dataclass `fields()`, Pydantic field names, `namedtuple._fields`, `typing.get_type_hints` / `__annotations__` as hints. For `list`/`tuple`, “keyof” is `number` (index). For `TypedDict`, keys are literal names.
- Required TypeNode ops / capture changes:
  - `keyof(t): TypeNode` — object ⇒ union of string literals of property names; array/tuple ⇒ `number` (and optional `"length"` etc. if modeled as objects); map with string keys ⇒ `string | number`; union ⇒ union of keyofs; `keyof never` / `keyof any` per TS (`string | number | symbol` for `any`).
  - Literal string nodes required.
  - Capture symbol keys if we want `unique symbol` keyof members.
- Status: **must-implement**.

---

## Typeof Type Operator

- URL: https://www.typescriptlang.org/docs/handbook/2/typeof-types.html
- Type-system behaviors:
  - Expression `typeof` vs **type-position** `typeof x` (type of a value).
  - Combined with `ReturnType<typeof fn>` — values and types are different namespaces; `ReturnType<f>` errors, need `typeof f`.
  - Legal only on **identifiers and their properties**, not arbitrary expressions (`typeof msgbox("…")` is invalid in type position).
- Runtime equivalent:
  - **JS/TS:** Trickle’s capture **is** `typeof` in the type-position sense: the TypeNode of a captured binding. `typeof fn` for a wrapped function is its accumulated signature (params + return), not `"function"`.
  - **Python:** `type(x)` is the class object (nominal); Trickle should use the **structural TypeNode** (like TS `typeof`), and separately store `class_name`. `typing.typeof` does not exist; closest is capturing the value.
- Required TypeNode ops / capture changes:
  - No new kind. `typeof` is “look up the TypeNode of this captured name”.
  - Need named environments: function signatures, variables, class instance vs constructor (static side).
  - `ReturnType` on function TypeNodes (see Utility Types).
- Status: **must-implement** as environment lookup. **N/A declaration-only** for the syntactic restriction on type queries.

---

## Indexed Access Types

- URL: https://www.typescriptlang.org/docs/handbook/2/indexed-access-types.html
- Type-system behaviors:
  - `Person["age"]` ⇒ property type. Indexer is a **type**: unions (`"age" | "name"`), `keyof Person`, aliases.
  - Missing key is an error (`Person["alve"]`).
  - `Arr[number]` ⇒ element type of an array. `typeof MyArray[number]["age"]` chains.
  - Cannot use a **value** as an index type (`key` variable); use `typeof key` or a type alias of a literal.
- Runtime equivalent:
  - **JS/TS:** `value[k]` on a captured object/array. For types: `index(T, K)` on TypeNodes. Array element = `index(array, number)` or `array.element`. Tuple: `index(tuple, 0)` ⇒ that element; out of range ⇒ error/`undefined` depending on strictness.
  - **Python:** `obj[k]` / `getattr`; `list[int]` element type; `tuple[0]` position; TypedDict key access.
- Required TypeNode ops / capture changes:
  - `index(type, keyType)`: if `keyType` is a string/number literal union, distribute; objects look up properties; arrays use `number`; maps use key assignability; optionals yield `T | undefined`.
  - Error when key not in `keyof type` (unless index signature).
- Status: **must-implement**.

---

## Conditional Types

- URL: https://www.typescriptlang.org/docs/handbook/2/conditional-types.html
- Type-system behaviors:
  - `SomeType extends OtherType ? TrueType : FalseType` — **assignability** test, not runtime `instanceof`.
  - Power comes with **generics** (e.g. `NameOrId<T> = T extends number ? IdLabel : NameLabel`) replacing overload explosions.
  - **True-branch constraints:** `T extends { message: unknown } ? T["message"] : never` — inside true, `T` has `message`.
  - **`infer`:** `Type extends Array<infer Item> ? Item : Type`; `GetReturnType<T> = T extends (...args: never[]) => infer R ? R : never`. Overloads: infer from the **last** signature.
  - **Distributive conditionals:** `T extends any ? T[] : never` on a **naked** type param distributes over unions (`string | number` ⇒ `string[] | number[]`). Wrap in tuples to disable: `[T] extends [any] ? …`.
- Runtime equivalent:
  - **JS/TS and Python:** no runtime `extends`. Checker applies `isAssignable(left, right)` then selects a branch. Distributivity: if `T` is a union and the conditional is distributive, map memberwise then union. `infer` is pattern-match on TypeNode shape (`array` → element, `function` → return, `promise` → resolved, `object` properties).
- Required TypeNode ops / capture changes:
  - `conditional(t, check, then, else, distributive?)`.
  - `inferFrom(pattern, t)` binding slots (`infer R`).
  - Reuse `isAssignable`.
  - Function overloads: “last signature” rule when inferring.
- Status: **must-implement**.

---

## Mapped Types

- URL: https://www.typescriptlang.org/docs/handbook/2/mapped-types.html
- Type-system behaviors:
  - Index signature vs mapped: `{ [key: string]: boolean | Horse }` vs `{ [P in keyof T]: boolean }`.
  - Mapped type iterates a `PropertyKey` union (usually `keyof T`) and builds a new object type.
  - **Modifiers:** `readonly` and `?`; prefix `+`/`-` to add/remove (`-readonly`, `-?`). Bare `readonly`/`?` means `+`.
  - **Key remapping (`as`):** `[K in keyof T as NewKey]: T[K]`. Template literals for renaming (`get${Capitalize<K>}`). Filter keys by remapping to `never` (`Exclude<K, "kind">`).
  - Map over **arbitrary unions**, not only keys: `{ [E in Events as E["kind"]]: (e: E) => void }`.
  - Nested conditionals per property (`T[P] extends { pii: true } ? true : false`).
- Runtime equivalent:
  - **JS/TS:** `Object.fromEntries(Object.keys(o).map(…))` is the value-level analogue; Trickle maps **types**: `Partial`/`Pick` are mapped types. Capture doesn’t need mapped types; the checker applies them to captured object TypeNodes.
  - **Python:** `typing.TypedDict` + `Required`/`NotRequired`/`ReadOnly` (3.11+/PEP 705); comprehensions over keys. Same ops on TypeNodes.
- Required TypeNode ops / capture changes:
  - `mapType(t, { key: K => K', value: (K, V) => V', optional, readonly })`.
  - `never` keys dropped.
  - Homomorphic mapped types preserve optional/readonly from the source unless modified.
- Status: **must-implement**.

---

## Template Literal Types

- URL: https://www.typescriptlang.org/docs/handbook/2/template-literal-types.html
- Type-system behaviors:
  - `` `hello ${World}` `` concatenates string literals. Unions **cross-multiply** at each hole.
  - Used to constrain derived strings: event names `` `${keyof T}Changed` ``.
  - **Inference:** generic `on<Key extends string & keyof Type>(eventName: `${Key}Changed`, callback: (v: Type[Key]) => void)` — parse the literal, infer `Key`, index the object.
  - **Intrinsics:** `Uppercase<S>`, `Lowercase<S>`, `Capitalize<S>`, `Uncapitalize<S>` — compiler builtins, locale-unaware (`toUpperCase` etc.).
- Runtime equivalent:
  - **JS/TS:** template strings at runtime; type-level templates need **literal** TypeNodes. Without capturing string literals (`"firstNameChanged"`), none of this works.
  - **Python:** f-strings / `Literal["welcome_email"]`; no type-level templates in `typing`, but Trickle can still compute them on TypeNodes for shared checker logic (e.g. Django URL names, pytest node ids).
- Required TypeNode ops / capture changes:
  - Capture string (and optionally number) **literals**.
  - `template(parts: (string | TypeNode)[])` with union distribution / cartesian product.
  - Intrinsic string maps.
  - Infer via pattern-match of a template against a literal (for `Key` in `` `${Key}Changed` ``).
- Status: **must-implement** (depends on literals). Huge unions: cap/cross-product limits.

---

## Classes

- URL: https://www.typescriptlang.org/docs/handbook/2/classes.html
- Type-system behaviors:
  - **Fields:** optional annotations; initializer infers type; `--strictPropertyInitialization` requires constructor assignment (not nested method calls). Definite assignment `name!: string`.
  - **`readonly` fields:** assignable only in constructor.
  - **Constructors:** params, defaults, overloads; **no type params on constructors** (they live on the class); **no return annotation** (instance type is the return). `super()` before `this` in derived constructors.
  - **Methods:** same typing as functions.
  - **Getters/setters:** get infers property type; set must be compatible; if only get, property is `readonly`.
  - **Index signatures** on classes (same as objects).
  - **`implements`:** check only; **does not change** the class type or method inference; optional interface props are not added.
  - **`extends`:** derived has base members; `override` checking (`noImplicitOverride`); derived constructors must call `super`.
  - **Initialization order:** base fields → base constructor → derived fields → derived constructor.
  - **`public` / `protected` / `private`:** visibility. `protected` visible in subclasses; can be re-exposed as `public`. No sibling-hierarchy `protected` access. `private` is **type-level** (different classes’ privates don’t match) — distinct from ES `#hardPrivate` (runtime).
  - **Static members:** on the constructor function; not generic in the class type param. `static` blocks.
  - **Generic classes:** instance side only.
  - **`this` at runtime:** depends on call site; arrow functions bind; `Function.prototype.call`.
  - **`this` types:** polymorphic `this` for fluent APIs; `other: this` is the derived type. **`this is T` type guards** on methods.
  - **Parameter properties:** `constructor(public x: number)` creates a field.
  - **Class expressions:** anonymous/named.
  - **Construct signatures:** `new () => T` vs abstract construct (`abstract new () => T`). Abstract constructors not assignable to concrete `new`.
  - **Abstract classes/members:** cannot instantiate; concrete subclasses must implement.
  - **Relationships:** classes are **structural** (two classes with the same public instance shape are compatible) **except** `private`/`protected` which are nominal (must originate from the same declaration). Static side ignored when comparing instances.
- Runtime equivalent:
  - **JS/TS:** capture `new C(…)` args + instance shape (`class_name`, properties). Prototype methods appear as function properties if enumerated (today JS capture uses `Object.keys` — **misses prototype methods**). Need own+prototype public fields/methods for class types. `constructor` function type = static side. `#private` fields are not enumerable (correctly absent). `extends` chain: optional `prototype` walk for `instanceof` narrowing.
  - **Python:** `type(obj).__name__`, dataclass fields, `__dict__` / `__slots__`, `@property`, `@classmethod`/`@staticmethod`, ABC `abstractmethod`. Capture already sets `class_name` and dataclass/Pydantic properties. Inheritance: `type.mro()`. `self` methods via wrapping class methods.
- Required TypeNode ops / capture changes:
  - Split **instance type** (`object` + methods) vs **constructor type** (`new (...p): Instance` + static props).
  - `class_name` + optional `heritage: string[]` for `instanceof`.
  - Visibility is mostly N/A at runtime (cannot observe `private`); ES `#fields` stay uncaptured.
  - `this` return type = the instance type of the receiver.
  - Abstract: N/A at runtime (cannot construct); checker-only if annotations present.
  - Capture prototype methods / bound methods as `function` properties.
- Status: **must-implement** for instance/constructor shapes, `class_name`, structural compatibility. **N/A declaration-only** for `implements` as a clause, `abstract`, `override`, `strictPropertyInitialization`, parameter-property *syntax*. **emit-only** for TS `private` downlevel vs `#`.

---

## Modules

- URL: https://www.typescriptlang.org/docs/handbook/2/modules.html
- Type-system behaviors:
  - File with top-level `import`/`export`/`await` is a module; otherwise a **script** (global scope). `export {}` forces module mode.
  - ES exports: `export default`, named `export`, `export { x as y }`, `import * as ns`, side-effect `import "./file"`.
  - **Type-only imports:** `import type { T }` and inline `import { type T, value }` — erased; values imported with `import type` cannot be used as values.
  - `import fs = require("fs")` TS/CJS interop.
  - CommonJS: `module.exports` / `exports.x` / `require`.
  - `esModuleInterop` for default vs namespace mismatch.
  - Resolution: Classic vs Node; `moduleResolution`, `baseUrl`, `paths`, `rootDirs`.
  - Emit: `target` (downlevel syntax) vs `module` (CJS/ESM/UMD loaders).
  - Namespaces (`namespace X`) are a separate, older module format.
- Runtime equivalent:
  - **JS/TS:** capture already records `module` string on observations. Types of exports = captured values of exported bindings. Namespace import `* as maths` is an `object` of export names.
  - **Python:** modules are objects (`sys.modules`); `from x import y`; packages. Capture uses Python module path as `module`.
- Required TypeNode ops / capture changes:
  - Module env: map export name → TypeNode (including `default`).
  - No special kinds. Resolution/emit flags do not affect TypeNode algebra.
- Status: **N/A declaration-only** for resolution, `tsconfig` `module`/`target`, `esModuleInterop`, `outFile`. **must-implement** only as “exports are named TypeNodes in a module environment” (already implied by capture metadata). **emit-only** for CJS/UMD wrappers.

---

## Utility Types

- URL: https://www.typescriptlang.org/docs/handbook/utility-types.html
- Type-system behaviors (each utility is a required operator unless noted):
  - **`Awaited<T>`:** recursive Promise unwrap (`Promise<Promise<number>>` → `number`); also thenables.
  - **`Partial<T>`:** all props optional (`{ [K in keyof T]?: T[K] }`).
  - **`Required<T>`:** all props required (`-?`).
  - **`Readonly<T>`:** all props `readonly` (models `Object.freeze`).
  - **`Record<K, T>`:** object with keys `K` and values `T`.
  - **`Pick<T, K>`:** subset of props (`K extends keyof T`).
  - **`Omit<T, K>`:** `Pick<T, Exclude<keyof T, K>>`.
  - **`Exclude<U, E>`:** union members of `U` not assignable to `E`.
  - **`Extract<T, U>`:** members of `T` assignable to `U`.
  - **`NonNullable<T>`:** `Exclude<T, null | undefined>` (Python: also drop `None` only — no `undefined`).
  - **`Parameters<F>`:** tuple of param types; last overload; `any` → `unknown[]`; `never` → `never`; non-functions → error/`never`.
  - **`ConstructorParameters<F>`:** params of `new`; similar edge cases.
  - **`ReturnType<F>`:** return type; last overload; `any` → `any`; non-functions error.
  - **`InstanceType<C>`:** instance of a constructor type.
  - **`NoInfer<T>`:** blocks inference (identical otherwise). Example: default color must be a member of inferred `C[]`.
  - **`ThisParameterType<F>`** / **`OmitThisParameter<F>`:** extract/strip `this`; generics erased; last overload kept.
  - **`ThisType<T>`:** marker for contextual `this` in object literals (`noImplicitThis`); empty interface, not a transform.
  - String intrinsics: see Template Literal Types (`Uppercase` / `Lowercase` / `Capitalize` / `Uncapitalize`).
- Runtime equivalent:
  - **JS/TS:** these are type-only. Runtime cousins: `Object.assign`/`spread` (Partial updates), `Object.freeze` (Readonly), `await` (Awaited). Capture of `await x` should store the **resolved** TypeNode inside `promise` (today JS `Promise` is `promise(unknown)` unless you capture the awaited value).
  - **Python:** `typing.Required`/`NotRequired`, `Readonly`, `TypedDict` picks; `typing.NonNone`; `inspect.signature` for Parameters; `__init__` for ConstructorParameters; instance `__dict__` for InstanceType. `await` unwraps coroutines/`asyncio.Future`.
- Required TypeNode ops / capture changes:
  - Implement each utility as a TypeNode function (they compose mapped/conditional/keyof/index).
  - Capture: resolve promises/coroutines to fill `promise.resolved`; freeze detection → readonly.
  - `NoInfer` / `ThisType`: checker inference flags, not capture.
- Status: **must-implement** for Awaited, Partial, Required, Readonly, Record, Pick, Omit, Exclude, Extract, NonNullable, Parameters, ReturnType, InstanceType, ConstructorParameters. **must-implement** (lighter) for ThisParameterType, OmitThisParameter, NoInfer. **N/A declaration-only** for `ThisType` marker semantics in object-literal contextual typing (unless Trickle type-checks source). String utilities: **must-implement** with template literals.

---

## Decorators

- URL: https://www.typescriptlang.org/docs/handbook/decorators.html
- Type-system behaviors:
  - Legacy (experimental stage 2, `experimentalDecorators`) vs Stage 3 (TS 5.0). This page documents the **legacy** model.
  - Decorators are functions called at runtime with the target (class/prototype), key, descriptor / param index.
  - Factories return the decorator; composition: factories top→bottom, calls bottom→top.
  - Evaluation order: instance members (params then method/accessor/property) → static members → constructor params → class.
  - Class decorator may **replace** the constructor (must keep prototype). Replacement **does not** add properties to the TS type.
  - Method/accessor decorators wrap `PropertyDescriptor`. Cannot decorate both get and set separately.
  - Property decorators observe name only (no descriptor).
  - Parameter decorators observe index only.
  - `emitDecoratorMetadata` + `reflect-metadata` emits `design:type`, `design:paramtypes`, `design:returntype` at runtime.
- Runtime equivalent:
  - **JS/TS:** decorators **run**. Capture sees the **decorated** class/method as used (wrapped methods, replaced constructors). Design:type metadata, if present, is an extra capture hint (`Reflect.getMetadata`) — useful when values are unobserved.
  - **Python:** `@decorator` wrapping is ubiquitous; capture the wrapped callable’s runtime signature/return. `dataclass`, `property`, `functools.wraps` — unwrap `__wrapped__` when inferring.
- Required TypeNode ops / capture changes:
  - No new TypeNode kinds. Optional: read `design:paramtypes` as a **hint** unioned with capture.
  - Unwrap `__wrapped__` / decorator wrappers so the inner function’s captures still attach.
- Status: **emit-only** for decorator emit and `emitDecoratorMetadata`. **N/A declaration-only** for the experimental flag and the fact that decorator-added fields are invisible to TS. **must-implement** only as “observe the runtime value after decoration” (already true if we wrap the exported function).

---

## Declaration Merging

- URL: https://www.typescriptlang.org/docs/handbook/declaration-merging.html
- Type-system behaviors:
  - Multiple declarations of the same name merge into one.
  - Each declaration contributes to **namespace / type / value** spaces (table: Namespace, Class, Enum, Interface, Type alias, Function, Variable).
  - **Interfaces merge:** members join; non-function members must be identical; functions become overloads (later group first; **string-literal specialized signatures bubble to the top**).
  - **Namespaces merge** exported members; unexported members stay file-private.
  - Namespace can merge with **class** (inner classes / statics), **function** (function + properties — `buildLabel.prefix`), **enum** (static methods).
  - **Disallowed:** class+class, class+variable. Mixins instead.
  - **Module augmentation:** `declare module "./obs" { interface Observable<T> { map… } }` patches exports. No new top-level names; no `default` augment.
  - **Global augmentation:** `declare global { interface Array<T> { … } }`.
- Runtime equivalent:
  - **JS/TS:** merging models JS patterns: function-with-properties, class statics, interface patches. Capture of `fn.prefix` is an object property on a function (call signature + props). Prototype patches (`Observable.prototype.map`) appear as methods if we walk prototypes.
  - **Python:** no declaration merging. Closest: stub + runtime class, or monkeypatching. Capture the runtime object after patches.
- Required TypeNode ops / capture changes:
  - Merge object types / overload lists when **unifying** captures of the same name (same as interface merge, but structural).
  - Function+properties node (already listed under Functions).
  - Module augmentation: N/A as syntax; resulting shape is just the captured class.
- Status: **N/A declaration-only** for `declare module` / `declare global` / namespace merge syntax. **must-implement** for the **resulting** types: merged object members, function-with-props, overload ordering when checking.

---

## Enums

- URL: https://www.typescriptlang.org/docs/handbook/enums.html
- Type-system behaviors:
  - TypeScript-only runtime feature (not a type-level erase).
  - **Numeric enums:** auto-increment; optional initializers; mixing computed/constant members has ordering rules.
  - **String enums:** every member initialized with a string literal (or another string enum member); serialize well; **no reverse mapping**.
  - Heterogeneous enums allowed but discouraged.
  - Constant vs computed members; constant expressions evaluated at compile time (`NaN`/`Infinity` illegal).
  - **Literal/union enums:** members are types; enum type is the union of members; enables exhaustiveness / overlap errors.
  - Enums are runtime objects (can be passed as `{ X: number }`).
  - `keyof typeof E` for member **names**; `keyof E` is surprising — use `keyof typeof`.
  - **Reverse mapping** for numeric enums (`E[0] === "A"`).
  - **`const enum`:** fully inlined, no object (pitfalls with `isolatedModules`, version skew, ambient const enums).
  - Ambient enums: missing initializers treated as computed.
  - Alternative: `as const` object + `typeof O[keyof typeof O]`.
- Runtime equivalent:
  - **JS/TS:** real objects. Capture `Direction.Up` as a **literal** `1` or `"UP"` plus optional enum name. Reverse-map objects look like `{ Up: 1, 1: "Up" }` — detect and model as enum, not a weird object.
  - **Python:** `enum.Enum` / `IntEnum` / `StrEnum`. Capture today collapses to `primitive:string` — **must change** to literal + enum name (`class_name` or `{kind:"enum", name, value}`). Members are values; `Color.RED` vs `"RED"` vs `1`.
- Required TypeNode ops / capture changes:
  - Enum TypeNode: name, member names, values (numeric | string literals), union of values for assignability.
  - Numeric enums assignable to/from `number` (compat page); different enum types incompatible.
  - Capture Python `enum.Enum` as enum/literal, not plain string.
  - `const enum`: **emit-only** (inlined numbers/strings — capture still sees the primitive).
- Status: **must-implement** for runtime enums (TS + Python). **emit-only** for `const enum` inlining. **N/A declaration-only** for ambient `declare enum` without a runtime object.

---

## Iterators and Generators

- URL: https://www.typescriptlang.org/docs/handbook/iterators-and-generators.html
- Type-system behaviors:
  - Iterable iff `Symbol.iterator` present. Built-ins: Array, Map, Set, String, typed arrays.
  - `Iterable<X>`; `for..of` uses `Symbol.iterator`.
  - `for..in` iterates **keys** (any object); `for..of` iterates **values** of iterables.
  - ES5 target: `for..of` only on arrays (emit a `for` index loop). ES2015+: native iterators.
  - (Page does not fully cover generators; `Generator<T, TReturn, TNext>` / `AsyncGenerator` live in lib types.)
- Runtime equivalent:
  - **JS/TS:** capture arrays/maps/sets as those kinds. Custom iterables: if we only `Object.keys` we miss the element type — iterating a sample (`for (const x of xs)` with a cap) yields `array` element type. Generators: capturing the generator object is opaque; capture **yielded** values instead.
  - **Python:** `collections.abc.Iterable` / `Iterator` / `Generator`; generators currently `{primitive: Generator}` — too opaque. Sample a few `next()` values when safe, or capture yields via tracing. `async for` similar.
- Required TypeNode ops / capture changes:
  - `Iterable<T>` can be modeled as `{ iterator: () => { next: () => { value: T, done: boolean } } }` or a dedicated `kind: "iterable", element`.
  - Prefer capturing **element** types (already done for Array/Map/Set).
  - Generator: `{ kind: "iterable", element, return?, native: "generator" }` instead of a primitive name.
  - **emit-only** for ES5 `for..of` lowering.
- Status: **must-implement** element types of iterables. **emit-only** for ES5 generation. Generator object internals: must-implement as opaque+element if sampled.

---

## JSX

- URL: https://www.typescriptlang.org/docs/handbook/jsx.html
- Type-system behaviors:
  - `.tsx` + `jsx` mode: `preserve` | `react` | `react-native` | `react-jsx` | `react-jsxdev`.
  - `as` assertions required in `.tsx` (no `<T>x`).
  - **Intrinsic** (lowercase, `JSX.IntrinsicElements`) vs **value-based** (uppercase components).
  - `JSX` namespace location depends on factory (`React.JSX`, `h.JSX`, or `jsx-runtime`).
  - Function vs class components; props from first param or `JSX.ElementAttributesProperty`.
  - Attribute checking, spread, `JSX.IntrinsicAttributes` (`key`), `IntrinsicClassAttributes` (`ref`).
  - Children via `JSX.ElementChildrenAttribute` (`children`).
  - Result type `JSX.Element` (black box). TS 5.1 `JSX.ElementType` for valid component types.
  - `jsxFactory` / `jsxFragmentFactory` / `jsxImportSource`.
- Runtime equivalent:
  - **JS/TS:** JSX emits `createElement`/`jsx` calls. Capture **props objects** and return values of components (React elements are objects with `type`, `props`, `key`). Element TypeNode: `{ class_name: "ReactElement", properties: { type, props, key } }` or similar.
  - **Python:** no JSX. Closest: template/component props dicts (FastAPI/Jinja, Streamlit, Dash). Same object TypeNodes.
- Required TypeNode ops / capture changes:
  - Treat component functions as `function` with a props object param + element return.
  - Optional specialized `class_name` for React elements so they stay opaque-ish (avoid exploding fiber internals — same as today’s OPAQUE_CLASSES).
- Status: **emit-only** for JSX factories/modes/file extensions. **N/A declaration-only** for `JSX` namespace plumbing. **must-implement** for **props object types** of captured components (ordinary object/function algebra).

---

## Mixins

- URL: https://www.typescriptlang.org/docs/handbook/mixins.html
- Type-system behaviors:
  - Constrained constructor type `type Constructor<T = {}> = new (...args: any[]) => T`.
  - Mixin as `function Scale<TBase extends Constructor>(Base: TBase) { return class extends Base { … } }`.
  - Constraints on the base (`Positionable`, `Loggable`).
  - Alternative: runtime `applyMixins` + interface merge of the same name as the class.
  - Decorators do **not** mixin-merge into the type (`#4881`).
  - Static property mixins / singletons gotcha (`#17829`).
- Runtime equivalent:
  - **JS/TS:** the composed class is a real constructor. Capture instances of `EightBitSprite` as `object` + `class_name` with the **merged** properties (`scale` + `Sprite` fields). No mixin IR required.
  - **Python:** mixins are ordinary base classes (`class C(MixinA, MixinB)`); MRO flattens fields. Capture the instance shape.
- Required TypeNode ops / capture changes:
  - Constructor generics (see Generics / Classes).
  - `intersect` instance types when modeling `applyMixins`.
- Status: **must-implement** as ordinary class instance shapes + constructor types. Mixin *syntax* is N/A.

---

## Namespaces

- URL: https://www.typescriptlang.org/docs/handbook/namespaces.html
- Type-system behaviors:
  - `namespace Validation { export class … }` — named JS object in the global/script world.
  - Unexported members are private to the namespace (per declaration, see merging).
  - Split across files via `/// <reference path= />` + `outFile` or many `<script>` tags.
  - Aliases: `import polygons = Shapes.Polygons` (not `require`).
  - Ambient `declare namespace D3` for global libraries.
- Runtime equivalent:
  - **JS/TS:** a namespace value is a nested object of exports. Capture that object.
  - **Python:** packages/modules, not namespaces.
- Required TypeNode ops / capture changes:
  - Nested `object` types. Nothing special.
- Status: **N/A declaration-only** as a TS organizing construct / ambient `.d.ts`. **emit-only** for `outFile` concatenation and IIFE namespace emit. Captured global objects are ordinary objects (**must-implement** as objects).

---

## Namespaces and Modules

- URL: https://www.typescriptlang.org/docs/handbook/namespaces-and-modules.html
- Type-system behaviors:
  - Modules: ES/CJS, one file ↔ one module, need a loader.
  - Namespaces: global objects, can span files, `outFile`.
  - Pitfall: `/// <reference>` to load a **module** instead of `import`.
  - Pitfall: `export namespace Shapes` inside a module (needless extra layer).
  - `outFile` + modules only for `amd`/`system` (historical).
- Runtime equivalent:
  - Same as Modules + Namespaces. Prefer module export maps.
- Required TypeNode ops / capture changes:
  - None beyond module environments.
- Status: **N/A declaration-only** (style/guidance). **emit-only** for `outFile` constraints.

---

## Symbols

- URL: https://www.typescriptlang.org/docs/handbook/symbols.html
- Type-system behaviors:
  - `symbol` primitive; `Symbol()` / `Symbol("key")` unique even with same description.
  - Usable as property keys (`{ [sym]: "value" }`); computed class members.
  - **`unique symbol`:** subtype of `symbol`; only on `const` or `readonly static`; referenced via `typeof sym`. Distinct unique symbols do not overlap / are not assignable.
  - Well-known symbols: `iterator`, `asyncIterator`, `hasInstance`, `isConcatSpreadable`, `match`, `replace`, `search`, `species`, `split`, `toPrimitive`, `toStringTag`, `unscopables`.
- Runtime equivalent:
  - **JS/TS:** capture `typeof === "symbol"` already → `primitive:symbol`. Unique identity is lost unless we store a description or intern well-known symbols (`Symbol.iterator`). Symbol **keys** are missed by `Object.keys` — need `Object.getOwnPropertySymbols` for complete objects.
  - **Python:** no symbols. Closest: interned sentinel objects (`object()`), `enum` flag bits. Well-known protocols use dunders (`__iter__`, `__aiter__`) rather than symbols.
- Required TypeNode ops / capture changes:
  - Optional `{ kind: "unique-symbol", id, description? }` for captured well-known or const symbols.
  - Include symbol keys in object properties (serialized key like `@@iterator` or description).
  - Overlap: two unique-symbol types never overlap (narrowing page).
- Status: **must-implement** `symbol` primitive (done) + symbol keys on objects. **must-implement** unique-symbol identity if we care about well-known protocol detection. Python: N/A for the primitive; dunders map to protocols instead.

---

## Triple-Slash Directives

- URL: https://www.typescriptlang.org/docs/handbook/triple-slash-directives.html
- Type-system behaviors:
  - Compiler XML comments: `reference path`, `types`, `lib`, `no-default-lib`, `amd-module`, deprecated `amd-dependency`.
  - Only valid at file top. TS 5.5 does not emit them unless `preserve="true"`.
  - Preprocess graph for `outFile` order; `noResolve` ignores them.
- Runtime equivalent:
  - None. Not values, not types.
- Required TypeNode ops / capture changes:
  - None.
- Status: **N/A declaration-only**.

---

## Type Compatibility

- URL: https://www.typescriptlang.org/docs/handbook/type-compatibility.html
- Type-system behaviors:
  - **Structural subtyping:** `x` compatible with `y` if `y` has at least `x`’s members (recursively). Nominal `implements` not required (`Dog` assignable to `Pet` if it has `name: string`).
  - Extra properties OK on **non-fresh** values; fresh literals still get excess property checks (Everyday/Object Types).
  - **Functions — parameters:** names ignored; each param of source must match a param of target. **Fewer params assignable to more params** (`item => …` assignable to `(item, index, array) => …`).
  - **Functions — returns:** source return must be a subtype of target return (covariant returns).
  - **Parameter bivariance:** param types succeed if either direction assigns (unsound; models event handlers). `strictFunctionTypes` makes **function type params contravariant** (methods still bivariant historically).
  - Optional and required params interchangeable for compatibility; rest ≡ infinite optionals.
  - **Overloads:** every target overload must be matched by some source signature.
  - **Enums:** compatible with `number` and vice versa; **different enum types incompatible**.
  - **Classes:** compare **instance** members only (ignore statics/constructors), except `private`/`protected` which are nominal (same originating class).
  - **Generics:** unused type params don’t affect structure (`Empty<number>` ≡ `Empty<string>`). When unspecified, substitute `any` then compare.
  - **Subtype vs assignment:** assignment = subtype + `any` rules + enum↔number. `implements`/`extends` use assignment compatibility.
  - **Top/bottom assignability table** (`strictNullChecks` on/off):
    - Everything assignable to itself.
    - `any` is assignable **to** every type except `never`. Every type except `never` is assignable **to** `any` (and `never` is assignable to `any` as well — `never` goes everywhere).
    - `unknown` is a top type: everything assignable **to** `unknown`; `unknown` assignable only to `any`/`unknown`.
    - `never` is a bottom type: assignable **to** everything; nothing else assignable **to** `never`.
    - `void`: assignable to `any`/`unknown`; `undefined` assignable to `void`; `null` to `void` only if strictNullChecks off.
    - `strictNullChecks` off: `null`/`undefined` behave like bottom-ish (assignable to most types).
    - `strictNullChecks` on: `null`/`undefined` only to `any`/`unknown`/`void` (`undefined` → `void` always) and themselves.
    - `object`: non-primitives; assignable to `any`/`unknown`.
- Runtime equivalent:
  - **JS/TS:** assignability is the **checker**. Capture never “assigns”; it records shapes. Checking a new observation against the accumulated TypeNode **is** `isAssignable(observed, expected)` plus optional excess-property on literals.
  - **Python:** structural typing is how duck typing works. `Protocol` / `TypedDict` are structural; classes are nominal in `isinstance` but Trickle should **check structurally** (same checker). `None` only vs `null`. No `undefined`/`void`. `int` is not a `float` in typing (`int` *is* a subtype of `float` in PEP 484 — **intentional special case**; JS has no analogue). Enums: Python enums are **not** compatible with raw `int` unless `IntEnum`.
- Required TypeNode ops / capture changes:
  - **`isAssignable(source, target, opts)`** — the central op. Options: `strictNullChecks`, `strictFunctionTypes`, `freshLiteral`, `enumNumberCompat`.
  - Recursive object member check; function param/return rules; union (source assignable if assignable to **some** member; target union: source must assign to **some** — actually: `S` assignable to `T1|T2` if `S` assignable to `T1` **or** `T2`; `S1|S2` assignable to `T` if **both** `S1` and `S2` assignable to `T`).
  - Intersection: assignable to `A & B` iff assignable to both.
  - `any`/`unknown`/`never`/`void` table.
  - Private/protected: only if we model origin IDs (optional; Python/JS capture won’t see TS `private`).
- Status: **must-implement** (product core). Soundness holes (bivariance, readonly ignoring, enum↔number) should be **flags**, defaulting to TS-like behavior for JS and stricter/PEP-484-like for Python where they differ.

---

## Type Inference

- URL: https://www.typescriptlang.org/docs/handbook/type-inference.html
- Type-system behaviors:
  - Inference sites: variable/member initializers, default params, function return types.
  - **Best common type:** from candidate types, pick one assignable from all others; else **union of candidates**. `[0, 1, null]` → `number | null` (with strictNullChecks). `[Rhino, Elephant, Snake]` → union, **not** automatically `Animal[]` unless `Animal` is a candidate (e.g. contextual return type).
  - **Contextual typing:** the expected type flows **in** (assignment RHS, call arguments, object/array members, returns, assertions). Window event handlers: `onmousedown` ⇒ `MouseEvent`. Contextual type is also a **candidate** in best common type (`createZoo(): Animal[]` can pick `Animal`).
  - Without context, callback params are implicit `any` (`noImplicitAny`).
- Runtime equivalent:
  - **JS/TS:** Trickle’s unify across samples **is** best common type: identical structure → that type; else union. There is no `Animal` super unless `class_name` heritage is captured and a shared base appears. Contextual typing has no runtime analogue unless checking **against** an existing signature (the accumulated type **is** the context for the next observation).
  - **Python:** same unify. `None` in a list → `integer | null` not `number | null`. ABC/base class: use MRO intersection as an extra candidate (optional).
- Required TypeNode ops / capture changes:
  - `bestCommonType(candidates[], context?)` = unify with assignability, not only structural equality (so `1` and `2` literals → `number` if widened; or keep `"GET" | "POST"` if all literals).
  - Widening policy: object fields widen literals; `as const`/frozen/`const` bindings keep literals.
  - Contextual check: `isAssignable(observed, expected)` on new captures.
  - Optional heritage: if all class_names share a base, consider that base as a candidate.
- Status: **must-implement**.

---

## Variable Declaration

- URL: https://www.typescriptlang.org/docs/handbook/variable-declarations.html
- Type-system behaviors:
  - `var` function-scoping / hoisting vs `let`/`const` block scoping, TDZ, no redeclaration.
  - `const` bindings are not reassignable; **object contents still mutable**. `const` infers a widened primitive from a literal (`"hello"` → `string` unless `as const`).
  - **Destructuring:** array (incl. rest, holes), tuple (element types, rest yields shorter tuple, over-destructure error), object (rename, defaults, nested, rest object `Omit`-like leftover).
  - Defaults in destructuring make the binding non-undefined; the source property remains optional.
  - Spread: object spread later-wins; array spread; rest in objects (omit picked keys).
  - **`using` / `await using`:** Explicit Resource Management; dispose via `Symbol.dispose` / `Symbol.asyncDispose` at block exit (try/finally). Works in `for`/`for..of`. Downlevel emit for older runtimes.
- Runtime equivalent:
  - **JS/TS:** capture the **value**, not the binding kind. `const` vs `let` affects whether we should keep literals (heuristic: many languages treat captured constants as literals). Destructuring is just access: tuple index / object pick / rest = `Omit`. `using` values are objects with dispose — capture as `class_name` + optional protocol flag (Python context managers already special-cased).
  - **Python:** no `var`/`let`; locals/`global`/`nonlocal`. Unpacking `a, *rest = xs` ≡ tuple destructuring. `with` / `async with` ≡ `using`. Context managers already `{class_name: "ContextManager"}` or the class name.
- Required TypeNode ops / capture changes:
  - Destructuring as derived TypeNodes: `index`, `Pick`, `Omit`, rest tuples.
  - Optional: `const`-like literal preservation flag on observations.
  - `using`: recognize `Symbol.dispose` / `__enter__`+`__exit__` (Python already does).
- Status: **must-implement** for destructuring-related type ops (tuples/objects). **N/A declaration-only** for scoping/TDZ/hoisting. **emit-only** for `using` downlevel and `var` emit.

---

## Python mapping

One TypeNode algebra serves both languages. Capture **normalizes** Python values into the same kinds JS uses, with a few extra primitive names and `class_name`s. The checker should be language-aware only where falsiness, numeric towers, and nullish differ.

### Primitive table

| Python runtime | Typing / annotation | TypeNode | TS analogue |
| --- | --- | --- | --- |
| `None` | `None` / `NoneType` | `{kind:"primitive", name:"null"}` | `null` |
| *(no analogue)* | | `{kind:"primitive", name:"undefined"}` | `undefined` — **never emitted by Python capture** |
| `bool` (`True`/`False`) | `bool` / `Literal[True]` | `boolean` or **boolean literal** | `boolean` / `true`/`false` |
| `int` | `int` | `{kind:"primitive", name:"integer"}` | no JS twin; **do not** unify with `number` unless a flag models PEP 484 `int <: float` |
| `float` | `float` | `number` | `number` (also `NaN`/`inf`) |
| `complex` | `complex` | object + `class_name:"complex"` (or a primitive if added) | none |
| `str` | `str` / `Literal["x"]` | `string` or **string literal** | `string` / `"x"` |
| `bytes` / `bytearray` | `bytes` | `{kind:"primitive", name:"bytes"}` | `Uint8Array` / `Buffer` (JS capture uses object markers today) |
| `datetime`/`date`/`time` | `datetime.*` | primitives `datetime`/`date`/`time` | `Date` (JS uses object + `__date`) — **normalize** to one story (`class_name:"Date"` vs primitive) |
| `enum.Enum` member | `Color` / `Literal[Color.RED]` | **enum/literal** (today wrongly `string`) | TS `enum` or union of literals |

`Optional[T]` / `T | None` ≡ `union(T, null)`. There is no Python `undefined`; missing dict keys are **absence** (optional property), not `undefined`.

### Containers

| Python | TypeNode | TS |
| --- | --- | --- |
| `list` homogeneous | `array` | `T[]` |
| `list` small heterogeneous | `tuple` + `class_name:"list"` | `[A,B,…]` (display as list) |
| `tuple` | `tuple` | `[…]` |
| `namedtuple` / `NamedTuple` | `object` + `class_name` | interface |
| `set` / `frozenset` | `set` | `Set<T>` / `ReadonlySet<T>` |
| `dict` small / mixed values | `object` (+ `class_name:"dict"`) | `{ k: v }` |
| `dict` large uniform | `map` `{key:string, value:V}` | `Record<string, V>` / `Map` |
| `TypedDict` | `object` (optional keys from `total=False` / `NotRequired`) | interface / `Partial` |
| `Mapping` / `MutableMapping` | `map` | `Record` / `Map` |

### Unions, optionality, narrowing

- `typing.Union` / `|` observed across calls → `union` members (flatten/dedup).
- `Optional[T]` → `T | null`. Unify: if some calls pass `None`, add `null`; if some omit a kwarg, mark **optional** (Python kwargs ≅ optional params).
- Narrowing: `x is None`, `isinstance(x, int)`, `match` tags, `hasattr`. Falsy set **includes empty list/dict/set** — do **not** reuse JS `narrowTruthy` unchanged.
- Discriminated unions: dataclass `kind: Literal["circle"]` fields — needs **literals**.

### Functions and generics

- `def f(a: int, b: str | None = None, *args, **kwargs)` → function TypeNode with optional `b`, rest `args` (tuple/array), `kwargs` as `map` or object.
- `@overload` stubs are declaration-only; runtime is one function — **unify call-site signatures** like TS overloads.
- `TypeVar` / `Generic[T]` / `ParamSpec` / `Concatenate`: same generalization as TS generics; **correlate per call**.
- `Protocol` is structural — `isAssignable` already.
- `Callable[[A,B], R]` ≡ function TypeNode.
- Return `None` is `null`, not `void`. Use `void` only if we never observed a return (JS functions that fall off the end return `undefined`).

### Classes, objects, nominal vs structural

- Instances → `object` + properties + `class_name`.
- Dataclass / Pydantic / attrs / namedtuple: fields as properties (already).
- ABC/`abstractmethod`: declaration-only; instances are concrete.
- `isinstance` narrowing uses `class_name` + MRO (`heritage[]`).
- Trickle **checks structurally** (TS-like) even though Python programmers think nominally — that is the point of one checker. Display `class_name` for errors (`expected Tensor, got ndarray`).

### Enums

- `enum.Enum` → enum TypeNode (name + value). `IntEnum` assignable to `integer`; `StrEnum` to `string`; plain `Enum` **not** to `int`/`str` unless the value is used (`member.value`).

### Tensors and scientific types (Python-first, same object kind)

These are **objects with `class_name` and property TypeNodes**, not new kinds. The checker treats them as structural objects; display/codegen may special-case.

| Runtime | `class_name` | Notable properties |
| --- | --- | --- |
| `torch.Tensor` | `Tensor` | `shape`, `dtype`, `device`, `requires_grad`, stats, `nan_count`… |
| `numpy.ndarray` | `ndarray` | `shape`, `dtype`, memory, stats |
| `mlx.array` | `mlx.array` | `shape`, `dtype` |
| `pandas.DataFrame` / `Series` | `DataFrame` / `Series` | columns/dtype/shape |
| `nn.Module`, Optimizer, DataLoader, Dataset | those names | architecture/hparams |
| HuggingFace `Dataset` / `DatasetDict` | those names | splits/columns |

JS analogues: `TypedArray`, `tf.Tensor` if captured — same pattern (`class_name` + props). **Do not** invent a separate `kind: "tensor"` unless ops need it; `object` + `class_name` already unifies.

Shape/dtype strings are currently stuffed into `primitive.name` (e.g. `"[32, 768]"`). A later refinement: `{kind:"tuple", elements: literal numbers}` for shape and a string/literal for dtype so `index`/`unify` can compare ranks.

### Language-specific assignability flags

| Rule | JS/TS (TS-like) | Python (PEP 484-like) |
| --- | --- | --- |
| `null` vs missing | `null` ≠ `undefined` ≠ absent | only `None` vs absent |
| `int` vs `float` | n/a (`number`) | `int` assignable to `float`; not vice versa |
| enum vs number | numeric enum ↔ `number` | only `IntEnum` ↔ `int` |
| extra object keys | allowed except fresh literals | allowed (duck typing); TypedDict may excess-check |
| function arity | fewer params OK | extra required params not OK; defaults optional |
| falsy narrowing | `0`, `""`, `NaN`, `null`, `undefined`, `0n` | those **plus** empty containers |
| `typeof null` | `"object"` | `None` is `NoneType`, not an object |

### Capture gaps to close so one checker works

1. **Literals** (both languages) — discriminants, `keyof`, templates, enum members.
2. **Optional vs missing vs null** on object properties and function params.
3. **Per-call arg/return pairs** — generics (`T -> T`) instead of independent unions.
4. **Python enums** not as `string`.
5. **JS function** node richness (optional/rest/`this`/construct) to match Python `inspect.signature`.
6. **Promise/awaitable unwrap** (`Awaited`).
7. **Symbol/dunder protocol keys** when modeling iterables.
8. **Normalize Date/datetime** representation across languages.

---

## TypeNode operator checklist (product)

Implement these as functions over TypeNode. Pages in parentheses.

| Op | Role |
| --- | --- |
| `unify` / `bestCommonType` | Inference, capture merge |
| `widen` / `keepLiterals` | Literal inference, `as const` |
| `isAssignable` | Compatibility, conditionals, `extends` |
| `typesOverlap` | Unintentional comparisons |
| `intersect` | `&`, mixin instance types |
| `keyof` / `index` | Type operators |
| `mapType` | Mapped types + Partial/Required/Readonly/Pick/Omit/Record |
| `exclude` / `extract` / `nonNullable` | Unions, narrowing, utilities |
| `conditional` + `inferFrom` | Conditionals, utilities |
| `template` + string intrinsics | Template literals |
| `parameters` / `returnType` / `awaited` / `instanceType` / `constructorParameters` | Utilities, `typeof` |
| `narrowTypeof` / `narrowTruthy` / `narrowEq` / `narrowIn` / `narrowInstanceof` / `discriminate` / `complement` | Narrowing |
| `checkFreshLiteral` | Excess property checks |
| `generalize` / `instantiate` | Generics |
| `optionalizeProperty` (unify missing keys) | Everyday/Object |

---

## Page index

| # | Page | Status (primary) |
| --- | --- | --- |
| 1 | The Basics | must-implement (+ N/A tsc/emit) |
| 2 | Everyday Types | must-implement |
| 3 | Narrowing | must-implement |
| 4 | More on Functions | must-implement |
| 5 | Object Types | must-implement |
| 6 | Type Manipulation | must-implement (index) |
| 7 | Generics | must-implement |
| 8 | Keyof | must-implement |
| 9 | Typeof | must-implement |
| 10 | Indexed Access | must-implement |
| 11 | Conditional Types | must-implement |
| 12 | Mapped Types | must-implement |
| 13 | Template Literal Types | must-implement |
| 14 | Classes | must-implement (+ N/A abstracts/syntax) |
| 15 | Modules | N/A declaration-only (export map: must-implement) |
| 16 | Utility Types | must-implement |
| 17 | Decorators | emit-only / N/A (+ observe wrapped values) |
| 18 | Declaration Merging | N/A declaration-only (merged shapes: must-implement) |
| 19 | Enums | must-implement |
| 20 | Iterators and Generators | must-implement (elements) + emit-only ES5 |
| 21 | JSX | emit-only / N/A (+ props objects must-implement) |
| 22 | Mixins | must-implement as classes |
| 23 | Namespaces | N/A declaration-only |
| 24 | Namespaces and Modules | N/A declaration-only |
| 25 | Symbols | must-implement |
| 26 | Triple-Slash Directives | N/A declaration-only |
| 27 | Type Compatibility | must-implement |
| 28 | Type Inference | must-implement |
| 29 | Variable Declaration | must-implement (destructure ops) + N/A scoping + emit-only `using` |

**Page count: 29** handbook/reference pages catalogued, plus the Python mapping and operator checklist.
