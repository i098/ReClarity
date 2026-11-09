# Setup (for agents)

Set up ReClarity from a clean Debian or Ubuntu machine. Run each step in order. Stop at the first failure.

## 1. Install the tools

```bash
curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"
sudo apt-get install -y bubblewrap python3   # Debian or Ubuntu; provides bwrap
bun --version && bwrap --version && python3 --version
```

`bwrap` is only for the coverage step. `python3` is only for Python targets.

## 2. Install the dependencies

```bash
git clone https://github.com/i098/ReClarity.git && cd ReClarity
bun install
```

## 3. Run the tests

```bash
bun test --timeout 120000
bun run typecheck
```

Both commands must exit 0. The first coverage and PyInstaller tests build Python venvs in `~/.cache/anti-bla` and need the network once. The long timeout covers that cold-cache build.

## 4. Install the skill

```bash
npx skills add i098/ReClarity --skill anti-bla
```

Then run `bun install` in the installed `anti-bla` folder. It pins `acorn`.

## 5. Check the skill

```bash
bun skills/anti-bla/scripts/scan.ts <target>
```

The command prints a score from 0 to 100. See [docs/usage.md](docs/usage.md) for all commands.
