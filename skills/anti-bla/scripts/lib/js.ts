// Shared JS helpers: parse, walk, seed discovery and a tiny pure evaluator.
// BLA (3.1.0 to 3.2.2) hides its traps behind "seed" constants. A predicate that gives the
// same answer for every value the seed can hold is opaque and safe to fold.
import { parse, type AnyNode, type Expression, type Node, type Program } from "acorn";

export type { AnyNode, Expression, Program };

export function parseJs(src: string): Program {
  const o = { ecmaVersion: "latest", allowHashBang: true, allowReturnOutsideFunction: true } as const;
  try {
    return parse(src, { ...o, sourceType: "script" });
  } catch {
    return parse(src, { ...o, sourceType: "module" });
  }
}

const isNode = (v: unknown): v is AnyNode => typeof v === "object" && v !== null && "type" in v && "start" in v;

export function kids(n: Node): AnyNode[] {
  const out: AnyNode[] = [];
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) for (const x of v) isNode(x) && out.push(x);
    else if (isNode(v)) out.push(v);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Pre-order walk; return false from `f` to skip the subtree. */
export function walk(n: AnyNode, f: (n: AnyNode) => void | false): void {
  if (f(n) === false) return;
  for (const k of kids(n)) walk(k, f);
}

export interface Seed {
  name: string;
  samples: number[];
}

/** Which value the integrity bit of `NUM | (check ? 1 : 0)` seeds holds. */
export type SeedFlag = 0 | 1 | "either";

function lcgOdds(count: number): number[] {
  const out: number[] = [];
  let x = 12345;
  for (let i = 0; i < count; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    out.push(x | 1);
  }
  return out;
}
// odd values: every small one plus pseudo-random 32-bit ones
const ODD_SAMPLES = [...Array.from({ length: 128 }, (_, i) => 2 * i + 1), ...lcgOdds(64)];

const isNum = (x: Node, v?: number): boolean => {
  const n = x as AnyNode;
  return n.type === "Literal" && typeof n.value === "number" && (v === undefined || n.value === v);
};

const isByte = (x: AnyNode): boolean => x.type === "Literal" && typeof x.value === "number" && Number.isInteger(x.value) && x.value >= 0 && x.value <= 255;

/** An expression that reads a program value and is masked to 0..255, so `| 1` holds only odd values the samples cover. */
function byteMasked(x: AnyNode): boolean {
  if (x.type === "BinaryExpression" && x.operator === "&") return (isByte(x.right) && x.left.type !== "Literal") || (isByte(x.left) && x.right.type !== "Literal");
  if (x.type === "ConditionalExpression") return [x.consequent, x.alternate].every((b) => byteMasked(b) || isByte(b)) && [x.consequent, x.alternate].some(byteMasked);
  return false;
}

/** Low bit provably 0: an even literal, `x & EVEN`, or `^`/`|` of two such values. */
function lowBitZero(x: AnyNode): boolean {
  if (x.type === "Literal") return typeof x.value === "number" && Number.isInteger(x.value) && x.value % 2 === 0;
  if (x.type !== "BinaryExpression" || x.left.type === "PrivateIdentifier") return false;
  if (x.operator === "&") return lowBitZero(x.left) || lowBitZero(x.right);
  return (x.operator === "^" || x.operator === "|") && lowBitZero(x.left) && lowBitZero(x.right);
}

export function patternNames(p: AnyNode | null | undefined, out: string[]): void {
  if (!p) return;
  if (p.type === "Identifier") out.push(p.name);
  else if (p.type === "ObjectPattern") for (const q of p.properties) patternNames(q.type === "RestElement" ? q.argument : q.value, out);
  else if (p.type === "ArrayPattern") for (const e of p.elements) patternNames(e, out);
  else if (p.type === "AssignmentPattern") patternNames(p.left, out);
  else if (p.type === "RestElement") patternNames(p.argument, out);
}

