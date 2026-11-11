// Reachability pruning for top-level declarations of one JS file.
// Roots are every statement that is not a plain declaration. A declaration is removed only when no
// root reaches it. Sink calls (a call whose only effect is mutating private state nobody else reads)
// and BLA's shadow runtime (decorative init blocks and shadow-heap churn calls, see `shadowCuts`)
// are removed first, so the state and the functions become unreachable too.
import { runInNewContext } from "node:vm";
import { kids, parseJs, patternNames, reboundNames, walk, type AnyNode, type Program, type Seed } from "./js.ts";

export interface PruneStats {
  declarationsRemoved: number;
  sinkCallsRemoved: number;
  shadowRuntimeRemoved: number;
}

/** Identifier uses that read or write a binding; property names and labels are not uses. */
export function uses(n: AnyNode, out: string[] = []): string[] {
  switch (n.type) {
    case "Identifier":
      out.push(n.name);
      return out;
    case "MemberExpression":
      uses(n.object, out);
      if (n.computed) uses(n.property, out);
      return out;
    case "Property":
    case "MethodDefinition":
    case "PropertyDefinition":
      if (n.computed) uses(n.key, out);
      if (n.value) uses(n.value, out);
      return out;
    case "BreakStatement":
    case "ContinueStatement":
      return out;
    case "LabeledStatement":
      return uses(n.body, out);
    default:
      for (const k of kids(n)) uses(k, out);
      return out;
  }
}

function declaredIn(fn: AnyNode): Set<string> {
  const names = new Set<string>();
  const bind = (p: AnyNode) => {
    const out: string[] = [];
    patternNames(p, out);
    out.forEach((x) => names.add(x));
  };
  walk(fn, (n) => {
    if (n.type === "VariableDeclarator") bind(n.id);
    else if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") n.params.forEach(bind);
    else if (n.type === "CatchClause" && n.param) bind(n.param);
  });
  return names;
}

/** Initializers that cannot have effects, so an unreferenced declaration may go. */
export function pure(n: AnyNode | null | undefined): boolean {
  if (!n) return true;
  switch (n.type) {
    case "Literal":
    case "Identifier":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return true;
    case "ArrayExpression":
      return n.elements.every((e) => e !== null && e.type !== "SpreadElement" && pure(e));
    case "ObjectExpression":
      return n.properties.every((p) => p.type === "Property" && !p.computed && pure(p.value));
    case "UnaryExpression":
      return pure(n.argument);
    case "BinaryExpression":
      return n.left.type !== "PrivateIdentifier" && pure(n.left) && pure(n.right);
    case "NewExpression":
      return n.callee.type === "Identifier" && ["Array", "Map", "Set"].includes(n.callee.name) && n.arguments.every((a) => a.type !== "SpreadElement" && pure(a));
    case "CallExpression": {
      const c = n.callee;
      if (c.type !== "MemberExpression" || c.computed || c.property.type !== "Identifier") return false;
      const okArgs = n.arguments.every((a) => a.type !== "SpreadElement" && pure(a));
      // Object.freeze(pure) and pure.fill(pure): no effect beyond the new value
      return okArgs && ((c.object.type === "Identifier" && c.object.name === "Object" && c.property.name === "freeze") || (c.property.name === "fill" && pure(c.object as AnyNode)));
    }
    default:
      return false;
  }
}

const SAFE_GLOBALS = new Set(["Math", "Number", "String", "Array", "Object", "parseInt", "parseFloat", "undefined", "NaN", "Infinity"]);

/** Initializer that reads only its own locals and plain builtins: building it has no outside effect. */
function selfContained(n: AnyNode | null | undefined): boolean {
  if (!n) return true;
  const local = declaredIn(n);
  let ok = true;
  walk(n, (x) => {
    if (x.type === "ThisExpression" || x.type === "AwaitExpression" || x.type === "YieldExpression" || x.type === "ImportExpression") ok = false;
  });
  return ok && uses(n).every((u) => local.has(u) || SAFE_GLOBALS.has(u));
}

interface Decl {
  name: string; // "" for keep-alive statements
  node: AnyNode;
  uses: string[];
  isFn: boolean;
  isState: boolean;
}

export const isKeepAlive = (st: AnyNode): boolean =>
  st.type === "ExpressionStatement" &&
  st.expression.type === "UnaryExpression" &&
  st.expression.operator === "void" &&
  (st.expression.argument.type === "Identifier" || (st.expression.argument.type === "ArrayExpression" && st.expression.argument.elements.every((e) => e?.type === "Identifier")));

