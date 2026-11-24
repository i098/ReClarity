# ReClarity

[![Featured in Awesome REA](https://img.shields.io/badge/Featured%20in-Awesome%20REA-f0b429)](https://github.com/AIshihzong/awesome-reverse-engineer-anything)

**Anti-BLA.** A skill and toolkit that keeps [REA](https://github.com/morluto/rea) working on builds that [BLA](https://github.com/qybaihe/bla) has hardened.

BLA plants decoy code, floods REA's fixed limits and adds clean-looking shadow logic. BLA must keep program behavior the same. ReClarity uses that rule.

## Quick start

```bash
npx skills add i098/ReClarity --skill anti-bla
bun skills/anti-bla/scripts/run.ts <target> --work /tmp/w --rea "rea analyze-javascript-application {target}"
```

Needs [Bun](https://bun.sh) and, for coverage, `bwrap`.

## Docs

- [Install and run](docs/install.md): install commands and the run command.
- [What it does and skills](docs/skills.md): the three skills and when to use each.
- [End-to-end recording](docs/e2e-recording.md): A/B run with a recording.
- [Measured comparison](docs/measured-comparison.md): plain REA, LASIK and ReClarity on BLA-hardened builds.
- [Auto-trigger](docs/auto-trigger.md): why the fence hook missed failed calls.
- [Usage](docs/usage.md): requirements, all commands, when REA runs call the skill.
- [Techniques](docs/techniques.md): each BLA trap and its answer.
- [Proof](docs/proof.md): A/B/C runs on a BLA 3.1.0 hardened sample, and the BLA 3.2.2 technique coverage table.
- [Risks](docs/risks.md): what ReClarity refuses and why.
- [Architecture](docs/architecture.md): flow and tools.

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md). Report a vulnerability as in [SECURITY.md](SECURITY.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