/** Names bound more than once anywhere in the file (shadowing, redeclaration). Name-only analysis must not trust them. */
export function reboundNames(program: Program): Set<string> {
  const names: string[] = [];
  walk(program, (n) => {
    if (n.type === "VariableDeclarator") patternNames(n.id, names);
    else if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
      for (const p of n.params) patternNames(p, names);
      if (n.type !== "ArrowFunctionExpression") patternNames(n.id, names);
    } else if (n.type === "ClassDeclaration" || n.type === "ClassExpression") patternNames(n.id, names);
    else if (n.type === "CatchClause") patternNames(n.param, names);
    else if (n.type === "ImportSpecifier" || n.type === "ImportDefaultSpecifier" || n.type === "ImportNamespaceSpecifier") names.push(n.local.name);
  });
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const x of names) (seen.has(x) ? twice : seen).add(x);
  return twice;
}

/**
 * Top-level `const` seed constants whose name is bound once in the file. Shapes seen in BLA 3.1.0 and 3.2.2:
 *   const S = 4098631152 | (digest(0) === K ? 1 : 0)                          integrity-entangled
 *   const S = 305027790 ^ seal >>> 0 & 0xfffffffe | (digest(0) === K ? 1 : 0)   same, with --self-seal: any value of that parity
 *   const S = (cond ? process.pid & 0xff : 42) | 1                            any odd value in 1..255
 * Unknown shapes, `let`/`var`, and names bound more than once return no seed, so nothing is folded for them.
 */
export function findSeeds(program: Program, flag: SeedFlag = 1): Seed[] {
  const seeds: Seed[] = [];
  const rebound = reboundNames(program);
  const digest = digestSeedValues(program, rebound, flag);
  for (const st of program.body) {
    if (st.type !== "VariableDeclaration" || st.kind !== "const") continue;
    for (const d of st.declarations) {
      const init = d.init;
      if (d.id.type !== "Identifier" || rebound.has(d.id.name) || !init || init.type !== "BinaryExpression" || init.operator !== "|") continue;
      const { left, right } = init;
      if (digest.has(d)) seeds.push({ name: d.id.name, samples: [digest.get(d)!] });
      else if (left.type === "Literal" && typeof left.value === "number" && right.type === "ConditionalExpression" && isNum(right.consequent, 1) && isNum(right.alternate, 0)) {
        const lo = left.value | 0;
        const hi = lo | 1;
        seeds.push({ name: d.id.name, samples: flag === "either" ? [lo, hi] : [flag === 1 ? hi : lo] });
      } else if (right.type === "ConditionalExpression" && isNum(right.consequent, 1) && isNum(right.alternate, 0) && lowBitZero(left)) {
        const evens = ODD_SAMPLES.map((v) => v ^ 1);
        seeds.push({ name: d.id.name, samples: flag === "either" ? [...ODD_SAMPLES, ...evens] : flag === 1 ? ODD_SAMPLES : evens });
      } else if (isNum(right, 1) && byteMasked(left)) {
        seeds.push({ name: d.id.name, samples: ODD_SAMPLES });
      }
    }
  }
  return withAliases(program, seeds, rebound);
}

/** `var X = SEED;` where X is bound once and never assigned: X holds the seed value, so its reads fold too. */
function withAliases(program: Program, seeds: Seed[], rebound: Set<string>): Seed[] {
  if (!seeds.length) return seeds;
  const assigned = new Set<string>();
  walk(program, (n) => {
    if (n.type === "AssignmentExpression" && n.left.type === "Identifier") assigned.add(n.left.name);
    else if (n.type === "UpdateExpression" && n.argument.type === "Identifier") assigned.add(n.argument.name);
  });
  const out = [...seeds];
  for (const st of program.body) {
    if (st.type !== "VariableDeclaration") continue;
    for (const d of st.declarations) {
      const src = d.init?.type === "Identifier" ? seeds.find((s) => s.name === (d.init as AnyNode & { name: string }).name) : undefined;
      if (src && d.id.type === "Identifier" && !rebound.has(d.id.name) && !assigned.has(d.id.name)) out.push({ name: d.id.name, samples: src.samples });
    }
  }
  return out;
}


/**
 * BLA 3.5.x seed: `const S = L | (F1.length >= 0 && ... && D === K ? 1 : 0)` where `D = digest(0)` is a top-level
 * constant and `K` the digest the intact file gives. With the integrity bit set (flag 1) D is K, every `Fn.length >= 0`
 * term is true, and L reads only literals and `Obj.prop[i]` cells of a top-level `new Uint32Array([...])`. Then S is one
 * fixed number, so predicates on its higher bits fold too. Nothing runs: L is evaluated by the pure evaluator below.
 * The cells must not be written between their declaration and S (only declarations sit there).
 */