function classify(ast: Program, seedNames: string[]): { decls: Decl[]; roots: AnyNode[] } {
  const decls: Decl[] = [];
  const roots: AnyNode[] = [];
  for (const st of ast.body) {
    const one = st.type === "VariableDeclaration" && st.declarations.length === 1 ? st.declarations[0]! : undefined;
    if (isKeepAlive(st)) decls.push({ name: "", node: st, uses: [], isFn: false, isState: false });
    else if (st.type === "FunctionDeclaration" && st.id) decls.push({ name: st.id.name, node: st, uses: uses(st), isFn: true, isState: false });
    else if (st.type === "ClassDeclaration" && st.id) decls.push({ name: st.id.name, node: st, uses: uses(st), isFn: false, isState: false });
    else if (one && one.id.type === "Identifier" && seedNames.includes(one.id.name)) decls.push({ name: one.id.name, node: st, uses: uses(st), isFn: false, isState: false });
    else if (one && one.id.type === "Identifier" && (pure(one.init) || selfContained(one.init))) decls.push({ name: one.id.name, node: st, uses: uses(st), isFn: false, isState: true });
    else roots.push(st);
  }
  return { decls, roots };
}

/** Statement bodies where a sink call can be dropped without leaving an empty `if (x) ;`. */
function bodies(ast: AnyNode): AnyNode[][] {
  const out: AnyNode[][] = [];
  walk(ast, (n) => {
    if (n.type === "Program" || n.type === "BlockStatement" || n.type === "StaticBlock") out.push(n.body);
    else if (n.type === "SwitchCase") out.push(n.consequent);
  });
  return out;
}

function sinkCall(st: AnyNode): string | undefined {
  if (st.type !== "ExpressionStatement" || st.expression.type !== "CallExpression") return undefined;
  const { callee, arguments: args } = st.expression;
  return callee.type === "Identifier" && args.every((a) => a.type === "Literal") ? callee.name : undefined;
}

/**
 * Greatest set of functions F such that: F touches only its own locals, other sinks and private
 * state; its body has no `this`, `throw`, loop, member access, or call to anything but another
 * sink; F is not part of a call cycle (so it cannot throw or hang by its own code); that state
 * is used by sinks only; and every use of F outside the set is a droppable call statement (so
 * dropping all of them leaves F unreachable).
 */
function findSinks(decls: Decl[], roots: AnyNode[], rebound: Set<string>): Set<string> {
  const fns = new Set(decls.filter((d) => d.isFn && !rebound.has(d.name)).map((d) => d.name));
  const states = new Set(decls.filter((d) => d.isState && !rebound.has(d.name)).map((d) => d.name));
  const declOf = new Map(decls.map((d) => [d.name, d]));
  const callees = (name: string): string[] => {
    const d = declOf.get(name);
    if (d?.node.type !== "FunctionDeclaration") return [];
    const local = declaredIn(d.node);
    const out: string[] = [];
    walk(d.node.body, (x) => {
      if ((x.type === "CallExpression" || x.type === "NewExpression") && x.callee.type === "Identifier" && fns.has(x.callee.name) && !local.has(x.callee.name)) out.push(x.callee.name);
    });
    return out;
  };
  const inCycle = (name: string) => {
    const seen = new Set<string>();
    for (let stack = [name]; stack.length; ) {
      for (const u of callees(stack.pop()!)) {
        if (u === name) return true;
        if (!seen.has(u)) {
          seen.add(u);
          stack.push(u);
        }
      }
    }
    return false;
  };
  const callsTo = (node: AnyNode, name: string) => (sinkCall(node) === name ? 1 : 0) + bodies(node).flat().filter((st) => sinkCall(st) === name).length;
  for (let changed = true; changed; ) {
    changed = false;
    const outside = [...decls.filter((d) => !fns.has(d.name)).map((d) => ({ name: d.name, node: d.node, u: d.uses })), ...roots.map((r) => ({ name: "", node: r, u: uses(r) }))];
    for (const d of decls.filter((x) => fns.has(x.name))) {
      const local = declaredIn(d.node);
      let unsafe = false;
      walk(d.node, (x) => {
        if (x.type === "ThisExpression" || x.type === "ThrowStatement" || x.type === "MemberExpression" || x.type === "ForStatement" || x.type === "ForInStatement" || x.type === "ForOfStatement" || x.type === "WhileStatement" || x.type === "DoWhileStatement") unsafe = true;
        else if ((x.type === "CallExpression" || x.type === "NewExpression") && x.callee.type === "Identifier" && !fns.has(x.callee.name)) unsafe = true;
      });
      const escapes = unsafe || inCycle(d.name) || d.uses.some((u) => !local.has(u) && !fns.has(u) && !states.has(u) && u !== "Math" && u !== "undefined");
      const used = outside.reduce((n, o) => n + o.u.filter((u) => u === d.name).length, 0);
      const dropped = outside.reduce((n, o) => n + callsTo(o.node, d.name), 0);
      if (escapes || used !== dropped) {
        fns.delete(d.name);
        changed = true;
      }
    }
    for (const s of [...states]) {
      if (outside.some((o) => o.name !== s && o.u.includes(s))) {
        states.delete(s);
        changed = true;
      }
    }
  }
  return fns;
}

