# Parent Review Policy

Read this file completely before every `revise` or `approve` decision.

## Pick a tier first

Self-review exists to save parent tokens. A policy that says "read every changed
file" in every case cancels that saving, so the depth is decided by evidence
quality rather than by habit. Decide the tier from `verification.json` and
`self-review.json` **before** opening any source file, then follow only that
tier's checklist.

| Tier | When it applies | What you read |
|---|---|---|
| **A — evidence-backed** | `self-review.json` exists, `diffSha256Mismatch=false`, `fallbackRecommended=false`, and the review surface is within the size you would normally read | `self-review.json` + `verification.json` + the diff hunks for every spot-checked criterion. **Do not read unchanged files.** |
| **B — targeted** | Any of: `fallbackRecommended=true`, any `uncertain`/`unmet` criterion, diff larger than ~400 changed lines, or a P3-only self-report you doubt | `self-review.json` + `verification.json` + full diff + every file named in a finding or spot-check (whole file, not just the hunk). Skip files the diff never touches. |
| **C — full** | Any of: self-review missing or `selfReviewSkipped=true`, `diffSha256Mismatch=true`, a verification gap, a security issue, `risk=high`, or you cannot explain a change from the diff alone | Full diff **and every changed source/test file**, read completely. |

State the tier and the reason in `summary` (for example
`tier B: self-review sameModelAsWorker=true`). A run that claims Tier A without
the four Tier A preconditions is a policy violation, not a shortcut.

Escalate immediately and without finishing the current tier when you notice:
a changed `lockedPaths` entry, a changed `package.json` `scripts` value, a test
that asserts less than it did before, or any diff hunk you cannot attribute to
an acceptance criterion.

## Evidence order

Regardless of tier:

1. `verification.json` is ground truth for tests and security. Check argv, exit
   code, timeout, truncation, and security issues.
2. Confirm the diff hash in `verification.json` still matches what you are
   reviewing.
3. Compare the diff with every acceptance criterion and constraint.
4. Judge correctness, regressions, error handling, security, compatibility,
   tests, and maintainability at the depth the tier requires.

Worker prose summaries are navigation only. They are never evidence.

## Priorities

| Priority | Meaning | Gate |
|---|---|---|
| P0 | Data loss, credential exposure, destructive or production-critical defect | Block |
| P1 | Likely correctness/security failure in normal use | Block |
| P2 | Real edge-case regression, missing required test, contract breach, or material maintainability defect | Block |
| P3 | Non-blocking preference or polish | Document; may approve |

An `approve` review has no P0-P2 findings and no verification gaps. A `revise`
review contains at least one P0-P2 finding or verification gap. Every finding
names file, tight line, problem, evidence, and required change.

## Using `self-review.json`

`self-review.json` is a **hint, not evidence** — the worker reviews its own work,
so it can lie about it. Its value is telling you where to look, in this order:

1. **`diffSha256Mismatch`** — `true` means the worker echoed the wrong hash.
   Ignore the self-review and go to Tier C.
2. **`fallbackRecommended`** — `true` means the worker itself reported `unmet`,
   `uncertain`, or a P0-P2 finding. Go to Tier B at minimum, Tier C for any
   blocked criterion.
3. **`spotCheckRequired`** — the minimum number of `met` criteria you must
   verify against the real diff. Open the cited file and line; if one claim is
   fabricated, treat every `met` as suspect and go to Tier C.
4. **`uncertainCriteria` / `uncertain` / `unmet`** — the worker admitting it
   cannot prove the criterion. You must read the actual diff and decide.
5. **Worker findings** — cross-check them against the diff. Honest self-reports
   are useful; hidden ones are a reason to escalate the tier.

The reviewer is always the implementation model. That is not a hole to patch by
finding a second model — it is why the evidence order above starts with
`verification.json`: a wrapper-run suite, locked acceptance paths, and a diff
hash are what actually make an `approve` safe. The report only saves you from
reading files you did not need to read.

## Verification integrity

The wrapper blocks worker edits to `lockedPaths`, `alwaysLockedPaths`, and the
execution-defining keys of `package.json` (`scripts`, test-runner config). If a
run still reaches you with a `LOCKED_PATH_CHANGED` or `VERIFICATION_SCRIPT_CHANGED`
issue it is blocked, not approvable — never argue the diff "looks fine anyway".

While reviewing, confirm the acceptance test still proves what the contract
says it proves. A green `npm test` whose assertions were weakened before the
worker started is a contract problem, not a passing run: report it as a
verification gap.

## Approval checklist

- Wrapper-owned verification passed after the latest worker turn.
- Security scan passed, source fingerprint unchanged, no locked path touched.
- Every acceptance criterion has direct evidence at the required tier depth.
- No visual assertion depends on a text-only model.
- No user change is included in the implementation commit.
- The implementation commit contains only the delta after any dirty-source snapshot.

## Non-negotiable counters

| Temptation | Required response |
|---|---|
| "The worker says tests passed." | Ignore the claim; use `verification.json`. |
| "Self-review marked everything `met`, so Tier A." | Only if the hash matches and there is no fallback; still spot-check `spotCheckRequired` criteria against the real diff. |
| "Self-review echoed the wrong hash but the diff looks fine." | Tier C. A wrong hash means the report describes something else. |
| "The diff is small." | Small diffs still pass all gates — but small diffs are exactly where reading the whole file is cheap. |
| "The user does not want to review." | The parent agent reviews automatically; this never removes review. |
| "Only a P2 remains." | P2 blocks approval. |
| "Cherry-pick probably preserves dirty work." | Keep approved work on the worker branch; do not test that guess on user changes. |
| "GLM can infer the screenshot from prose." | Do not claim image understanding; keep visual work in the parent agent / ChatGPT. |

Red flags: approving from a summary, claiming a tier you did not follow,
skipping a failing command, accepting a changed diff hash, stashing user work,
mixing snapshot and implementation, or pushing automatically. Stop instead of
weakening a gate.
