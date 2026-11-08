// Apps that carry BLA's runtime guard. BLA 3.1.0 emits the guard as a decorative flag; its own contract says it
// does not change behavior. Real BLA output (main.bla.js, and `bla protect --self-seal` output) proves only the
// decorative case. To prove the tool catches a guard that DOES change output, these apps use BLA's real guard
// code (src/shields/runtime/runtime-shield.ts, self-seal.ts) and add a consumer BLA does not emit.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAsar } from "../../scripts/lib/asar.ts";

/** Inspector detection exactly as runtime-shield.ts emits it, exposed on a global the way BLA does. */
const SHIELD = `(function () {
  const _g = typeof globalThis !== "undefined" ? globalThis : {};
  const _execArgv = typeof process !== "undefined" && Array.isArray(process.execArgv) ? process.execArgv.join(" ") : "";
  const _isInspectorObserved = _execArgv.includes("--inspect") || _execArgv.includes("--remote-debugging") || Boolean(_g && (_g.__playwright || _g.__puppeteer_evaluation_script__ || _g.frida || _g._frida_ || _g.navigator && _g.navigator.webdriver));
  const _shadowVault = Object.freeze({ classification: "decorative-deception-signal", inspectorObserved: _isInspectorObserved });
  Object.defineProperty(_g, "_enclaveRuntimeLedger_t1", { configurable: true, enumerable: false, get: function () { return _shadowVault; } });
})();`;
/** NODE_OPTIONS and execArgv folded into a digest, as self-seal.ts does; the digest is printed so any change shows. */
const SEAL = `const _c = require("node:crypto");
let envNote = "";
envNote += String(process.env.NODE_OPTIONS || "");
envNote += (process.execArgv || []).join(",");
const sealed = _c.createHash("sha256").update(envNote).digest("hex").slice(0, 8);`;

const MAIN = `${SHIELD}
${SEAL}
const fs = require("node:fs");
const cp = require("node:child_process");
const net = require("node:net");
const { ipcMain } = require("electron");
const watched = globalThis._enclaveRuntimeLedger_t1.inspectorObserved;
ipcMain.handle("notes:save", async () => (watched ? { ok: false, why: "decoy" } : { ok: true }));
ipcMain.on("notes:count", () => 3);
console.log(watched ? "decoy-path" : "real-path");
console.log("seal", sealed);
if (!watched) {
  fs.writeFileSync("/tmp/real.txt", "real");
  cp.execSync("echo spawned");
  net.connect(9, "127.0.0.1").on("error", () => {});
}
`;

/** A guarded Electron-style main process with real content: license check, one file write, one child, one connect, two IPC channels. */
export function writeGuardedApp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.js"), MAIN);
  writeFileSync(join(dir, "package.json"), '{"name":"guarded","main":"main.js"}');
  return dir;
}

/** The same app packed as ASAR with a flood entry that cannot be extracted. */
export function guardedAsar(): Buffer {
  const long = "a".repeat(300);
  return buildAsar([
    { path: "main.js", node: {}, data: Buffer.from(MAIN) },
    { path: "package.json", node: {}, data: Buffer.from('{"name":"guarded","main":"main.js"}') },
    { path: `enclave/shards/${long}.json`, node: {}, data: Buffer.from("{}") },
  ]);
}
