# Scope and hard limits

What this loop can delegate, what it only appears to delegate, and which limits
are config and which are architecture. Routing decisions belong here; keep the
table honest, because a wrong `fits` costs a full worker run plus a revision
cycle, and a wrong `does not fit` costs the parent tokens the loop exists to
save.

## The four conditions

A task is delegable when all four hold. Missing any one is not a tuning problem.

1. **A Git repository with one base revision.** The worker gets a worktree and a
   branch; the change must land as one commit on top of one base. Not a repo →
   stay in the parent (`prepare` requires Git).
2. **A bounded diff.** The worker edits files inside an allowlist. Work that
   touches hundreds of files, or rewrites large files wholesale, is rejected by
   the limits below rather than reviewed badly.
3. **Verification expressible as argv with an exit code.** The wrapper runs
   `verification[].argv`; that run is the only independent evidence. If
   acceptance is "looks right" or "feels good", there is no gate.
4. **No runtime feedback required to get it right.** Every adapter removes the
   shell (`PI_TOOLS` is `read,grep,find,ls,edit,write`; Qoder allows
   `Read,Write,Grep,Glob,Edit,MultiEdit`). The worker cannot start the app, run
   the test suite, or see a stack trace. It writes once, blind, and the parent's
   `verify` is the first time anyone runs anything.

## Hard limits

| Limit | Value | Enforced by | Widenable? |
|---|---|---|---|
| Shell / test execution in the worker | never | `lib/adapters/*` tool allowlists | No — this is the isolation model |
| Binary file changes | blocked (`BINARY_CHANGE`) | `lib/security.mjs` numstat scan | No in v1 |
| Symlink changes | blocked (`SYMLINK_CHANGE`) | `lib/security.mjs` | No in v1 |
| Changed files per run | 80 | `limits.maxChangedFiles` | Yes, per config |
| Diff size | 2 MB | `limits.maxDiffBytes` | Yes |
| Deleted lines | ≤ 300 and ≤ 35% of the edited file | `limits.maxDeletedLines`, `maxDeletedLineRatio` | Yes, both |
| Renames | not detected (`--no-renames`) → shown as delete + add | `lib/security.mjs` | No — affects the deletion budget |
| Revision rounds | exactly 2 | `config.maxRevisionRounds` validation | No — fixed in v1 |
| `risk: high` | never delegated (`HIGH_RISK_BLOCKED`) | `lib/contracts.mjs` | No |
| Project convention files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`) | not read by the worker | `--no-context-files` | No — the contract is the only context |
| Skills / extensions / prompt templates | disabled | adapter flags | No |
| Two runs on the same repository at once | second one fails at `approve` (`SOURCE_CHANGED`) | `sourceUnchanged` fingerprint | No — by design |

## Fit by task type

| Task | Verdict | Why |
|---|---|---|
| Bug fix with a failing test | **fits** | Small diff, exit code is the truth |
| Add a function/endpoint/module with tests | **fits** | Bounded, verifiable |
| Mechanical refactor inside a file | **fits** if deletions stay under the budget | Line limits are the binding constraint |
| Add tests for existing code | **fits**, but the tests are the acceptance criteria — do not put them in `lockedPaths` *and* ask for them | Self-defeating contract |
| Dependency bump | **fits** only if `npm install` is not needed at verify time | Worker cannot install; `package.json` scripts are frozen |
| Multi-file feature (3–10 files) | **fits with prep** | Needs a precise contract; expect a revision round |
| Rename/move a module | **does not fit** | `--no-renames` turns it into delete + add, which trips the deletion ceiling |
| Repo-wide refactor / architecture change | **does not fit** | 80-file cap, deletion ratio, and the parent owns architecture |
| Migration of a data store / schema | **does not fit** | Irreversible and verification is not local |
| Performance work | **does not fit** unless a benchmark is the verification argv | Worker cannot profile |
| Visual/UI judgment, screenshots, layout polish | **does not fit** | The pipeline is text-only; `vision-input` only gates routing, nothing attaches an image |
| Binary assets (images, audio, models) | **does not fit** | `BINARY_CHANGE` blocks it outright |
| Anything needing `risk: high` | **does not fit** | `HIGH_RISK_BLOCKED` |

## Games specifically

The unit of delegation is a *file diff with a command that proves it*, not a
"feature". That splits game work along a line that has nothing to do with how
designers talk about features:

| Game task | Verdict | Reasoning |
|---|---|---|
| Damage formula, drop table, XP curve as pure functions + unit tests | **fits** | Deterministic, headless, small |
| Save/load serialization with a round-trip test | **fits** | Classic bounded contract |
| State machine for a weapon/ability, tested headlessly | **fits** | Logic without the engine loop |
| Port a prototype into the existing system, tests already written | **fits** | The parent defines the shape |
| Tuning numbers so combat "feels right" | **does not fit** | No gate; the worker cannot play the build |
| Level layout, pacing, encounter design | **does not fit** | Subjective + visual |
| UI/HUD layout polish, screenshot comparison | **does not fit** | Text-only pipeline, no screenshots |
| Sprite/texture/animation/audio assets | **does not fit** | Binary changes are blocked |
| Godot `.tscn` scene edits | **risky** | Text, so it diffs — but scene files are large, generated-looking, and their correctness is visual. Cap at small node/property changes, prefer editing the script that drives the scene |
| Godot `.gd` logic with a headless test harness | **fits** | Text diff + real exit code |
| Godot import-cache / `.import` churn | **does not fit** | Generated churn inflates the diff and the file count |

A useful test: **would a competent contractor with no ability to run the game,
no ability to look at a screenshot, and a one-page spec produce a mergeable
patch?** If yes, delegate. If the answer needs "well, they'd have to open the
editor and see", keep it in the parent.

## What has not been measured

The nine-run evaluation behind `CHANGELOG.md` (qoder/Qwen3.8-Flash plus one
codebuddy control) was all inside the sweet spot: one repository, 1–3 files,
files under 150 lines, a `npm test` suite the parent wrote first, no
dependencies, 20–200 s per run. It says nothing about:

- contracts that are ambiguous on purpose (the one real failure was self-inflicted
  ambiguity, not scale);
- diffs near the 80-file or 300-deleted-line ceiling;
- multi-round work where the second revision also fails;
- any language other than JavaScript;
- Godot/GDScript, which is the case that matters most for the game projects.

Until those are measured, treat "fits" above as reasoned from the constraints,
not as observed. When a run fails outside the table, fix the table.
