# Contributing

Thank you for helping. Set up the project with [setup.md](setup.md).

## Build and test

```bash
bun install
bun test
bun run typecheck
```

Run both checks before you open a PR. Add a test only for algorithm logic, boundary I/O or an integration flow.

## Branch and PR flow

1. Fork the repository and branch from `main`.
2. Keep one topic per PR.
3. Fill in the PR template. Link the issue with `Closes #N`.
4. Wait for review. Do not force-push after a review starts.

## Commit rule

Every commit message and every PR title follows [Conventional Commits](https://www.conventionalcommits.org): `type(scope): imperative summary`.

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
Mark a breaking change with `!` or a `BREAKING CHANGE:` footer.

Example: `fix(anti-bla): guard the sanitize step on empty input`.

## Conduct

You agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