/** Platform methods that only compute a value; `freeze` is checked separately. */
const COMPUTE_ONLY = new Set(["isArray", "join", "includes", "createHash", "createHmac", "update", "digest"]);
const PLATFORM = new Set(["globalThis", "window", "process", "Object", "Array", "Boolean", "undefined"]);

/**
 * BLA's decorative init block: `(function () { try { ... } catch (e) {} })();`. No throw leaves the
 * empty catch-all. It writes only its own locals, calls only compute-only platform methods (method
 * names are taken to mean the platform method: the only outside names it reads are platform globals),
 * and its only outside effects are a global property and event listeners whose names appear nowhere
 * else in the file. Its loops count up to a literal or to the length of its own array literal.
 */
function decorativeInit(st: AnyNode, code: string): boolean {
  if (st.type !== "ExpressionStatement" || st.expression.type !== "CallExpression" || st.expression.arguments.length) return false;
  const fn = st.expression.callee;
  if (fn.type !== "FunctionExpression" || fn.params.length || fn.async || fn.generator) return false;
  const t = fn.body.body[0];
  if (fn.body.body.length !== 1 || t?.type !== "TryStatement" || t.finalizer || !t.handler || t.handler.body.body.length) return false;
  const local = declaredIn(fn);
  const writes = new Map<string, number>();
  const arrays = new Set<string>();
  walk(fn, (x) => {
    if (x.type === "FunctionExpression" && x.id) local.add(x.id.name);
    else if (x.type === "VariableDeclarator" && x.id.type === "Identifier" && x.init?.type === "ArrayExpression") arrays.add(x.id.name);
    const target = x.type === "AssignmentExpression" ? x.left : x.type === "UpdateExpression" ? x.argument : undefined;
    if (target?.type === "Identifier") writes.set(target.name, (writes.get(target.name) ?? 0) + 1);
  });
  const rest = code.slice(0, st.start) + code.slice(st.end);
  const privateName = (a?: AnyNode) => a?.type === "Literal" && typeof a.value === "string" && !rest.includes(a.value);
  const counted = (x: AnyNode): boolean => {
    if (x.type !== "ForStatement" || x.init?.type !== "VariableDeclaration" || x.init.declarations.length !== 1) return false;
    const { id, init } = x.init.declarations[0]!;
    if (id.type !== "Identifier" || init?.type !== "Literal" || typeof init.value !== "number" || writes.get(id.name) !== 1) return false;
    const { test, update } = x;
    if (update?.type !== "UpdateExpression" || update.operator !== "++" || update.argument.type !== "Identifier" || update.argument.name !== id.name) return false;
    if (test?.type !== "BinaryExpression" || test.operator !== "<" || test.left.type !== "Identifier" || test.left.name !== id.name) return false;
    const r = test.right;
    if (r.type === "Literal") return typeof r.value === "number";
    return r.type === "MemberExpression" && !r.computed && r.property.type === "Identifier" && r.property.name === "length" && r.object.type === "Identifier" && arrays.has(r.object.name) && !writes.has(r.object.name);
  };
  const allowedCall = (x: AnyNode & { type: "CallExpression" }): boolean => {
    const c = x.callee;
    const [a, b] = x.arguments;
    if (c.type === "Identifier") return c.name === "Boolean";
    if (c.type !== "MemberExpression" || c.computed || c.property.type !== "Identifier") return false;
    const m = c.property.name;
    const onObject = c.object.type === "Identifier" && c.object.name === "Object";
    if (m === "defineProperty") return onObject && privateName(b);
    if (m === "freeze") return onObject && (a?.type === "ObjectExpression" || a?.type === "ArrayExpression");
    if (m === "addEventListener") return privateName(a);
    if (m === "getBuiltinModule") return a?.type === "Literal" && (a.value === "node:crypto" || a.value === "crypto");
    return COMPUTE_ONLY.has(m);
  };
  let ok = true;
  walk(fn, (x) => {
    if (["ThisExpression", "NewExpression", "AwaitExpression", "YieldExpression", "ImportExpression", "MetaProperty", "TaggedTemplateExpression", "WhileStatement", "DoWhileStatement", "ForInStatement", "ForOfStatement"].includes(x.type)) ok = false;
    else if (x.type === "ForStatement") ok &&= counted(x);
    else if (x.type === "CallExpression") ok &&= allowedCall(x);
    else if (x.type === "AssignmentExpression") ok &&= x.left.type === "Identifier" && local.has(x.left.name);
    else if (x.type === "UpdateExpression") ok &&= x.argument.type === "Identifier" && local.has(x.argument.name);
    else if (x.type === "UnaryExpression" && x.operator === "delete") ok = false;
  });
  return ok && uses(fn).every((u) => local.has(u) || PLATFORM.has(u));
}

