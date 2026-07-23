---
name: pi-delegate
description: Use when a user explicitly invokes $pi-delegate, asks Codex to delegate a bounded code implementation to Pi CLI or a cheaper coding model, or requests unattended coding completion across projects.
---

# Pi Delegate

## Core principle

Keep architecture, acceptance criteria, independent verification, review, and commit authority with GPT-5.6 Sol. Treat Pi as an untrusted implementation worker. Do not ask the user to review code.

## Route first

Delegate bounded features, bug fixes, tests, and mechanical refactors with deterministic checks and a narrow path allowlist.

Work directly in Codex when the task is trivial, architectural, high-risk (security/auth/production infrastructure/irreversible migration), lacks reliable verification, or requires screenshots, visual comparison, or image understanding. Route image generation through an available browser-control Skill to the user's authenticated ChatGPT web session; if that session is unavailable, report a setup blocker instead of sending the image task to Pi. Never send `vision-input` or `image-output` to Pi; GLM is text-only for this workflow. For direct tasks, continue with the normal Codex workflow: implement, verify, inspect the actual diff, auto-commit only when the source is safe, and never push.

The Pi worker requires a Git repository. In a non-Git project, stay in Codex, verify directly, and state that automatic commit is unavailable.

## Closed loop

Use `/Users/xiao9/.agents/skills/pi-delegate/scripts/pi-worker.mjs`; run it with `node`.

1. Confirm the Git root, choose a unique run ID, and immediately run `codex-meter.mjs --output /tmp/pi-worker-ID-codex-start.json` before detailed planning.
2. Read project instructions; record HEAD and dirty status; define exact allowed/forbidden paths, acceptance criteria, and argv-form verification. Create a task JSON matching `schemas/task-contract.schema.json`. Create temporary JSON files with `apply_patch`, never shell redirection.
3. Run `doctor --task TASK`, then `prepare --task TASK --codex-start START`, then `run --id ID`. A setup/credential failure is a real blocker; report it without weakening isolation.
4. Run `verify --id ID`. Read the complete actual diff, every changed file, `verification.json`, and `references/review-policy.md`. Pi's summary and test claims are not evidence.
5. If verification or Sol review has a P0-P2 finding or verification gap, write `verdict: revise` matching `schemas/review-result.schema.json`, call `revise`, and return to step 4. Allow at most two revision turns. Then stop without commit if any gate still fails.
6. When every gate passes, write `verdict: approve`. Call `approve` immediately without asking the user, then `integrate`. A dirty or changed source must remain on the worker branch and report `blocked`; never stash, reset, checkout, or mix user changes.
7. For every created run, call `report`; pass `--chatgpt-image-generations N` when the same user task used ChatGPT web for images. If `doctor` fails before `prepare`, report that setup blocker directly because no run exists. Call `cleanup` only after successful integration and report persistence. Preserve failed/blocked worktrees and logs.

If a Codex thread resumes after interruption, read the persisted `state.json` and reissue only the command corresponding to its current state. `run` and `revise` consume their Pi-turn receipt or terminal event evidence; never restart the entire workflow or recreate an existing run.

## Hard gates

- Require wrapper verification success, unchanged diff hash, passed security scan, acceptance evidence, and zero unresolved P0, P1, or P2 findings.
- Never enable Pi Bash, extensions, Skills, prompt templates, context files, or project auto-trust.
- Never push, create a PR, change remotes, or describe worktree isolation as an OS sandbox.
- Do not route around authentication errors or capability mismatches with a fallback.

## Final response

Report implementation, exact verification, Sol verdict, revision count, commit/branch, integration status, actual Sol credits when available, Pi usage, estimated savings, cash impact, and “not pushed.” The user needs no code-review action. Mention only blockers that require credentials, authority, or safe integration.

Read `references/provider-configuration.md` only for setup/provider changes. Read `references/review-policy.md` for every delegated review.
