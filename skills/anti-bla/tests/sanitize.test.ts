import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAsar } from "../scripts/lib/asar.ts";
import { findSentinels } from "../scripts/lib/fuses.ts";
import { sanitize } from "../scripts/sanitize.ts";
import { scan } from "../scripts/scan.ts";
import { floodAsar, fuseBinary, readFixture } from "./fixtures/make.ts";

const tmp = mkdtempSync(join(tmpdir(), "antibla-san-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("sanitize", () => {
  test("ASAR: drops flood entries, keeps real files byte for byte, leaves the original alone", () => {
    const src = join(tmp, "app.asar");
    writeFileSync(src, floodAsar(150));
    const before = sha(src);
    const r = sanitize(src, join(tmp, "out1"));
    expect(sha(src)).toBe(before);
    const out = openAsar(join(tmp, "out1", "app.asar"));
    expect(out.files.map((f) => f.path).sort()).toEqual(["dist/main.js", "package.json"]);
    expect(out.read(out.files.find((f) => f.path === "dist/main.js")!).equals(readFixture("main.js"))).toBe(true);
    out.close();
    expect(r.actions[0]!.kind).toBe("asar-flood-dropped");
    expect(scan(join(tmp, "out1", "app.asar")).score).toBe(0);
  });

  test("ASAR: names that only look like decoys are kept and reported as suspects", () => {
    const src = join(tmp, "legit.asar");
    writeFileSync(src, floodAsar(150));
    const r = sanitize(src, join(tmp, "out2"));
    expect(r.suspects).toEqual([]); // the flood entries are gone
    const only = floodAsar(0);
    writeFileSync(join(tmp, "plain.asar"), only);
    expect(sanitize(join(tmp, "plain.asar"), join(tmp, "out3")).actions[0]!.kind).toBe("copied-asar-unchanged");
  });

  test("fuses: decoy sentinels zeroed, real block and file size untouched", () => {
    const src = join(tmp, "electron");
    writeFileSync(src, fuseBinary(34));
    sanitize(src, join(tmp, "out4"));
    const out = readFileSync(join(tmp, "out4", "electron"));
    const s = findSentinels(out);
    expect(s).toHaveLength(1);
    expect(s[0]!.wire).toBe("10110001");
    expect(out.length).toBe(statSync(src).size);
  });

  test("directory: configs dropped, other files copied", () => {
    const d = join(tmp, "proj");
    mkdirSync(d);
    writeFileSync(join(d, ".blarc"), "{}");
    writeFileSync(join(d, "main.js"), "1");
    const r = sanitize(d, join(tmp, "out5"));
    expect(existsSync(join(tmp, "out5", ".blarc"))).toBe(false);
    expect(readFileSync(join(tmp, "out5", "main.js"), "utf8")).toBe("1");
    expect(r.actions.map((a) => a.kind)).toContain("dropped-config");
  });

  test("refuses an output inside the target or on top of it", () => {
    const d = join(tmp, "proj");
    expect(() => sanitize(d, join(d, "inner"))).toThrow(/refusing/);
    expect(() => sanitize(d, d)).toThrow(/refusing/);
  });
});
