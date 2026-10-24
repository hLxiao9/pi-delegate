---
name: spotworkers
description: Use when a user explicitly invokes $pi-delegate or $spotworkers, asks the parent agent to delegate a bounded code implementation to a cheap agent worker (Pi CLI / Kimi Code CLI / Trae CLI / Qoder CLI / CodeBuddy CLI / ZCode CLI, i.e. WorkBuddy) or a cheaper coding model, or requests unattended coding completion across projects. Supports multiple CLI backends via the adapter system (pi/kimi/trae/qoder/opencode/codebuddy). Formerly published as pi-delegate; the `pi-worker` command remains an alias for `spot`.
---

# Spotworkers

> Formerly `pi-delegate`. The CLI binary is `spot` (alias: `pi-worker`). State, config and cache directories keep the historical `pi-worker` name so existing installs keep working.

## Core principle

Keep architecture, acceptance criteria, independent verification, review, and commit authority with the parent agent (Codex / Claude Code / Trae / Cursor / another Pi). Treat Pi as an untrusted implementation worker. Do not ask the user to review code.

## Multi-parent dispatch

The skill is parent-agnostic. Set `PARENT_AGENT` (and, when applicable, `PARENT_THREAD_ID`) in the environment that invokes `spot prepare` so usage tracking and dashboard traffic source are routed correctly:

| `PARENT_AGENT` | Usage backend | Notes |
|---|---|---|
| `codex` (default) | `~/.codex/sessions/` rollout JSONL | Reads `CODEX_THREAD_ID` (or `PARENT_THREAD_ID`). |
| `claude-code` | `~/.claude/projects/` session JSONL | Requires `PARENT_THREAD_ID`. |
| `trae` | not yet implemented | Reports `available:false`; set `PARENT_AGENT=codex` or `claude-code` if you need usage numbers. |
| `cursor` | not yet implemented | Same as `trae`. |
| `pi-recursive` | not yet implemented | Use when one Pi delegates to another Pi; usage stays on the outer Pi. |
| `workbuddy` | none | Dispatched from the WorkBuddy agent. Auto-detected when the `WORKBUDDY` (or `WORKBUDDY_AGENT`) env var is set; otherwise set `PARENT_AGENT=workbuddy` explicitly. |
| `cli` | none | For ad-hoc shell invocations with no parent session to meter. |

The `prepare` command records the resolved caller into `state.caller` (one of `trae`, `codex`, `claude-code`, `cursor`, `pi-recursive`, `workbuddy`, `cli`, `unknown`). The dashboard groups runs by caller and the Source column / filter recognises `workbuddy`. `list --caller <name>` filters accordingly.

Caller resolution order: explicit `PARENT_AGENT` / `PI_WORKER_CALLER` → WorkBuddy shell marker (`WORKBUDDY` / `WORKBUDDY_AGENT`) → `cli`. When the WorkBuddy agent invokes spotworkers, exporting `PARENT_AGENT=workbuddy` (or relying on the `WORKBUDDY` marker) makes the dashboard attribute runs to the **workbuddy** source instead of the generic `cli`.

## Automatic model selection by difficulty

The skill auto-selects a Pi profile whose `costTier` matches the inferred task difficulty:

| Difficulty | `costTier` | Typical model class |
|---|---|---|
| `low` | `cheap` | DeepSeek, Qwen-Flash, small open models |
| `medium` | `standard` | Volcengine ark-code, Kimi, GLM, MiniMax-M2.7 |
| `high` | `premium` | MiniMax-M3, Claude Opus via Pi, frontier models |

Difficulty is decided by `lib/difficulty.mjs`. **Declare it in the contract** (`difficulty: low|medium|high`) whenever you know it — that is the intended path and it skips inference entirely. Without a declaration, `risk` and `domain` carry the decision (`medium` risk plus a `backend`/`systems`/`algorithm` domain is already medium), and size signals (acceptance count, verification count, constraint count, `tool-use`) only contribute up to +2, so a long, carefully written contract no longer routes itself to the expensive model while a vague one routes to the cheapest. The score maps to `low` (<2), `medium` (2-4), or `high` (>=5); `routing.difficultySource` reports `explicit` or `inferred`.

