# Install

```bash
npx skills add i098/ReClarity --skill anti-bla
npx skills add i098/ReClarity --skill setup-clarity   # then: bun <skill>/hooks/install.ts --target dist
```

Needs [Bun](https://bun.sh) and, for coverage, `bwrap`. See [docs/usage.md](usage.md).

**Agents:** follow [setup.md](../setup.md) to install the tools, run the tests and install the skill.

## Run

```bash
bun skills/anti-bla/scripts/run.ts <target> --work /tmp/w --rea "rea analyze-javascript-application {target}"
```
