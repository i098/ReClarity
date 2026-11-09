# Security policy

## Report a vulnerability

Do not open a public issue. Use [private vulnerability reporting](https://github.com/i098/ReClarity/security/advisories/new).

Include the affected file, the steps to reproduce and the impact. You get an answer in 7 days.

## Scope

ReClarity runs untrusted builds in a bwrap sandbox. A sandbox escape, or target text that the tool treats as an instruction, is in scope. See [docs/risks.md](docs/risks.md).

## Supported versions

Only the latest commit on `main` gets fixes.
