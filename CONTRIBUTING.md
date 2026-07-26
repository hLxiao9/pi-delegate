# Contributing to pi-delegate

Thanks for your interest in improving pi-delegate! This is a short guide to make contributions smooth.

## Project layout

- `scripts/` — CLI entry points (`pi-worker.mjs`, `parent-meter.mjs`, `install-config.mjs`)
- `lib/` — core logic (state machine, verification, review, dashboard, adapters, etc.)
- `tests/` — `node:test` suite, run with `node --test --test-concurrency=1`
- `schemas/` — JSON schemas for `task.json` and `review.json`
- `references/` — long-form docs (provider configuration, review policy)
- `fixtures/` — default config + provider templates

## Development setup

```bash
git clone https://github.com/hLxiao9/pi-delegate.git
cd pi-delegate
npm link                 # exposes `pi-worker` on PATH
npm run check            # syntax check + full test suite
```

There are zero runtime dependencies; `npm install` is only needed if you add deps.

## Before opening a pull request

1. **Run the full check locally.** `npm run check` must pass (syntax + all tests).
   ```bash
   npm run check
   ```
2. **Add or update tests** for any behavior change. The suite lives in `tests/*.test.mjs` and uses `node:test`. If you change a string in `lib/`, check whether a test asserts on it.
3. **Keep the closed loop intact.** pi-delegate's security model rests on independent verification, diff-hash integrity, and hard gates. A PR that weakens any gate to "make it work" will not be accepted — raise an issue first to discuss the design.
4. **Do not enable Pi Bash, extensions, Skills, prompt templates, or auto-trust.** These are deliberately disabled; see `SKILL.md` → "Hard gates".
5. **Match the existing code style.** ES modules (`.mjs`), no transpiler, no runtime deps, 2-space indent, comments in English.
6. **Commit messages.** Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).

## Adding a new model provider or CLI adapter

1. If it's a new model on an existing provider, edit `fixtures/default-config.json` and add a profile entry. See `references/provider-configuration.md` for the schema.
2. If it's a new CLI backend (a new `adapter`), add `lib/adapters/<name>.mjs` extending `lib/adapters/base.mjs`, register it in `lib/adapters/index.mjs`, and add tests in `tests/adapters.test.mjs`.
3. Update `references/provider-configuration.md` with the adapter row and any provider-specific notes.
4. Run `pi-worker doctor --profile <name>` to validate.

## Reporting bugs

Open an issue using the Bug Report template. Include:
- `pi-worker doctor` output (redact API keys)
- `pi-worker inspect --id <run-id>` output for the failing run (redact secrets)
- The task JSON and review JSON if relevant
- Node, Git, and Pi versions

## Reporting security issues

**Do not open a public issue for security problems.** See [`SECURITY.md`](./SECURITY.md) for the private disclosure process.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0-or-later](./LICENSE) license that covers this project.