function digestSeedValues(program: Program, rebound: Set<string>, flag: SeedFlag): Map<AnyNode, number> {
  const out = new Map<AnyNode, number>();
  if (flag !== 1) return out;
  const cells = new Map<string, number[]>();
  const fnNames = new Set<string>();
  for (const [at, st] of program.body.entries()) {
    if (st.type === "FunctionDeclaration" && st.id) fnNames.add(st.id.name);
    if (st.type === "VariableDeclaration") {
      for (const d of st.declarations) {
        if (d.id.type !== "Identifier" || rebound.has(d.id.name) || d.init?.type !== "ObjectExpression") continue;
        for (const p of d.init.properties) {
          const v = p.type === "Property" && !p.computed && p.key.type === "Identifier" ? p.value : undefined;
          const nums = v?.type === "NewExpression" && v.callee.type === "Identifier" && v.callee.name === "Uint32Array" && v.arguments.length === 1 && v.arguments[0]!.type === "ArrayExpression" ? v.arguments[0]!.elements : undefined;
          if (nums?.every((e) => e?.type === "Literal" && typeof e.value === "number" && e.value >= 0 && e.value < 2 ** 32)) cells.set(`${d.id.name}.${((p as AnyNode & { key: { name: string } }).key).name}@${at}`, nums.map((e) => (e as AnyNode & { value: number }).value));
        }
      }
    }
  }
  for (const [at, st] of program.body.entries()) {
    if (st.type !== "VariableDeclaration" || st.kind !== "const") continue;
    for (const d of st.declarations) {
      const init = d.init;
      if (d.id.type !== "Identifier" || rebound.has(d.id.name) || !init || init.type !== "BinaryExpression" || init.operator !== "|" || init.left.type === "PrivateIdentifier") continue;
      const { left, right } = init;
      if (right.type !== "ConditionalExpression" || !isNum(right.consequent, 1) || !isNum(right.alternate, 0) || left.type === "Literal") continue;
      const env = new Map<string, number>();
      const terms: AnyNode[] = [];
      const split = (t: AnyNode): void => (t.type === "LogicalExpression" && t.operator === "&&" ? (split(t.left), split(t.right)) : void terms.push(t));
      split(right.test);
      const sound = terms.every((t) => {
        if (t.type !== "BinaryExpression" || t.left.type !== "Identifier" || t.right.type !== "Literal" || typeof t.right.value !== "number") return false;
        if (t.operator === ">=" && t.right.value === 0) return false; // `.length` terms are members, handled below
        if (t.operator === "===") return !env.has(t.left.name) && !!env.set(t.left.name, t.right.value);
        return false;
      }) || terms.every((t) => {
        if (t.type === "BinaryExpression" && t.operator === ">=" && isNum(t.right, 0) && t.left.type === "MemberExpression" && !t.left.computed && t.left.object.type === "Identifier" && t.left.property.type === "Identifier" && t.left.property.name === "length") return fnNames.has(t.left.object.name) && !rebound.has(t.left.object.name);
        if (t.type === "BinaryExpression" && t.operator === "===" && t.left.type === "Identifier" && isNum(t.right)) return !env.has(t.left.name) && !!env.set(t.left.name, (t.right as AnyNode & { value: number }).value);
        return false;
      });
      if (!sound || !env.size) continue;
      const table = new Map<string, number[]>();
      for (const [k, v] of cells) if (Number(k.split("@")[1]) < at) table.set(k.split("@")[0]!, v);
      const between = program.body.slice(0, at).some((x, i) => i > [...cells.keys()].reduce((m, k) => Math.min(m, Number(k.split("@")[1])), at) && !["FunctionDeclaration", "VariableDeclaration", "ClassDeclaration"].includes(x.type));
      if (between) continue;
      tables = table;
      read = new Set();
      const v = ev(left as Expression, env);
      tables = new Map();
      if (typeof v === "number") out.set(d, v | 1);
    }
  }
  return out;
}

