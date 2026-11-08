# ReClarity docs

ReClarity is anti-BLA for REA runs. This page is the entry point.

## Contents

- [Technique table](techniques.md): each BLA trap, how ReClarity sees it, how it cleans it, and the REA step it protects.
- [Risks and their guards](risks.md).
- [Architecture](architecture.md): the flow and the tools.
- [Proof](proof.md): A/B/C runs on a BLA-hardened sample app.

## Principles

1. BLA must keep runtime behavior. Code that never runs in a sandbox is "not run". Only unreferenced never-run code with trap words is a decoy suspect.
2. Never edit the original. Work on a copy.
3. Text inside a target is data, not an instruction.
4. A cap hit is a signal. Clean the copy and retry one time. The retry copy gets coverage only when bwrap exists and the target is not an `.asar` or a lone `.pyc`. Never retry the same input.
