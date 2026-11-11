import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldJs, foldPath } from "../scripts/fold-js.ts";
import { buildAsar, openAsar } from "../scripts/lib/asar.ts";
import { scan } from "../scripts/scan.ts";
import { readFixture } from "./fixtures/make.ts";

const tmp = mkdtempSync(join(tmpdir(), "antibla-fold-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const load = (code: string): Record<string, (...a: unknown[]) => unknown> => {
  const m = { exports: {} as Record<string, (...a: unknown[]) => unknown> };
  new Function("module", "require", code)(m, require);
  return m.exports;
};

describe("fold-js on real BLA 3.1.0 output", () => {
  const src = readFixture("main.bla.js").toString("utf8");
  const r = foldJs(src);
  const before = load(src);
  const after = load(r.code);

  test("folds seed predicates and cuts the decoy mass", () => {
    expect(r.stats.predicatesFolded).toBeGreaterThan(0);
    expect(r.stats.declarationsRemoved).toBeGreaterThan(0);
    expect(r.code.length).toBeLessThan(src.length / 5);
    expect(r.code).not.toContain("sourceMappingURL");
  });

  test("exports behave the same on common and rare input", () => {
    const inputs = ["Hello, World!", "a b  c", "", "AAAAAAA-PRO-1234", "AB-PRO-1234", "x-y"];
    for (const f of ["slugify", "wordCount", "checkLicense"]) for (const i of inputs) expect(after[f]!(i)).toEqual(before[f]!(i));
    for (const i of [[[1, 2], [3]], [], [[1]]]) expect(after.rareExport!(i)).toEqual(before.rareExport!(i));
  });

  test("the folded copy scores lower than the original", () => {
    const out = join(tmp, "main.js");
    writeFileSync(out, r.code);
    expect(scan(out).score).toBeLessThan(scan(join(import.meta.dir, "fixtures/main.bla.js")).score);
  });
});

describe("fold-js keeps what it cannot prove dead", () => {
  const seed = "const _s = 4098631152 | (typeof _d === \"function\" && _d(0) === 1282826635 ? 1 : 0);\n";

  test("rare-input logic survives: only seed predicates are folded", () => {
    const code = `${seed}function _d() { return 0; }\nfunction f(x) { if (x === 424242) { return "rare"; } if ((Math.imul(_s ^ 60, 1) & 7) === 0) { return "opaque"; } return "common"; }\nmodule.exports = { f };\n`;
    const out = foldJs(code).code;
    expect(out).toContain("424242");
    expect(load(out).f!(424242)).toBe("rare");
  });

  test("state read by live code is not treated as a sink", () => {
    const code = `${seed}let n = 0;\nfunction tick() { n = n + 1; return n; }\nfunction f() { tick(); return n; }\nmodule.exports = { f };\n`;
    const out = foldJs(code).code;
    expect(load(out).f!()).toBe(1);
  });

  test("a build without seeds is returned unchanged", () => {
    const code = "module.exports = { f: () => 1 };\n";
    expect(foldJs(code).code).toBe(code);
  });
});

describe("fold-js keeps behavior it cannot prove unchanged", () => {
  const seed = "const _s = 4098631152 | (typeof _d === \"function\" && _d(0) === 1282826635 ? 1 : 0);\nfunction _d() { return 0; }\n";

  test("a call that mutates its argument is kept", () => {
    const code = `${seed}const registry = new Map();\nfunction register(m) { m.set("a", 1); }\nregister(registry);\nmodule.exports = { has: (k) => registry.has(k) };\n`;
    expect(load(foldJs(code).code).has!("a")).toBe(true);
    const code2 = `${seed}const cfg = {};\nfunction init(c) { c.ready = true; }\ninit(cfg);\nmodule.exports = { ready: () => cfg.ready };\n`;
    expect(load(foldJs(code2).code).ready!()).toBe(true);
  });

  test("a call to a function that writes through `this` is kept", () => {
    const code = `${seed}function setup() { this.antiBlaThisProbe = true; }\nsetup();\nmodule.exports = { f: () => 1 };\n`;
    load(foldJs(code).code);
    expect((globalThis as Record<string, unknown>).antiBlaThisProbe).toBe(true);
    delete (globalThis as Record<string, unknown>).antiBlaThisProbe;
  });

  test("a call whose default parameter value has an outside effect is kept", () => {
    const code = `${seed}let c = 0;\nfunction bump(a = c++) {}\nbump();\nmodule.exports = { get: () => c };\n`;
    expect(load(foldJs(code).code).get!()).toBe(1);
  });

  test("a call to a function that throws is kept", () => {
    const code = `${seed}function fail(m) { throw m; }\nfunction f(x) { if (typeof x !== "number") { fail("bad input"); } return x; }\nmodule.exports = { f };\n`;
    const out = load(foldJs(code).code);
    expect(() => out.f!("a")).toThrow();
    expect(out.f!(1)).toBe(1);
  });

  test("a call to a function that reaches a throw through a helper is kept", () => {
    const code = `${seed}function inner(m) { throw m; }\nfunction outer(m) { inner(m); }\nfunction f(x) { if (typeof x !== "number") { outer("bad input"); } return x; }\nmodule.exports = { f };\n`;
    expect(() => load(foldJs(code).code).f!("a")).toThrow();
  });

  test("a call to a function with any loop is kept", () => {
    const body = (inner: string) => `${seed}function work() { ${inner} }\nwork();\nmodule.exports = { f: () => 1 };\n`;
    expect(foldJs(body("for (;;) {}")).stats.sinkCallsRemoved).toBe(0);
    expect(foldJs(body("while (true) {}")).stats.sinkCallsRemoved).toBe(0);
    expect(foldJs(body("for (let i = 0; i < 3; i++) { [i] = [0]; }")).stats.sinkCallsRemoved).toBe(0);
    expect(foldJs(body("let k = 1; for (let i = 0; i < 8; i++) { k = k + i; }")).stats.sinkCallsRemoved).toBe(0);
  });

  test("a loop whose bound a callee sink can grow is kept", () => {
    const code = `${seed}const a = [1];\nfunction grow() { a.push(1); }\nfunction work() { for (let i = 0; i < a.length; i++) { grow(); } }\nwork();\nmodule.exports = { f: () => 1 };\n`;
    expect(foldJs(code).stats.sinkCallsRemoved).toBe(0);
  });

  test("a call to a function that touches a member of private state or of a parameter is kept", () => {
    const nested = `${seed}const cache = {};\nfunction touch() { cache.x.y = 1; }\nfunction f(x) { if (typeof x !== "number") { touch(); } return x; }\nmodule.exports = { f };\n`;
    expect(() => load(foldJs(nested).code).f!("a")).toThrow(TypeError);
    const param = `${seed}function w(o) { o.x = 1; }\nfunction f(x) { if (typeof x !== "number") { w(null); } return x; }\nmodule.exports = { f };\n`;
    expect(() => load(foldJs(param).code).f!("a")).toThrow(TypeError);
    const undef = `${seed}let cache;\nfunction touch(k) { cache[k] = 1; }\nfunction f(x) { if (typeof x !== "number") { touch("a"); } return x; }\nmodule.exports = { f };\n`;
    expect(() => load(foldJs(undef).code).f!("a")).toThrow(TypeError);
  });

  test("a call to a recursive function is kept, by call or by new", () => {
    for (const inner of ["spin();", "new spin();"]) {
      const code = `${seed}function spin() { ${inner} }\nfunction f(x) { if (typeof x !== "number") { spin(); } return x; }\nmodule.exports = { f };\n`;
      expect(() => load(foldJs(code).code).f!("a")).toThrow(RangeError);
    }
  });

  test("a sink that calls another sink is dropped, because a call chain is not a cycle", () => {
    const code = `${seed}function bump() { let k = 1; k = k + 1; }\nfunction run() { bump(); }\nrun();\nmodule.exports = { f: () => 1 };\n`;
    expect(foldJs(code).stats.sinkCallsRemoved).toBe(2);
  });

  test("a name that is rebound or not const is never treated as a seed", () => {
    const shadowed = "const flags = Number(process.argv[2]) | 1;\nfunction check(flags) { if ((flags & 1) === 1) return 'odd'; return 'even'; }\nmodule.exports = { check };\n";
    expect(load(foldJs(shadowed).code).check!(2)).toBe("even");
    const reassigned = "let h = 7 | 1;\nh = h + 1;\nfunction f() { if ((h & 1) === 0) return 'even'; return 'odd'; }\nmodule.exports = { f };\n";
    expect(load(foldJs(reassigned).code).f!()).toBe("even");
  });

  test("only a byte-masked `| 1` is a seed: a literal or unmasked left side keeps both arms", () => {
    const flags = "const FLAGS = 0x1000 | 1;\nfunction f() { if (FLAGS === 4097) return 'A'; return 'B'; }\nmodule.exports = { f };\n";
    expect(load(foldJs(flags).code).f!()).toBe("A");
    const mode = "const MODE = (process.env.MODE_NUM | 0) | 1;\nfunction g() { return MODE !== 4097 ? 'other' : 'special'; }\nmodule.exports = { g };\n";
    expect(foldJs(mode).code).toBe(mode);
    const masked = "const S = (process.pid & 0xff) | 1;\nfunction h() { if ((S & 1) === 1) return 'odd'; return 'even'; }\nmodule.exports = { h };\n";
    expect(load(foldJs(masked).code).h!()).toBe("odd");
    expect(foldJs(masked).stats.branchesDropped).toBeGreaterThan(0);
  });

  test("two different seeds are never assumed equal: a test that compares them is kept", () => {
    const code = "const A = (process.pid & 0xff) | 1;\nconst B = (process.ppid & 0xff) | 1;\nfunction f() { return A === B ? 'same' : 'diff'; }\nmodule.exports = { f };\n";
    expect(foldJs(code).code).toBe(code);
  });

  test("a classic script keeps its top-level declarations, which other scripts may call", () => {
    const code = `${seed}function onSave() { return 1; }\nfunction helper() { return 2; }\n`;
    const out = foldJs(code).code;
    expect(out).toContain("function onSave");
    expect(out).toContain("function helper");
  });
});

test("foldPath writes a copy and leaves the original", () => {
  const src = join(tmp, "in.js");
  const original = readFixture("main.bla.js");
  writeFileSync(src, original);
  const rep = foldPath(src, join(tmp, "out.js"));
  expect(readFileSync(src).equals(original)).toBe(true);
  expect(rep.files[0]!.stats.predicatesFolded).toBeGreaterThan(0);
});

test("foldPath copies node_modules unchanged", () => {
  const src = join(tmp, "app");
  mkdirSync(join(src, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(src, "main.js"), "module.exports = 1;\n");
  writeFileSync(join(src, "node_modules", "dep", "index.js"), readFixture("main.bla.js"));
  foldPath(src, join(tmp, "app-out"));
  expect(readFileSync(join(tmp, "app-out", "node_modules", "dep", "index.js")).equals(readFixture("main.bla.js"))).toBe(true);
});

test("foldPath copies an ASAR with a bad entry unchanged instead of aborting", () => {
  const src = join(tmp, "bad.asar");
  writeFileSync(src, buildAsar([{ path: "a.js", node: { size: 2 ** 40, offset: "0" } }]));
  foldPath(src, join(tmp, "bad-out.asar"));
  expect(readFileSync(join(tmp, "bad-out.asar")).equals(readFileSync(src))).toBe(true);
});

test("one unparseable entry does not stop the rest of the ASAR from folding", () => {
  const src = join(tmp, "mixed.asar");
  writeFileSync(src, buildAsar([
    { path: "main.js", node: {}, data: readFixture("main.bla.js") },
    { path: "bad.js", node: {}, data: Buffer.from("this is { not js") },
  ]));
  const rep = foldPath(src, join(tmp, "mixed-out.asar"));
  expect(rep.files.map((f) => f.path)).toEqual([`${src}!main.js`]);
  expect(rep.notes.join("\n")).toContain("bad.js");
  const out = openAsar(join(tmp, "mixed-out.asar"));
  expect(out.read(out.files.find((f) => f.path === "bad.js")!).toString()).toBe("this is { not js");
  expect(out.read(out.files.find((f) => f.path === "main.js")!).length).toBeLessThan(readFixture("main.bla.js").length / 5);
  out.close();
});

test("an unparseable .js in a directory is kept and noted, not fatal", () => {
  const d = join(tmp, "bad-dir");
  mkdirSync(d);
  writeFileSync(join(d, "bad.js"), "this is { not js");
  writeFileSync(join(d, "main.js"), readFixture("main.bla.js"));
  const rep = foldPath(d, join(tmp, "bad-dir-out"));
  expect(readFileSync(join(tmp, "bad-dir-out", "bad.js"), "utf8")).toBe("this is { not js");
  expect(rep.notes.join("\n")).toContain("bad.js");
  expect(rep.files.map((f) => f.path)).toEqual([join(d, "main.js")]);
});

describe("a file with only prunable code is cleaned the same in a directory and in an ASAR", () => {
  const seed = "const _s = 4098631152 | (typeof _d === \"function\" && _d(0) === 1282826635 ? 1 : 0);\n";
  const code = `${seed}function _d() { return 0; }\nfunction unused() { return 1; }\nconst arr = [unused];\nvoid [arr];\nmodule.exports = { f: () => 1 };\n`;

  test("directory", () => {
    const d = join(tmp, "prune-dir");
    mkdirSync(d);
    writeFileSync(join(d, "m.js"), code);
    const rep = foldPath(d, join(tmp, "prune-dir-out"));
    expect(readFileSync(join(tmp, "prune-dir-out", "m.js"), "utf8")).not.toContain("unused");
    expect(rep.files).toHaveLength(1);
  });

  test("ASAR", () => {
    const src = join(tmp, "prune.asar");
    writeFileSync(src, buildAsar([{ path: "m.js", node: {}, data: Buffer.from(code) }]));
    const rep = foldPath(src, join(tmp, "prune-out.asar"));
    const out = openAsar(join(tmp, "prune-out.asar"));
    expect(out.read(out.files[0]!).toString()).not.toContain("unused");
    out.close();
    expect(rep.files).toHaveLength(1);
  });
});

test("foldPath never follows or copies a symlink", () => {
  const outside = join(tmp, "outside-secret.js");
  writeFileSync(outside, "module.exports = 'secret';\n");
  const d = join(tmp, "link-dir");
  mkdirSync(d);
  writeFileSync(join(d, "main.js"), "module.exports = 1;\n");
  symlinkSync(outside, join(d, "leak.js"));
  symlinkSync(d, join(d, "loop"));
  const rep = foldPath(d, join(tmp, "link-dir-out"));
  expect(existsSync(join(tmp, "link-dir-out", "leak.js"))).toBe(false);
  expect(existsSync(join(tmp, "link-dir-out", "loop"))).toBe(false);
  expect(readFileSync(join(tmp, "link-dir-out", "main.js"), "utf8")).toBe("module.exports = 1;\n");
  expect(rep.notes.filter((n) => n.includes("symlink skipped"))).toHaveLength(2);
});

describe("fold-js cuts BLA's shadow runtime and keeps the program's output", () => {
  // .cjs: the skill's package.json says "type": "module", and these builds are CommonJS
  const run = (name: string, code: string | Buffer) => {
    const file = join(tmp, `${name.replaceAll("/", "-")}.cjs`);
    writeFileSync(file, code);
    const r = Bun.spawnSync(["node", file], { stdout: "pipe", stderr: "pipe" });
    return [r.exitCode, r.stdout.toString(), r.stderr.toString()];
  };
  for (const [hard, plain] of [["main.bla.js", "main.js"], ["bla322/app.bla.js", "bla322/src/app.js"]] as const) {
    test(`${hard}: init block and heap churn are gone, output equals the plain ${plain}`, () => {
      const r = foldJs(readFixture(hard).toString("utf8"));
      expect(r.stats.shadowRuntimeRemoved).toBeGreaterThan(0);
      expect(r.code).not.toContain("addEventListener");
      expect(r.code).not.toMatch(/shadowHeap|stepShadowHeap|_enclaveRuntime/i);
      expect(run(`shadow-${hard}`, r.code)).toEqual(run(`plain-${plain}`, readFixture(plain)));
      expect(r.code.length).toBeLessThan(3 * readFixture(plain).length);
    });
  }
});

describe("fold-js keeps shadow-runtime look-alikes that the program can observe", () => {
  const seed = "const _s = 4098631152 | (typeof _d === \"function\" && _d(0) === 1282826635 ? 1 : 0);\nfunction _d() { return 0; }\n";
  const churn = (step: string, tail = "module.exports = { f };") =>
    `${seed}var H = { n: 0, w: [1, 2] };\nfunction step(d) { if (!H) return 0; ${step} }\nfunction f(x) { step(3); return x + 1; }\n${tail}\n`;

  test("a churn call on private state is cut and the state goes with it", () => {
    const r = foldJs(churn("H.n = (H.n + d) & 0x7fff; for (let i = 0; i < H.w.length; i++) { H.w[i] = H.w[i] ^ d; } return H.n;"));
    expect(r.stats.shadowRuntimeRemoved).toBe(1);
    expect(r.code).not.toContain("step");
    expect(r.code).not.toContain("var H");
    expect(load(r.code).f!(1)).toBe(2);
  });

  test("a churn call that throws late, hangs, grows the state or is read is kept", () => {
    const late = churn("H.n = H.n + 1; if (H.n > 50) { H.w[5].x = 1; }");
    expect(foldJs(late).stats.shadowRuntimeRemoved).toBe(0);
    const f = load(foldJs(late).code).f!;
    expect(() => { for (let i = 0; i < 60; i++) f(i); }).toThrow(TypeError);
    expect(foldJs(churn("while (H.n >= 0) { H.n = H.n & 1; }")).stats.shadowRuntimeRemoved).toBe(0);
    expect(foldJs(churn("H.w[H.w.length] = d;")).stats.shadowRuntimeRemoved).toBe(0);
    const read = churn("H.n = H.n + d;", "module.exports = { f, n: () => H.n };");
    expect(foldJs(read).stats.shadowRuntimeRemoved).toBe(0);
    expect(load(foldJs(read).code).n!()).toBe(0);
    expect(foldJs(churn("H.n = H.n + d;").replace("{ step(3);", "{ const v = step(3);")).stats.shadowRuntimeRemoved).toBe(0);
  });

  const init = (body: string, tail = "module.exports = { f: () => 1 };") => `${seed}(function () { ${body} })();\n${tail}\n`;
  const define = 'const g = globalThis; Object.defineProperty(g, "_antiBlaDecoy", { configurable: true, get: function () { return 7; } });';

  test("a decorative init block is cut", () => {
    const r = foldJs(init(`try { ${define} for (let i = 0; i < 4; i++) {} } catch (_) {}`));
    expect(r.stats.shadowRuntimeRemoved).toBe(1);
    expect(r.code).not.toContain("_antiBlaDecoy");
  });

  test("an init block the program reads, or with any effect besides a private global, is kept", () => {
    const read = init(`try { ${define} } catch (_) {}`, "module.exports = { f: () => globalThis._antiBlaDecoy };");
    expect(foldJs(read).stats.shadowRuntimeRemoved).toBe(0);
    expect(load(foldJs(read).code).f!()).toBe(7);
    delete (globalThis as Record<string, unknown>)._antiBlaDecoy;
    for (const body of [
      define, // no catch-all around it
      `try { ${define} process.stdout.write(""); } catch (_) {}`,
      "try { globalThis.antiBlaFlag = 1; } catch (_) {}",
      "try { for (let i = 0; i < 4; i += 0) {} } catch (_) {}",
      "try { while (true) {} } catch (_) {}",
      "try { window.app.update(); } catch (_) {}",
      "try { globalThis.x.join(); } catch (_) {}",
      "try { process.x.digest(); } catch (_) {}",
      'try { window.app.addEventListener("zz:uniq", 1); } catch (_) {}',
      'try { window.app.getBuiltinModule("crypto").createHash("sha256").digest(); } catch (_) {}',
      "try { var a = window.app; a.update(); } catch (_) {}",
      "try { const a = globalThis.store; a.join(); } catch (_) {}",
      "try { const a = typeof window !== 'undefined' ? window : {}; a.update(); } catch (_) {}",
      'try { var a = window.app; a.addEventListener("zz:uniq", 1); } catch (_) {}',
      "try { const { app: a } = window; a.update(); } catch (_) {}",
      "try { var a = window?.app; a.update(); } catch (_) {}",
      "try { var a = (0, window.app); a.update(); } catch (_) {}",
      "try { var b, a = b = window.app; a.update(); } catch (_) {}",
      "try { var a = 1; a = window.app; a.update(); } catch (_) {}",
      "try { var o = { x: window.app }; o.x.update(); } catch (_) {}",
      "try { var a = [window.app]; a[0].update(); } catch (_) {}",
      "try { var a = [window.app]; a.join(); } catch (_) {}",
      "try { var o = Object.freeze({ x: window.app }); o.x.update(); } catch (_) {}",
      "try { [window.app][0].update(); } catch (_) {}",
    ]) expect(foldJs(init(body)).stats.shadowRuntimeRemoved).toBe(0);
  });
});