/** A step function of a churn group: reads only its locals, the group and `Math`; calls only those. */
function closedStep(fn: AnyNode, group: Set<string>): boolean {
  if (fn.type !== "FunctionDeclaration" || fn.async || fn.generator) return false;
  const local = declaredIn(fn);
  let ok = true;
  walk(fn, (x) => {
    if (["ThisExpression", "NewExpression", "ThrowStatement", "AwaitExpression", "YieldExpression", "ImportExpression", "MetaProperty", "TemplateLiteral", "FunctionExpression", "ArrowFunctionExpression", "ClassExpression"].includes(x.type)) ok = false;
    // no strings: a computed key can never be spelled `__proto__`
    else if (x.type === "Literal" && typeof x.value !== "number" && typeof x.value !== "boolean") ok = false;
    else if (x.type === "MemberExpression" && !x.computed && x.property.type === "Identifier" && ["__proto__", "constructor", "prototype"].includes(x.property.name)) ok = false;
    else if (x.type === "UnaryExpression" && x.operator === "delete") ok = false;
    else if (x.type === "CallExpression") {
      const c = x.callee;
      ok &&= (c.type === "Identifier" && group.has(c.name)) || (c.type === "MemberExpression" && c.object.type === "Identifier" && c.object.name === "Math");
    }
  });
  return ok && uses(fn).every((u) => local.has(u) || group.has(u) || u === "Math");
}

const CHURN_ROUNDS = 1000;

/**
 * Statements of BLA's shadow runtime that ran but that no other code can observe:
 * - decorative init blocks (`decorativeInit`);
 * - calls into a shadow-heap churn group: private state `var H` (self-contained initializer) and
 *   the functions that touch it, where nothing outside the group reads H and every outside use of
 *   a group function is a call statement with number arguments (so its result is unused). The calls
 *   are cut only if a sandbox run of the group (once before H is set, then CHURN_ROUNDS times) ends,
 *   never throws, keeps H's shape and leaves the builtins and globals alone.
 */
