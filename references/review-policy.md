# Parent Review Policy

Read this file completely before every `revise` or `approve` decision.

## Evidence order

1. Compare the actual worker diff with every acceptance criterion and constraint.
2. Read every changed source/test file; Pi summaries are navigation only.
3. Inspect `verification.json`, including argv, exit code, timeout, truncation, and security issues.
4. Confirm the diff hash still matches verification evidence.
5. Check correctness, regressions, error handling, security, compatibility, tests, and maintainability.

## Priorities

| Priority | Meaning | Gate |
|---|---|---|
| P0 | Data loss, credential exposure, destructive or production-critical defect | Block |
| P1 | Likely correctness/security failure in normal use | Block |
| P2 | Real edge-case regression, missing required test, contract breach, or material maintainability defect | Block |
| P3 | Non-blocking preference or polish | Document; may approve |

An `approve` review has no P0-P2 findings and no verification gaps. A `revise` review contains at least one P0-P2 finding or verification gap. Every finding names file, tight line, problem, evidence, and required change.

## Using `self-review.json` (when present)

When `self-review` ran successfully, `self-review.json` exists alongside `verification.json`. It is a **hint, not evidence** — Pi can lie. Use it to focus your review, not to replace it.

1. **Read `self-review.json` first.** Note the per-criterion `status` (`met`/`uncertain`/`unmet`), self-reported `findings`, and `summary`.
2. **Check `diffSha256Mismatch`.** If `true`, Pi echoed the wrong hash → ignore the self-review and read the full diff.
3. **Check `fallbackRecommended`.** If `true` (Pi self-reports `unmet`/`uncertain` or any P0-P2 finding), read the full diff for those criteria.
4. **Spot-check at least `spotCheckRequired` criteria** that Pi marked `met`. Open the file/line Pi cited and confirm the evidence is real. If Pi lied, treat all `met` claims as suspect and fall back to full review.
5. **Investigate every `uncertain` and `unmet` criterion.** These are Pi admitting it cannot prove the criterion — the parent must read the actual diff and decide.
6. **Cross-check Pi's self-reported findings** against the actual diff. Pi may surface real issues (honest) or hide them (dishonest). Use the priority table below as usual.
7. **`verification.json` is still ground truth** for test/security outcomes. Pi's claims about tests are not evidence.

If `self-review.json` is missing or `selfReviewSkipped=true`, fall back to the full-diff review below.

## Approval checklist

- Wrapper-owned verification passed after the latest Pi turn.
- Security scan passed and source fingerprint is unchanged.
- Every acceptance criterion has direct evidence.
- No visual assertion depends on a text-only model.
- No user change is included in the implementation commit.
- The implementation commit contains only the delta after any dirty-source snapshot.

## Non-negotiable counters

| Temptation | Required response |
|---|---|
| "Pi says tests passed." | Ignore the claim; use `verification.json`. |
| "Pi's self-review marked everything `met`." | Spot-check at least `spotCheckCount` criteria against the real diff; Pi can lie. |
| "self-review diffSha256 mismatches." | Ignore the self-review; do a full-diff review. |
| "The diff is small." | Small diffs still pass all gates. |
| "The user does not want to review." | The parent agent reviews automatically; this never removes review. |
| "Only a P2 remains." | P2 blocks approval. |
| "Cherry-pick probably preserves dirty work." | Keep approved work on the worker branch; do not test that guess on user changes. |
| "GLM can infer the screenshot from prose." | Do not claim image understanding; keep visual work in the parent agent / ChatGPT. |

Red flags: approving from a summary, skipping a failing command, accepting a changed diff hash, stashing user work, mixing snapshot and implementation, or pushing automatically. Stop instead of weakening a gate.
