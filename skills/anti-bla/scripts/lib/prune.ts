// Reachability pruning for top-level declarations of one JS file.
// Roots are every statement that is not a plain declaration. A declaration is removed only when no
// root reaches it. Sink calls (a call whose only effect is mutating private state nobody else reads)
// are removed first, so the state and the function become unreachable too.
import { kids, parseJs, reboundNames, walk, type AnyNode, type Program, type Seed } from "./js.ts";

export interface PruneStats {
  declarationsRemoved: number;
  sinkCallsRemoved: number;
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
  const bind = (p: AnyNode) =>
    walk(p, (x) => {
      if (x.type === "Identifier") names.add(x.name);
    });
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
 * state; that state is used by sinks only; and every use of F outside the set is a droppable
 * call statement (so dropping all of them leaves F unreachable).
 */
function findSinks(decls: Decl[], roots: AnyNode[], rebound: Set<string>): Set<string> {
  const fns = new Set(decls.filter((d) => d.isFn && !rebound.has(d.name)).map((d) => d.name));
  const states = new Set(decls.filter((d) => d.isState && !rebound.has(d.name)).map((d) => d.name));
  const callsTo = (node: AnyNode, name: string) => (sinkCall(node) === name ? 1 : 0) + bodies(node).flat().filter((st) => sinkCall(st) === name).length;
  for (let changed = true; changed; ) {
    changed = false;
    const outside = [...decls.filter((d) => !fns.has(d.name)).map((d) => ({ name: d.name, node: d.node, u: d.uses })), ...roots.map((r) => ({ name: "", node: r, u: uses(r) }))];
    for (const d of decls.filter((x) => fns.has(x.name))) {
      const local = declaredIn(d.node);
      const escapes = d.uses.some((u) => !local.has(u) && !fns.has(u) && !states.has(u) && u !== "Math" && u !== "undefined");
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
  if (!isModule(parseJs(src))) return { code: src, stats: { declarationsRemoved: 0, sinkCallsRemoved: 0 } };
  const seedNames = seeds.map((s) => s.name);
  let cuts = unreachedCuts(src, seedNames);
  let code = applyCuts(src, cuts);
  const stats: PruneStats = { declarationsRemoved: cuts.length, sinkCallsRemoved: 0 };
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