function shadowCuts(code: string, seedNames: string[]): AnyNode[] {
  const ast = parseJs(code);
  const { decls, roots } = classify(ast, seedNames);
  const out = roots.filter((st) => decorativeInit(st, code));
  const rebound = reboundNames(ast);
  const declared = declaredIn(ast);
  if (declared.has("Math") || decls.some((d) => d.name === "Math")) return out;
  const src = (n: AnyNode) => code.slice(n.start, n.end);
  for (const h of decls.filter((d) => d.isState && !rebound.has(d.name) && d.node.type === "VariableDeclaration" && d.node.kind === "var")) {
    const group = decls.filter((d) => d.isFn && d !== h && d.uses.includes(h.name));
    const names = new Set([h.name, ...group.map((g) => g.name)]);
    if (!group.length || group.some((g) => rebound.has(g.name) || !closedStep(g.node, names))) continue;
    const outside = [...decls.filter((d) => !names.has(d.name)).map((d) => d.node), ...roots];
    const inGroup = (n: AnyNode) => group.some((g) => n.start >= g.node.start && n.end <= g.node.end);
    const sites = bodies(ast).flat().filter((st) => {
      if (inGroup(st) || st.type !== "ExpressionStatement" || st.expression.type !== "CallExpression") return false;
      const { callee, arguments: args } = st.expression;
      return callee.type === "Identifier" && callee.name !== h.name && names.has(callee.name) && args.every((a) => a.type === "Literal" && typeof a.value === "number");
    });
    const used = outside.flatMap((o) => uses(o)).filter((u) => names.has(u)).length;
    if (!sites.length || used !== sites.length) continue;
    const init = (h.node as AnyNode & { type: "VariableDeclaration" }).declarations[0]!.init;
    const calls = sites.map(src).join("\n");
    const probe = `"use strict";
var ${h.name};
${group.map((g) => src(g.node)).join("\n")}
const antiBlaP = () => [Object, Array, Function].map((c) => Object.getOwnPropertyNames(c.prototype).join()).join() + Object.keys(globalThis).join();
const antiBlaS = () => JSON.stringify(${h.name}, (k, v) => (typeof v === "number" ? 0 : v));
const antiBlaP0 = antiBlaP();
${calls}
${h.name} = ${init ? src(init) : "undefined"};
const antiBlaS0 = antiBlaS();
for (let antiBlaI = 0; antiBlaI < ${CHURN_ROUNDS}; antiBlaI++) {
${calls}
if (antiBlaS() !== antiBlaS0) throw 0;
}
if (antiBlaP() !== antiBlaP0) throw 0;`;
    try {
      // shortcut: a bounded run, not a proof that call CHURN_ROUNDS + 1 cannot throw; upgrade to a shape/range analysis if BLA's stepper starts to vary by input.
      runInNewContext(probe, {}, { timeout: 2000 });
      out.push(...sites);
    } catch {
      // ran too long, threw, grew or touched builtins: keep the calls
    }
  }
  return out;
}

/** Declarations no root reaches, as source ranges. */
function unreachedCuts(code: string, seedNames: string[]): [number, number][] {
  const { decls, roots } = classify(parseJs(code), seedNames);
  const live = new Set<string>();
  const queue = roots.map((r) => uses(r));
  const byName = new Map(decls.filter((d) => d.name).map((d) => [d.name, d]));
  for (let q = queue.pop(); q; q = queue.pop()) {
    for (const name of q) {
      if (live.has(name)) continue;
      live.add(name);
      const d = byName.get(name);
      if (d) queue.push(d.uses);
    }
  }
  return decls.filter((d) => !live.has(d.name)).map((d) => [d.node.start, d.node.end]);
}

/** ESM, or CommonJS (uses require/module/exports). Top-level declarations of a classic script are globals other code may reach. */
const isModule = (ast: Program): boolean =>
  ast.body.some((st) => st.type.startsWith("Import") || st.type.startsWith("Export")) || uses(ast).some((u) => u === "require" || u === "module" || u === "exports");

export function pruneJs(src: string, seeds: Seed[]): { code: string; stats: PruneStats } {
  if (!isModule(parseJs(src))) return { code: src, stats: { declarationsRemoved: 0, sinkCallsRemoved: 0, shadowRuntimeRemoved: 0 } };
  const seedNames = seeds.map((s) => s.name);
  let cuts = unreachedCuts(src, seedNames);
  let code = applyCuts(src, cuts);
  const stats: PruneStats = { declarationsRemoved: cuts.length, sinkCallsRemoved: 0, shadowRuntimeRemoved: 0 };
  cuts = shadowCuts(code, seedNames).map((st) => [st.start, st.end]);
  stats.shadowRuntimeRemoved = cuts.length;
  code = applyCuts(code, cuts);
  const ast = parseJs(code);
  const { decls, roots } = classify(ast, seedNames);
  const sinks = findSinks(decls, roots, reboundNames(ast));
  cuts = bodies(ast).flat().filter((st) => sinks.has(sinkCall(st) ?? "")).map((st) => [st.start, st.end]);
  stats.sinkCallsRemoved = cuts.length;
  code = applyCuts(code, cuts);
  cuts = unreachedCuts(code, seedNames);
  stats.declarationsRemoved += cuts.length;
  return { code: applyCuts(code, cuts), stats };
}

/** Remove ranges (and one trailing newline each) from the end so earlier offsets stay valid. */
function applyCuts(src: string, cuts: [number, number][]): string {
  let out = src;
  for (const [s, e] of [...cuts].sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + out.slice(src[e] === "\n" ? e + 1 : e);
  return out;
}
