## Summary

<!-- 1-3 sentences: what does this PR do and why? -->

## Type

- [ ] `feat` — new feature
- [ ] `fix` — bug fix
- [ ] `docs` — documentation only
- [ ] `test` — tests only
- [ ] `refactor` — no behavior change
- [ ] `chore` — build / config / tooling

## Checklist

- [ ] `npm run check` passes (syntax + full test suite)
- [ ] Tests added or updated for any behavior change
- [ ] No API keys, tokens, or secrets in the diff
- [ ] No new runtime dependencies added without discussion
- [ ] Code is ES modules (`.mjs`), 2-space indent, English comments
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)

## Hard gates (do not weaken)

- [ ] Independent wrapper verification is still required to approve
- [ ] Diff-hash integrity is still checked at every gate
- [ ] Pi Bash / extensions / Skills / prompt templates / context files / auto-trust are still disabled
- [ ] No new push / PR / remote-changing behavior added
- [ ] No fallback added that routes around authentication errors

If any box above is unchecked, explain why in "Design notes" — weakening a gate requires prior agreement in an issue.

## Design notes

<!-- Why this approach? Any trade-offs? Anything a reviewer should look at carefully? -->

## Test plan

<!-- How did you verify this? Reference test names, run IDs, or paste `npm test` summary. -->
