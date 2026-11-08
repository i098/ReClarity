// Loaded with `node --require` INSIDE the bwrap sandbox, before the target (runtime-guard.ts).
// It (1) sets the signals of the chosen probes, the way an attached tool leaves them, (2) records what the target
// does: calls into a stand-in `electron` module, child processes, network connects, the globals it adds,
// and (3) at idle, calls every IPC handler once. Events go to a file the host reads as data.
"use strict";
const fs = require("node:fs");
const Module = require("node:module");

const OBS = process.env.GUARD_OBS;
const PROBES = (process.env.GUARD_PROBES || "").split(",").filter(Boolean);
// Keep the config out of the target's view: both runs must differ only by the probe signal.
delete process.env.GUARD_OBS;
delete process.env.GUARD_PROBES;

const append = fs.appendFileSync.bind(fs);
const clip = (v, max = 300) => {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "function" ? "[fn]" : typeof x === "bigint" ? String(x) : x));
    return (s === undefined ? String(v) : s).slice(0, max);
  } catch {
    return "[unserializable]";
  }
};
const emit = (kind, name, args) => {
  try {
    append(OBS, JSON.stringify({ kind, name, args: args.map((a) => clip(a)) }) + "\n");
  } catch {}
};

// 1. probe signals
const g = globalThis;
if (PROBES.includes("cdp")) {
  g.__playwright = {};
  g.__puppeteer_evaluation_script__ = true;
  const nav = g.navigator ?? (g.navigator = {});
  Object.defineProperty(nav, "webdriver", { value: true, configurable: true });
}
if (PROBES.includes("frida")) {
  g.frida = {};
  g._frida_ = {};
  g.Frida = {};
  g.Interceptor = {};
}
if (PROBES.includes("remote-debugging")) process.execArgv.push("--remote-debugging-port=0");
const before = new Set(Object.getOwnPropertyNames(g));

// 2. recorders
const cp = require("node:child_process");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const real = cp[name];
  cp[name] = function (...args) {
    emit("spawn", name, args.slice(0, 2));
    return real.apply(this, args);
  };
}
const net = require("node:net");
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  emit("net", "connect", args.slice(0, 1));
  return realConnect.apply(this, args);
};

const handlers = [];
const IPC = /^(ipcMain|ipcRenderer)\.(handle|handleOnce|on|once)$/;
const stubs = new Map();
function stub(path) {
  const hit = stubs.get(path);
  if (hit) return hit;
  const p = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => path;
      if (typeof prop === "symbol" || prop === "then" || prop === "toJSON") return undefined;
      return stub(`${path}.${prop}`);
    },
    apply(_t, _this, args) {
      emit("electron", path, args);
      if (IPC.test(path) && typeof args[0] === "string" && typeof args[1] === "function") handlers.push({ path, channel: args[0], fn: args[1] });
      if (path === "contextBridge.exposeInMainWorld") emit("electron", `${path}:keys`, [Object.keys(args[1] ?? {})]);
      if (path === "app.whenReady") return Promise.resolve();
      if (/^app\.(on|once)$/.test(path) && args[0] === "ready" && typeof args[1] === "function") setImmediate(args[1]);
      return stub(`${path}()`);
    },
    construct(_t, args) {
      emit("electron", `new ${path}`, args);
      return stub(`new ${path}`);
    },
  });
  stubs.set(path, p);
  return p;
}
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === "electron" ? electron() : realLoad.call(this, request, ...rest);
};
// A destructuring `const { ipcMain } = require("electron")` reads properties off this object.
function electron() {
  return new Proxy({}, { get: (_t, prop) => (typeof prop === "symbol" || prop === "default" ? undefined : stub(String(prop))) });
}

// 3. drive handlers once, then record globals the target added
let driven = false;
process.on("beforeExit", async () => {
  if (driven) return;
  driven = true;
  for (const h of handlers) {
    try {
      emit("handler", `${h.path} ${h.channel}`, [await h.fn(stub("event"))]);
    } catch (e) {
      emit("handler", `${h.path} ${h.channel}`, [`throws: ${e && e.message}`]);
    }
  }
});
process.on("exit", () => {
  for (const name of Object.getOwnPropertyNames(g)) {
    if (before.has(name)) continue;
    let value;
    try {
      value = g[name];
    } catch (e) {
      value = `throws: ${e && e.message}`;
    }
    append(OBS, JSON.stringify({ kind: "global", name, args: [clip(value, 2000)] }) + "\n");
  }
});
