# Install and use

## Requirements

- [Bun](https://bun.sh).
- `bwrap` for the coverage step.
- `python3` on `PATH` for Python targets.
- The first coverage run builds a venv with coverage.py in `~/.cache/anti-bla/pyvenv` (`ANTI_BLA_PYVENV` moves it).
- The first PyInstaller bundle builds a venv with pyinstxtractor-ng in `~/.cache/anti-bla/pyxvenv` (`ANTI_BLA_PYXVENV` moves it).
- Each venv build needs the network once.
- To clean a `.pyc`, put a `python3.X` on `PATH` that matches the file's version.

After `npx skills add i098/ReClarity --skill anti-bla`, run `bun install` in the installed `anti-bla` folder. It pins `acorn`.

For the tests, run `bun install` at the repo root, then `bun test`.

## Run

```bash
bun skills/anti-bla/scripts/scan.ts <target>            # score 0-100, reads only
bun skills/anti-bla/scripts/run.ts <target> --work /tmp/w --rea "rea analyze-javascript-application {target}"
bun skills/anti-bla/scripts/run.ts <target> --work /tmp/w --rea "..." --coverage   # plain JS or Python source
bun skills/anti-bla/scripts/runtime-guard.ts <target>   # JS, Electron main or .asar: run with and without inspector signals, report what differs
```

`run.ts` scans, cleans a copy, runs REA under the caps and retries once on a capacity error.

Tools: `scan`, `sanitize`, `fold-js`, `coverage`, `runtime-guard`, `guard`, `run`, `bench`. See [architecture.md](architecture.md). Rules for the agent: [SKILL.md](../skills/anti-bla/SKILL.md).

## Hooks (setup-clarity)

```bash
bun skills/setup-clarity/hooks/install.ts --target dist [--agent claude|codex|gemini]
```

Installs `guard`, `fence` and `session` hooks that enforce the anti-bla rules. See [SKILL.md](../skills/setup-clarity/SKILL.md).

## When REA runs call the skill

- A REA capacity error (`budget exceeded`, `conservatively bounded`, ASAR header or index limit, fuse sentinel limit).
- Words such as `enclave`, `attestation`, `TPM`, `vsock` or `hardware-sealed` in findings.
- `.blarc`, `.blarc.json`, `bla.config.json` or `.bla-manifest.json` in the target.
