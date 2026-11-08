// Python in a bwrap sandbox: the coverage.py run of a target, and the .pyc decoy cleaner.
// Target code and target bytes are untrusted: they meet an interpreter only inside bwrap
// (no network, no home, no secrets in env, read-only root). Callers check hasSandbox() first.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const COVERAGE_VERSION = "7.17.2";
export const SANDBOX_APP = "/app";
const PYCCLEAN = join(import.meta.dir, "pycclean.py");
const PYFACTS = join(import.meta.dir, "pyfacts.py");
const MAX_COV_JSON = 64 * 1024 * 1024;

/** Mounts every sandbox gets: read-only /usr, a private /proc, /dev and /tmp, no network, no env. */
function baseArgs(): string[] {
  const a = ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib"];
  if (existsSync("/lib64")) a.push("--ro-bind", realpathSync("/lib64"), "/lib64");
  a.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  return a;
}

/** Bind the tree an interpreter lives in, unless /usr already holds it. */
function interpreterBinds(python: string): string[] {
  const real = realpathSync(python);
  const root = dirname(dirname(real));
  return real.startsWith("/usr/") ? [] : ["--ro-bind", root, root];
}

export interface BoxResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function box(args: string[], timeoutSec: number): BoxResult {
  const r = Bun.spawnSync(["bwrap", ...args], { timeout: timeoutSec * 1000, killSignal: "SIGKILL", env: { PATH: process.env.PATH ?? "/usr/bin" }, stdout: "pipe", stderr: "pipe" });
  return { exitCode: r.exitCode ?? null, timedOut: r.signalCode === "SIGKILL" || r.exitedDueToTimeout === true, stdout: r.stdout.toString().slice(0, 1_000_000), stderr: r.stderr.toString().slice(0, 2000) };
}

/** `python -I pyfacts.py`: parses, never imports. Run with the plain host python3 (any 3.9+; `ast.unparse` needs it). */
export function pyFacts(root: string, rels: string[]): Record<string, unknown> {
  const py = Bun.which("python3");
  if (!py || !rels.length) return {};
  const r = Bun.spawnSync([py, "-I", PYFACTS, root, ...rels], { stdout: "pipe", stderr: "ignore", maxBuffer: 256 * 1024 * 1024 });
  try {
    return JSON.parse(r.stdout.toString());
  } catch {
    return {};
  }
}

