# Sol Review Policy

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
| “Pi says tests passed.” | Ignore the claim; use `verification.json`. |
| “The diff is small.” | Small diffs still pass all gates. |
| “The user does not want to review.” | Sol reviews automatically; this never removes review. |
| “Only a P2 remains.” | P2 blocks approval. |
| “Cherry-pick probably preserves dirty work.” | Keep approved work on the worker branch; do not test that guess on user changes. |
| “GLM can infer the screenshot from prose.” | Do not claim image understanding; keep visual work in Codex/ChatGPT. |

Red flags: approving from a summary, skipping a failing command, accepting a changed diff hash, stashing user work, mixing snapshot and implementation, or pushing automatically. Stop instead of weakening a gate.