Verification-defining paths are locked by default (`alwaysLockedPaths` in config: CI workflows, test-runner config, Playwright/Cypress config, pytest/tox config), and `package.json` keys that decide how the harness runs (`scripts`, `jest`, `vitest`, `mocha`, `ava`, `nyc`, `c8`, `workspaces`, `packageManager`) are frozen while dependencies stay editable. Put parent-authored acceptance tests in the contract's `lockedPaths` so the worker cannot rewrite the assertion it is graded by.

To override auto-selection, pass `--profile <name>` to `doctor`/`prepare`. To disable auto-selection entirely, leave `costTier` off your profiles; the skill then falls back to `defaultProfile`.

**Personal preference first.** If the user's config sets `callerProfiles[<caller>]` (e.g. `"claude-code": "qoder-qwen-flash"`), `prepare` starts from that profile — with its own `fallbackProfiles` chain — before difficulty routing; `--profile` still overrides it. Parent agents should therefore **not** hardcode a profile name taken from project instructions: export `PARENT_AGENT`, omit `--profile`, and let the user's machine-local preference decide. Run `spot doctor` (no `--profile`) to see `profileSource` and the chain.

Ten profiles ship in `fixtures/default-config.json` covering the Pi-backed providers — `volcengine` (standard), `deepseek` (cheap), `kimi` (standard), `minimax-m3` (premium), `gemini-vision` (premium, vision modality), `gpt-image` (premium, image-output modality) — plus five alternate-CLI profiles: `zcode` (Zhipu/Z.ai open workbench CLI; OAuth shared with the desktop app, free-trial tokens, headless `-p --json` with real token usage; model = the TUI's persisted defaultModelSelection — no `--model` flag in 0.17), `kimi-cli` (Kimi Code CLI adapter), `trae-cli` (Trae CLI adapter, OAuth login), `qoder-cli` (Qoder **CN** CLI adapter — binary `qoderclicn`, installed via `curl -fsSL https://qoder.com.cn/install | bash`; authenticate with a Personal Access Token from the qoder.cn account integrations page exported as `QODERCN_PERSONAL_ACCESS_TOKEN`. Ships with `model: free`, which resolves at dispatch time to the cheapest model the account can currently reach. Pricing comes from `GET https://api.qoder.com.cn/api/v1/cloud/models` (cached 30 min in `~/.cache/pi-worker/qoder-models.json`), not from `--list-models`, which prints a bare name column. Observed roster and multipliers: `DeepSeek-Flash` 0x, `Qwen3.8-Flash` 0x, `GLM-5.3-Flash` / `MiniMax-M3.1-Flash` / `Qwen3.7-Plus` 0.1x, `Auto` / `Qwen3.8-Max` / `DeepSeek-V4-Pro` 0.5x, `Fast` / `GLM-5.3` / `Kimi-K2.8-Preview` 0.8x, `Kimi-K3` 1.4x — but never hardcode this; the roster changes weekly (`spot detect` prints the live table). The catalog also carries per-model `efforts` and `available_context_windows`, so `reasoningEffort` / `maxContextSize` are validated against the pinned model and snapped to a legal neighbour instead of failing the run (the adjustment is recorded as a `worker_warning` event). PITFALL: the CN build silently ignores the international `QODER_PERSONAL_ACCESS_TOKEN` and stays at "Not logged in"; without `-p/--print` it opens an interactive TUI that hangs the worker; and it reports all `usage.*_tokens` as 0, billing in `total_credits` instead), and `codebuddy-cli` (CodeBuddy Code CLI, `npm i -g @tencent-ai/codebuddy-code`, default model `deepseek-v4.1-flash`; OAuth login via `codebuddy` → `/login`; the headless copy bundled in WorkBuddy.app cannot log in and is not used; no `costTier`, so it is only used with `--profile codebuddy-cli`; an unauthenticated run exits 0, which the adapter classifies as `auth`). Add or edit profiles in `~/.config/pi-worker/config.json`; each profile may set `costTier: cheap | standard | premium`, `strengths: string[]`, and `modalities: string[]`. The `apiKeyEnv` field in `~/.config/pi-worker/config.json` and the `$VAR` reference in `~/.pi/agent/models.json` must point to the same environment variable name — `spot doctor` detects mismatches and suggests the correct name.

## Environment detection & interactive worker picker

At startup (and whenever you need a fresh view), run `spot detect`. It probes every known worker CLI on this machine — `pi`, `kimi`, `trae`, `qoder`, `opencode` — records whether each is installed and, for adapters that can enumerate models, the full model list. Qoder's rows carry the live price multiplier and the per-model context/effort tiers, so "which of these is free?" is answerable from this table alone. Results are cached to `~/.cache/pi-worker/registry.json` for 10 minutes so dispatch stays cheap and a parent agent can read the cache to learn what's available here. OpenCode is also discovered via `~/.opencode/bin/opencode` even when it isn't on `PATH`.

```
spot detect
# → Detected environment (spot worker CLIs):
#     pi         v0.82.1  0 model(s)
#     qoder      v1.1.73  12 model(s)  (2 free)
#         - DeepSeek-Flash  [free] ctx 200K/400K/1M effort low|high|max
#         - Qwen3.8-Flash  [free] ctx 200K/400K/1M effort low|medium|xhigh
#         - GLM-5.3-Flash  [0.1x] ctx 200K/400K/1M effort high|max
#         ...
#         - Kimi-K3  [1.4x] ctx 200K/400K/1M effort low|high|max
#     opencode   v1.18.21  7 model(s)
#         - opencode/hy3-free
#         - opencode/mimo-v2.5-free
#         ...
```

Qoder accepts a price alias as a model name: `--model free` (also `qoder-free`, `cheapest`) pins whichever model currently has `price_factor: 0`, so a profile never has to name a model that may be delisted next week.

When a human dispatches a task interactively (a TTY, no `PARENT_AGENT`/`PI_WORKER_CALLER` driving spotworkers headlessly) and gives **no** explicit `--profile`/`--model`, `prepare` runs `detect`, shows the merged CLI+model table, and asks which one to use:

```
spot prepare --task TASK.json
# → Available worker CLIs and models:
#   * 1. opencode  opencode/hy3-free [free]
#     2. opencode  opencode/nemotron-3.5-lightning-free [free]
#     3. pi       MiniMax-M3 [premium]
#     ...
#   Select worker [1-15] (Enter = opencode opencode/hy3-free):
```

The table merges detected models (the full opencode list, etc.) with configured profiles, and drops any CLI that detection found not installed. Explicit flags or a parent agent skip the prompt and keep the existing auto-routing / `--profile` / `--model` behavior. Pass `--select-worker true` to force the prompt even under a parent agent, or `--select-model true` for the model-only variant. A parent agent that wants to drive dispatch should read `registry.json` (or `spot detect`) and pass `--profile`/`--model` explicitly so the CLI+model choice is made once, not per task.

## Route first

Delegate bounded features, bug fixes, tests, and mechanical refactors with deterministic checks and a narrow path allowlist.

Work directly in the parent agent when the task is trivial, architectural, high-risk (security/auth/production infrastructure/irreversible migration), or lacks reliable verification. Visual work — screenshots, layout polish, sprite/audio assets, "make it look right" — stays in the parent: the worker pipeline carries text only, and `vision-input` / `image-output` merely gate routing; nothing attaches an image to a worker turn. If a task's acceptance is visual or binary, report that it is out of scope instead of delegating it. For direct tasks, continue with the normal parent-agent workflow: implement, verify, inspect the actual diff, auto-commit only when the source is safe, and never push.

Before choosing to delegate, check `references/scope.md` — it lists the four conditions a task must satisfy, the hard limits with the constant that enforces each, and a fit table by task type (including game work).

Every delegated run requires a Git repository. In a non-Git project, stay in the parent agent, verify directly, and state that automatic commit is unavailable.

## Closed loop

Run `spot` from `PATH` (installed via `npm install -g spotworkers`; the `pi-worker` alias works too). If it is not on `PATH`, call the bundled entrypoint with `node <this-skill-directory>/scripts/spot.mjs` — in a checkout or this skill dir that is `node scripts/spot.mjs`.

1. Confirm the Git root, choose a unique run ID, and immediately run `parent-meter.mjs --output /tmp/pi-worker-ID-parent-start.json` before detailed planning. (`codex-meter.mjs` remains as a deprecated alias if your workflow already calls it.)
2. Read project instructions; record HEAD and dirty status; define exact allowed/forbidden/locked paths, acceptance criteria, and argv-form verification. Prefer declaring `difficulty` explicitly. Create a task JSON matching `schemas/task-contract.schema.json`. Create temporary JSON files with `apply_patch`, never shell redirection.
3. Run `doctor --task TASK` (auto-selects a profile by difficulty unless `--profile` is given), then `prepare --task TASK --usage-start START` (the legacy `--codex-start` flag still works), then `run --id ID`. A setup/credential failure is a real blocker; report it without weakening isolation.
4. Run `verify --id ID`. When `selfReview.enabled=true` (default), verify advances to `selfReviewing` instead of `reviewing`; otherwise it goes straight to `reviewing`. Read `verification.json` and `references/review-policy.md`. Pi's summary and test claims are not evidence.
5. **Self-review (token saver, default on).** If state is `selfReviewing`, call `self-review --id ID`. Pi re-reads its own diff with `read`/`grep` tools (still no shell) and emits a structured `self-review.json` matching `schemas/self-review.schema.json`: per-criterion status (`met`/`uncertain`/`unmet`), self-reported findings, and a `diffSha256` it must echo. The command writes the report and advances to `reviewing`. Then apply `references/review-policy.md`: pick Tier A / B / C from the report's signals and follow only that tier — at Tier A you read `self-review.json` (~50 lines) plus the diff hunks you spot-check, **not** every changed file. Spot-check at least `spotCheckRequired` (default: max of `spotCheckCount`, 34% of `met`, and every `uncertain`). If `diffSha256Mismatch=true`, `fallbackRecommended=true`, or any P0-P2 self-finding appears, escalate to Tier C (full diff, every changed file). The command self-degrades to `reviewing` with `skipped:true` on Pi failure, parse failure, `diff-too-small` (below `selfReview.minDiffBytes`, default 500), or `review-surface-too-small` (diff + changed-file bytes below `selfReview.minSurfaceBytes`, default 4000 — a report on a small diff costs more than the diff, see `docs`/CHANGELOG) — never blocks the run. `selfReview.spotCheckRatio` tunes the proportional spot-check; `selfReview.enabled=false` skips the phase entirely. You may also skip ad-hoc by calling `approve`/`revise` directly from `selfReviewing` (the command will transition through `reviewing` for you).
6. If verification or parent review has a P0-P2 finding or verification gap, write `verdict: revise` matching `schemas/review-result.schema.json`, call `revise`, and return to step 4. Allow at most two revision turns. Then stop without commit if any gate still fails.
7. When every gate passes, write `verdict: approve`. Call `approve` immediately without asking the user, then `integrate`. A dirty or changed source must remain on the worker branch and report `blocked`; never stash, reset, checkout, or mix user changes.
8. For every created run, call `report`; pass `--chatgpt-image-generations N` when the same user task used ChatGPT web for images. If `doctor` fails before `prepare`, report that setup blocker directly because no run exists. Call `cleanup` only after successful integration and report persistence. Preserve failed/blocked worktrees and logs.

If a parent thread resumes after interruption, read the persisted `state.json` and reissue only the command corresponding to its current state. `run` and `revise` consume their Pi-turn receipt or terminal event evidence; never restart the entire workflow or recreate an existing run. If an active phase was interrupted and the lock owner is gone, call `spot recover --id <run-id>` first: a partial worktree is sent to `verify`, while an empty worktree is sent back to `run`/`revise`. A live lock is never stolen.

## Self-review (parent token saver)

`verify` no longer goes straight to `reviewing` when `selfReview.enabled=true` (the default). It parks the run in `selfReviewing` so the parent agent can decide whether to spend a tiny Pi turn to pre-digest the diff.

- **What Pi does.** A second turn with `mode=self-review`, the same profile as the implementation, and the same `read,grep,find,ls` tools (no `edit`/`write`/shell). The report is a hint about where to look, not a verdict about correctness — the parent still owns the verdict. It receives the task contract including `lockedPaths`, the **independent verification result** (so it cannot lie about tests), the changed-files list, the diff stat, and the `diffSha256` it must echo. It returns a single JSON object matching `schemas/self-review.schema.json`.
- **What the parent reads.** Per `references/review-policy.md`: at Tier A, `self-review.json` (~50 lines) plus the diff hunks for the criteria you spot-check, instead of the full diff (~thousands of lines). Token reduction is typically 5-10x for medium diffs.
- **Anti-cheat.** (1) `verification.json` is still produced by the wrapper, not Pi. (2) `diffSha256Mismatch=true` if Pi echoes the wrong hash → Tier C. (3) `fallbackRecommended=true` when Pi self-reports `unmet`/`uncertain` or any P0-P2 finding → Tier C. (4) `approve` still re-scans the diff and rejects if `diffSha256` changed. (5) High-risk tasks never reach this stage (`HIGH_RISK_BLOCKED`). By design the reviewer is the implementation model: parent agents do not fetch a second model to grade their own work either, so the honest signal comes from above it — wrapper-run verification, locked paths, and the diff hash.
- **Failure modes.** Worker failure, JSON parse failure, diff below `selfReview.minDiffBytes` (default 500), or review surface below `selfReview.minSurfaceBytes` (default 4000) → command writes `selfReviewSkipped:true` with a `reason` and still advances to `reviewing`. Self-review never blocks the closed loop.
- **Disabling.** Set `selfReview.enabled=false` in `~/.config/pi-worker/config.json` (or per-profile override). `verify` then behaves as before: `verifying → reviewing`.

## Hard gates

- Require wrapper verification success, unchanged diff hash, passed security scan, acceptance evidence, and zero unresolved P0, P1, or P2 findings.
- Treat `LOCKED_PATH_CHANGED` and `VERIFICATION_SCRIPT_CHANGED` as terminal: the worker edited the harness that grades it. Never approve "because the tests still pass".
- Never enable Pi Bash, extensions, Skills, prompt templates, context files, or project auto-trust.
- Never push, create a PR, change remotes, or describe worktree isolation as an OS sandbox.
- Do not route around authentication errors or capability mismatches with a fallback.

## Monitoring

The worker persists every run under `~/.local/state/pi-worker/runs/<run-id>/` (state.json, pi-events.jsonl, metrics.json, report.md). Query it without touching the worker:

- `spot list [--status <status>] [--caller <caller>] [--running]` — JSON array of runs. `--running` filters to active states (prepared/running/verifying/reviewing/revising).

## Live worker monitoring (tmux)

Every `run`/`revise` writes a **human-readable** stream to `~/.local/state/pi-worker/runs/<run-id>/worker.log` (one line per worker event: assistant text, tool calls/results, token totals — no raw JSON). The parent-agent auto-loop is unaffected; this is purely an observability companion.

To watch many CLI workers concurrently (e.g. several OpenCode dispatches at once), use the bundled tmux monitor:

```
scripts/pi-tmux-monitor            # open a tmux session with one pane per active run, tail -f its worker.log
scripts/pi-tmux-monitor --list     # print the runs it would monitor
scripts/pi-tmux-monitor --kill     # tear down the session
```

It auto-discovers active runs (state `status` ∈ prepared/running/verifying/selfReviewing/reviewing/revising, or a fresh `worker.log` with no state yet), opens one pane each via `tmux split-window` + `tiled` layout, and attaches. Re-running attaches to the existing session instead of rebuilding. Requires `tmux` (`brew install tmux`). For a single run you can also just `tail -f ~/.local/state/pi-worker/runs/<run-id>/worker.log` in any terminal.

To review a finished OpenCode conversation inside the OpenCode client itself: `opencode session` lists sessions, `opencode export <id>` dumps the full transcript as JSON. Note `opencode run` (headless, used by spotworkers) may not always register an interactive session — the `worker.log` is the authoritative per-run transcript either way.

## Parallel execution

Multiple parent-agent sessions (e.g. one Codex + one Claude Code, or several Trae windows) can run spot concurrently. Each run gets an isolated Git worktree, state directory, and per-run file lock (`~/.local/state/pi-worker/runs/<id>/state.lock`), so different runs never collide and the same run is never advanced by two processes at once. `list --running` shows active runs; the dashboard reads state.json with JSON-parse tolerance so a snapshot never crashes on a concurrent write.

The `maxConcurrentRuns` config (default 4, range 1-16) caps how many runs may be in an active state simultaneously; `prepare` rejects with `CONCURRENCY_LIMIT` when the cap is hit. Tune it to match your API rate limits and local resources. Pi itself is stateless across sessions (each `spot run` spawns its own Pi process), so there is no global Pi lock.
- `spot inspect --id <run-id>` — full state, metrics, verification, review, and Pi usage totals.
- `spot dashboard [--output <file>]` — single-page HTML dashboard (summary cards + run table + expandable detail rows, filterable by caller and status). The generated HTML is a snapshot; rerun the command to refresh.
- `spot serve [--port <port>] [--no-open]` — start a live HTTP dashboard at `http://localhost:<port>/` (default port 7317). The page exposes a "Refresh" button (per panel, at the top) that fetches `/api/fragment` and replaces the dashboard body in place, plus an **Auto-refresh (60s)** toggle (persisted in localStorage) that polls every 60s and also refreshes when the tab regains focus/visibility — a cheap alternative to a full browser reload (F5). Routes: `GET /` (HTML), `GET /api/fragment` (rendered HTML fragment for refresh), `GET /api/runs` (raw JSON of state + metrics), `GET /api/connections` (adapter + profile status), `GET /health`. Ctrl+C to stop. Use this for real-time monitoring; do **not** rely on `file://`-opened `dashboard.html` for fresh data.

`prepare` records the invoking caller into `state.caller` from `PARENT_AGENT` / `PI_WORKER_CALLER` (`trae`, `codex`, `claude-code`, `cursor`, `pi-recursive`, `workbuddy`, `cli`; anything else becomes `unknown`). Set it in the environment that invokes `spot prepare` so the dashboard can distinguish traffic sources.

## Final response

Report implementation, exact verification, parent verdict, revision count, commit/branch, integration status, and — as the headline number — **main-model tokens avoided** from `report` (`parentSavings.estimatedTokensAvoided`, with the saving ratio and the counterfactual basis). Then the worker's own usage and cost, and "not pushed." The point of the loop is that the worker side is free, discounted, or far cheaper per token, so the parent-side saving is the number that matters; a credit-based figure is only meaningful when the parent backend has a rate card. The user needs no code-review action. Mention only blockers that require credentials, authority, or safe integration.

Read `references/provider-configuration.md` only for setup/provider changes. Read `references/credentials.md` when a credential is missing, when adding a provider, or when the user asks where a token goes (one env var per profile; `~/.config/pi-worker/credentials.env` sourced from `~/.zshenv`, never `config.json`). Read `references/review-policy.md` for every delegated review.