/** A venv that holds coverage.py, made once on first use (the only step that needs the network; target code never runs there). */
export function coverageVenv(): string {
  const venv = process.env.ANTI_BLA_PYVENV ?? join(homedir(), ".cache", "anti-bla", "pyvenv");
  const py = join(venv, "bin", "python");
  const have = (): boolean => existsSync(py) && Bun.spawnSync([py, "-c", `import coverage,sys;sys.exit(coverage.__version__!="${COVERAGE_VERSION}")`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  if (have()) return venv;
  const host = Bun.which("python3");
  if (!host) throw new Error("coverage.py needs python3 on PATH to make its venv");
  mkdirSync(dirname(venv), { recursive: true });
  const steps = [[host, "-m", "venv", "--clear", venv], [py, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", `coverage==${COVERAGE_VERSION}`]];
  for (const s of steps) {
    const r = Bun.spawnSync(s, { stdout: "ignore", stderr: "pipe", timeout: 180_000 });
    if (r.exitCode !== 0) throw new Error(`could not set up coverage.py in ${venv}: ${r.stderr.toString().trim().split("\n").at(-1) ?? ""}`);
  }
  return venv;
}

export interface PyRun {
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  /** Executed line numbers per path relative to the app root. Empty when coverage.py produced nothing. */
  executed: Map<string, Set<number>>;
}

/** Run `entry` (or `driver`, which gets ANTI_BLA_TARGET) under coverage.py inside the sandbox; then turn the data file into JSON in a second sandbox, so the host never opens a file the target wrote. */
export function runUnderCoveragePy(app: string, entry: string, driver: string | undefined, timeoutSec: number): PyRun {
  const venv = realpathSync(coverageVenv());
  const venvPy = join(venv, "bin", "python");
  const cov = mkdtempSync(join(tmpdir(), "antibla-pycov-"));
  try {
    const env = ["--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--setenv", "PYTHONDONTWRITEBYTECODE", "1", "--setenv", "PYTHONHASHSEED", "0", "--setenv", "ANTI_BLA_TARGET", `${SANDBOX_APP}/${entry}`];
    const mounts = [...baseArgs(), ...interpreterBinds(venvPy), "--ro-bind", venv, venv, "--ro-bind", app, SANDBOX_APP, "--bind", cov, "/cov", ...(driver ? ["--ro-bind", driver, "/driver.py"] : []), ...env, "--chdir", SANDBOX_APP];
    const data = ["--data-file=/cov/.coverage"];
    const run = box([...mounts, join(venv, "bin", "python"), "-m", "coverage", "run", ...data, `--source=${SANDBOX_APP}`, driver ? "/driver.py" : `${SANDBOX_APP}/${entry}`], timeoutSec);
    const executed = new Map<string, Set<number>>();
    const json = box([...mounts, join(venv, "bin", "python"), "-m", "coverage", "json", ...data, "-o", "/cov/out.json", "--quiet", "--ignore-errors"], 60);
    const out = join(cov, "out.json");
    if (json.exitCode === 0 && existsSync(out) && Bun.file(out).size < MAX_COV_JSON) {
      try {
        const files: Record<string, { executed_lines?: unknown }> = JSON.parse(readFileSync(out, "utf8")).files ?? {};
        for (const [path, f] of Object.entries(files)) {
          const rel = path.startsWith(`${SANDBOX_APP}/`) ? path.slice(SANDBOX_APP.length + 1) : path;
          if (Array.isArray(f.executed_lines)) executed.set(rel, new Set(f.executed_lines.filter((n): n is number => Number.isInteger(n))));
        }
      } catch {
        // coverage.py wrote nothing usable (the target may have killed it): no file counts as loaded
      }
    }
    return { exitCode: run.exitCode, timedOut: run.timedOut, stderr: run.stderr, executed };
  } finally {
    rmSync(cov, { recursive: true, force: true });
  }
}

/** The little-endian magic number of a .pyc header, or undefined when the bytes are not one. */
export const pycMagic = (bytes: Uint8Array): number | undefined => (bytes.length >= 16 && bytes[2] === 0x0d && bytes[3] === 0x0a ? bytes[0]! | (bytes[1]! << 8) : undefined);

const magicCache = new Map<string, number | undefined>();
const magicOfPython = (py: string): number | undefined => {
  if (!magicCache.has(py)) {
    const r = Bun.spawnSync([py, "-I", PYCCLEAN, "--magic"], { stdout: "pipe", stderr: "ignore" });
    magicCache.set(py, r.exitCode === 0 ? Number(r.stdout.toString().trim()) : undefined);
  }
  return magicCache.get(py);
};

/** The interpreter whose marshal reads this .pyc: python3 and python3.7 .. python3.14 on PATH. */
export function pythonForMagic(magic: number): string | undefined {
  const names = ["python3", ...Array.from({ length: 8 }, (_, i) => `python3.${14 - i}`)];
  for (const n of names) {
    const p = Bun.which(n);
    if (p && magicOfPython(p) === magic) return p;
  }
  return undefined;
}

export type PycOutcome = { kind: "cleaned"; removed: string[]; trailerDropped: number } | { kind: "kept"; why: string };

/** Write a cleaned copy of one .pyc to `dst`, or say why it was left alone (the caller copies it unchanged). */
export function cleanPyc(src: string, dst: string): PycOutcome {
  if (!Bun.which("bwrap")) return { kind: "kept", why: "bwrap not found: marshal data is parsed only inside the sandbox" };
  const head = readFileSync(src).subarray(0, 16);
  const magic = pycMagic(head);
  if (magic === undefined) return { kind: "kept", why: "not a CPython .pyc header" };
  const py = pythonForMagic(magic);
  if (!py) return { kind: "kept", why: `no python3 on PATH reads pyc magic ${magic}` };
  const out = mkdtempSync(join(tmpdir(), "antibla-pyc-"));
  try {
    const r = box([...baseArgs(), ...interpreterBinds(py), "--ro-bind", PYCCLEAN, "/pycclean.py", "--ro-bind", src, "/in.pyc", "--bind", out, "/out", "--setenv", "PATH", "/usr/bin:/bin", realpathSync(py), "-I", "/pycclean.py", "/in.pyc", "/out/o.pyc"], 60);
    if (r.exitCode !== 0) return { kind: "kept", why: `cleaner failed: ${r.stderr.trim().split("\n").at(-1) ?? "no output"}` };
    const rep: { removed?: unknown; trailer_dropped?: unknown } = JSON.parse(r.stdout);
    if (!Array.isArray(rep.removed) || typeof rep.trailer_dropped !== "number") return { kind: "kept", why: "cleaner gave no report" };
    writeFileSync(dst, readFileSync(join(out, "o.pyc")));
    return { kind: "cleaned", removed: rep.removed.map(String), trailerDropped: rep.trailer_dropped };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
