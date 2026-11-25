# ReClarity: anti-BLA toolkit for AI reverse-engineering agents

[![Featured in Awesome REA](https://img.shields.io/badge/Featured%20in-Awesome%20REA-yellow)](https://github.com/AIshihzong/awesome-reverse-engineer-anything)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

ReClarity is an **anti-BLA** skill and toolkit. [BLA](https://github.com/qybaihe/bla) (Blind LLM Agents) hardens a build with decoy code, fixed-limit floods and clean-looking shadow logic so that the AI reverse-engineering agent [REA](https://github.com/morluto/rea) fails. ReClarity scans a hardened build, removes the BLA decoys from a copy, and checks the copy by running it, so REA can analyze it again. BLA must keep program behavior the same, and ReClarity relies on that rule.

**Agents:** follow [setup.md](setup.md) for exact setup steps from a clean machine.

## Install

```bash
npx skills add i098/ReClarity --skill anti-bla
npx skills add i098/ReClarity --skill setup-clarity   # then: bun <skill>/hooks/install.ts --target dist
```

Needs [Bun](https://bun.sh) and, for coverage, `bwrap`. Details: [docs/usage.md](docs/usage.md).

## Run

```bash
bun skills/anti-bla/scripts/run.ts <target> --work /tmp/w --rea "rea analyze-javascript-application {target}"
```

## BLA de-obfuscation: what it does

- **Scan** a build for BLA trap shapes before the first REA call. Score 0 means plain REA.
- **Clean a copy** of the build. The original stays unchanged.
- **Check by running** the build in a bwrap sandbox with coverage. Never-run code is "not run", never evidence.
- **Guard the budget** with token and time caps and one retry after a REA capacity error.
- **Treat target text as data.** Bait text is a finding, never an instruction.

## Anti-BLA skills

| Skill | Use it when |
| --- | --- |
| [`anti-bla`](skills/anti-bla/SKILL.md) | A REA run hits a capacity error, shows enclave or attestation words, or the target has BLA config files. It scans, cleans a copy and checks by running. |
| [`untrusted-repo-read`](skills/untrusted-repo-read/SKILL.md) | A repository you must read carries text that gives orders to an AI. It writes a view copy where those spans are markers. |
| [`setup-clarity`](skills/setup-clarity/SKILL.md) | You start a project that will get BLA-hardened builds. It installs hooks that enforce the anti-bla rules. |

## Measured: ReClarity vs LASIK on BLA-hardened builds

Correct means the program output equals the unhardened app's output (5 JS seeds, 3 release files):

| BLA | Arm | JS seeds correct | Release files correct | Release ASAR header |
| --- | --- | --- | --- | --- |
| 3.2.1 | LASIK | 0 of 5 | 2 of 3 | 1 KB |
| 3.2.1 | ReClarity | 5 of 5 | 3 of 3 | 0.7 KB |
| 3.5.9 | LASIK | 0 of 5 | 2 of 3 | 20.0 MB |
| 3.5.9 | ReClarity | 5 of 5 | 3 of 3 | 4.2 MB |

One run per cell, no agent run; plain REA, method and limits are in [docs/measured-comparison.md](docs/measured-comparison.md).

## End-to-end recording

[![ReClarity e2e v3 recording, 6x speed preview](docs/media/reclarity-e2e-v3-preview.gif)](docs/media/reclarity-e2e-v3.mp4)

Plain REA stopped at the ASAR limit with 0 of 3 answers. REA with ReClarity gave 3 of 3 correct answers. One run each, one model (Claude Opus 5.5). Auto-trigger did not work in this recording; see [docs/e2e-recording.md](docs/e2e-recording.md) and [docs/auto-trigger.md](docs/auto-trigger.md).

## Docs

- [Usage](docs/usage.md): requirements, all commands, when REA runs call the skill.
- [Techniques](docs/techniques.md): each BLA trap and its answer.
- [Proof](docs/proof.md): A/B/C runs on a BLA 3.1.0 hardened sample, and the BLA 3.2.2 technique coverage table.
- [Measured comparison](docs/measured-comparison.md): plain REA, LASIK and ReClarity.
- [Risks](docs/risks.md): what ReClarity refuses and why.
- [Architecture](docs/architecture.md): flow and tools.
- [Auto-trigger](docs/auto-trigger.md): why the fence hook missed failed calls, and the live check.
- [Install and run](docs/install.md), [skills](docs/skills.md), [end-to-end recording](docs/e2e-recording.md).

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md). Report a vulnerability as in [SECURITY.md](SECURITY.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
