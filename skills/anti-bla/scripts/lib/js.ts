// Shared JS helpers: parse, walk, seed discovery and a tiny pure evaluator.
// BLA 3.1.0 hides its traps behind "seed" constants. A predicate that gives the
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

/**
 * Top-level seed constants. Shapes seen in BLA 3.1.0:
 *   const S = 4098631152 | (digest(0) === K ? 1 : 0)    integrity-entangled
 *   const S = (process.pid & 0xff : 42) | 1             any odd value
 * Unknown shapes return no seed, so nothing is folded for them.
 */
export function findSeeds(program: Program, flag: SeedFlag = 1): Seed[] {
  const seeds: Seed[] = [];
  for (const st of program.body) {
    if (st.type !== "VariableDeclaration") continue;
    for (const d of st.declarations) {
      const init = d.init;
      if (d.id.type !== "Identifier" || !init || init.type !== "BinaryExpression" || init.operator !== "|") continue;
      const { left, right } = init;
      if (left.type === "Literal" && typeof left.value === "number" && right.type === "ConditionalExpression" && isNum(right.consequent, 1) && isNum(right.alternate, 0)) {
        const lo = left.value | 0;
        const hi = lo | 1;
        seeds.push({ name: d.id.name, samples: flag === "either" ? [lo, hi] : [flag === 1 ? hi : lo] });
      } else if (isNum(right, 1)) {
        seeds.push({ name: d.id.name, samples: ODD_SAMPLES });
      }
    }
  }
  return seeds;
}

type Val = string | number | boolean;
const NO = Symbol("no");
let touched = false;

function ev(n: Expression, env: Map<string, number>): Val | typeof NO {
  switch (n.type) {
    case "Literal":
      return typeof n.value === "string" || typeof n.value === "number" || typeof n.value === "boolean" ? n.value : NO;
    case "Identifier":
      if (!env.has(n.name)) return NO;
      touched = true;
      return env.get(n.name)!;
    case "UnaryExpression": {
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
  touched = false;
  for (let i = 0; i < rounds; i++) {
    const env = new Map(seeds.map((s) => [s.name, s.samples[i % s.samples.length]!] as const));
    const v = ev(n, env);
    if (v === NO) return undefined;
    if (i === 0) first = v;
    else if (!Object.is(v, first)) return undefined;
  }
  return touched && first !== NO ? { value: first } : undefined;
}