type Val = string | number | boolean;
const NO = Symbol("no");
let read = new Set<string>();
/** `Obj.prop` -> values of a `new Uint32Array([...])` cell; set only while a 3.5.x seed is evaluated. */
let tables = new Map<string, number[]>();

function ev(n: Expression, env: Map<string, number>): Val | typeof NO {
  switch (n.type) {
    case "Literal":
      return typeof n.value === "string" || typeof n.value === "number" || typeof n.value === "boolean" ? n.value : NO;
    case "Identifier":
      if (!env.has(n.name)) return NO;
      read.add(n.name);
      return env.get(n.name)!;
    case "MemberExpression": {
      const o = n.object;
      if (!n.computed || n.property.type !== "Literal" || typeof n.property.value !== "number" || o.type !== "MemberExpression" || o.computed || o.object.type !== "Identifier" || o.property.type !== "Identifier") return NO;
      return tables.get(`${o.object.name}.${o.property.name}`)?.[n.property.value] ?? NO;
    }
    case "UnaryExpression": {
      if (n.operator === "typeof") return n.argument.type === "Identifier" && env.has(n.argument.name) ? (read.add(n.argument.name), "number") : NO;
      const v = ev(n.argument, env);
      if (v === NO) return NO;
      switch (n.operator) {
        case "~": return ~(v as number);
        case "-": return -(v as number);
        case "+": return +v;
        case "!": return !v;
        default: return NO;
      }
    }
    case "BinaryExpression": {
      if (n.left.type === "PrivateIdentifier") return NO;
      const a = ev(n.left, env);
      if (a === NO) return NO;
      const b = ev(n.right, env);
      if (b === NO) return NO;
      const x = a as number;
      const y = b as number;
      switch (n.operator) {
        case "+": return x + y;
        case "-": return x - y;
        case "*": return x * y;
        case "%": return x % y;
        case "<<": return x << y;
        case ">>": return x >> y;
        case ">>>": return x >>> y;
        case "&": return x & y;
        case "|": return x | y;
        case "^": return x ^ y;
        case "===": return a === b;
        case "!==": return a !== b;
        case "==": return a == b;
        case "!=": return a != b;
        case "<": return x < y;
        case ">": return x > y;
        case "<=": return x <= y;
        case ">=": return x >= y;
        default: return NO;
      }
    }
    case "LogicalExpression": {
      const a = ev(n.left, env);
      if (a === NO) return NO;
      if (n.operator === "&&") return a ? ev(n.right, env) : a;
      if (n.operator === "||") return a ? a : ev(n.right, env);
      return NO;
    }
    case "ConditionalExpression": {
      const t = ev(n.test, env);
      return t === NO ? NO : ev(t ? n.consequent : n.alternate, env);
    }
    case "CallExpression": {
      const c = n.callee;
      const isImul = c.type === "MemberExpression" && !c.computed && c.object.type === "Identifier" && c.object.name === "Math" && c.property.type === "Identifier" && c.property.name === "imul";
      const [p, q] = n.arguments;
      if (!isImul || n.arguments.length !== 2 || p!.type === "SpreadElement" || q!.type === "SpreadElement") return NO;
      const a = ev(p!, env);
      const b = a === NO ? NO : ev(q!, env);
      return b === NO ? NO : Math.imul(a as number, b as number);
    }
    default:
      return NO;
  }
}

/**
 * Value of `n` when it reads a seed and gives one answer for every sample.
 * `undefined` means "not an opaque constant": leave the node alone.
 */
export function opaqueValue(n: Expression, seeds: Seed[]): { value: Val } | undefined {
  if (!seeds.length || n.type === "Literal") return undefined;
  const rounds = Math.max(...seeds.map((s) => s.samples.length));
  let first: Val | typeof NO = NO;
  read = new Set();
  for (let i = 0; i < rounds; i++) {
    const env = new Map(seeds.map((s) => [s.name, s.samples[i % s.samples.length]!] as const));
    const v = ev(n, env);
    if (v === NO) return undefined;
    if (i === 0) first = v;
    else if (!Object.is(v, first)) return undefined;
  }
  const varying = seeds.filter((s) => s.samples.length > 1 && read.has(s.name));
  return read.size && varying.length < 2 && first !== NO ? { value: first } : undefined;
}
