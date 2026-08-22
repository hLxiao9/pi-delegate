---
name: pi-delegate
description: Use when a user explicitly invokes $pi-delegate, asks the parent agent to delegate a bounded code implementation to Pi CLI / Kimi Code CLI / Trae CLI / Qoder CLI or a cheaper coding model, or requests unattended coding completion across projects. Supports multiple CLI backends via the adapter system (pi/kimi/trae/qoder).
---

# Pi Delegate

## Core principle

Keep architecture, acceptance criteria, independent verification, review, and commit authority with the parent agent (Codex / Claude Code / Trae / Cursor / another Pi). Treat Pi as an untrusted implementation worker. Do not ask the user to review code.

## Multi-parent dispatch

The skill is parent-agnostic. Set `PARENT_AGENT` (and, when applicable, `PARENT_THREAD_ID`) in the environment that invokes `pi-worker prepare` so usage tracking and dashboard traffic source are routed correctly:

| `PARENT_AGENT` | Usage backend | Notes |
|---|---|---|
| `codex` (default) | `~/.codex/sessions/` rollout JSONL | Reads `CODEX_THREAD_ID` (or `PARENT_THREAD_ID`). |
| `claude-code` | `~/.claude/projects/` session JSONL | Requires `PARENT_THREAD_ID`. |
| `trae` | not yet implemented | Reports `available:false`; set `PARENT_AGENT=codex` or `claude-code` if you need usage numbers. |
| `cursor` | not yet implemented | Same as `trae`. |
| `pi-recursive` | not yet implemented | Use when one Pi delegates to another Pi; usage stays on the outer Pi. |
| `cli` | none | For ad-hoc shell invocations with no parent session to meter. |

The `prepare` command records the resolved caller into `state.caller` (one of `trae`, `codex`, `claude-code`, `cursor`, `pi-recursive`, `cli`, `unknown`). The dashboard groups runs by caller. `list --caller <name>` filters accordingly.

## Automatic model selection by difficulty

The skill auto-selects a Pi profile whose `costTier` matches the inferred task difficulty:

| Difficulty | `costTier` | Typical model class |
|---|---|---|
| `low` | `cheap` | DeepSeek, Qwen-Flash, small open models |
| `medium` | `standard` | Volcengine ark-code, Kimi, GLM, MiniMax-M2.7 |
| `high` | `premium` | MiniMax-M3, Claude Opus via Pi, frontier models |

Difficulty is inferred by `lib/difficulty.mjs` from task signals: goal length, acceptance-criteria count, risk level, constraint count, required capabilities, verification count, and path allow/forbid breadth. The score maps to `low` (<2), `medium` (2-4), or `high` (>=5).

To override auto-selection, pass `--profile <name>` to `doctor`/`prepare`. To disable auto-selection entirely, leave `costTier` off your profiles; the skill then falls back to `defaultProfile`.

Nine profiles ship in `fixtures/default-config.json` covering the Pi-backed providers — `volcengine` (standard), `deepseek` (cheap), `kimi` (standard), `minimax-m3` (premium), `gemini-vision` (premium, vision modality), `gpt-image` (premium, image-output modality) — plus three alternate-CLI profiles: `kimi-cli` (Kimi Code CLI adapter), `trae-cli` (Trae CLI adapter, OAuth login), and `qoder-cli` (Qoder CLI adapter). Add or edit profiles in `~/.config/pi-worker/config.json`; each profile may set `costTier: cheap | standard | premium`, `strengths: string[]`, and `modalities: string[]`. The `apiKeyEnv` field in `~/.config/pi-worker/config.json` and the `$VAR` reference in `~/.pi/agent/models.json` must point to the same environment variable name — `pi-worker doctor` detects mismatches and suggests the correct name.

## Environment detection & interactive worker picker

At startup (and whenever you need a fresh view), run `pi-worker detect`. It probes every known worker CLI on this machine — `pi`, `kimi`, `trae`, `qoder`, `opencode` — records whether each is installed and, for adapters that can enumerate models (`pi`, `opencode`), the full model list. Results are cached to `~/.cache/pi-worker/registry.json` for 10 minutes so dispatch stays cheap and a parent agent can read the cache to learn what's available here. OpenCode is also discovered via `~/.opencode/bin/opencode` even when it isn't on `PATH`.

```
pi-worker detect
# → Detected environment (pi-worker worker CLIs):
#     pi         v0.82.1  0 model(s)
#     opencode   v1.18.21  7 model(s)
#         - opencode/hy3-free
#         - opencode/mimo-v2.5-free
#         - opencode/nemotron-3.5-lightning-free
#         ...
```

When a human dispatches a task interactively (a TTY, no `PARENT_AGENT`/`PI_WORKER_CALLER` driving pi-delegate headlessly) and gives **no** explicit `--profile`/`--model`, `prepare` runs `detect`, shows the merged CLI+model table, and asks which one to use:

```
pi-worker prepare --task TASK.json
# → Available worker CLIs and models:
#   * 1. opencode  opencode/hy3-free [free]
#     2. opencode  opencode/nemotron-3.5-lightning-free [free]
#     3. pi       MiniMax-M3 [premium]
#     ...
#   Select worker [1-15] (Enter = opencode opencode/hy3-free):
```

The table merges detected models (the full opencode list, etc.) with configured profiles, and drops any CLI that detection found not installed. Explicit flags or a parent agent skip the prompt and keep the existing auto-routing / `--profile` / `--model` behavior. Pass `--select-worker true` to force the prompt even under a parent agent, or `--select-model true` for the model-only variant. A parent agent that wants to drive dispatch should read `registry.json` (or `pi-worker detect`) and pass `--profile`/`--model` explicitly so the CLI+model choice is made once, not per task.

## Route first

Delegate bounded features, bug fixes, tests, and mechanical refactors with deterministic checks and a narrow path allowlist.

Work directly in the parent agent when the task is trivial, architectural, high-risk (security/auth/production infrastructure/irreversible migration), or lacks reliable verification. Visual/image tasks are delegated to Pi when a profile advertising the matching `modalities` (`vision` for `vision-input`, `image-output` for `image-output`) is configured; if no such profile exists, report a setup blocker instead of falling back. For direct tasks, continue with the normal parent-agent workflow: implement, verify, inspect the actual diff, auto-commit only when the source is safe, and never push.

The Pi worker requires a Git repository. In a non-Git project, stay in the parent agent, verify directly, and state that automatic commit is unavailable.

## Closed loop

Use `/Users/xiao9/.agents/skills/pi-delegate/scripts/pi-worker.mjs`; run it with `node`.

1. Confirm the Git root, choose a unique run ID, and immediately run `parent-meter.mjs --output /tmp/pi-worker-ID-parent-start.json` before detailed planning. (`codex-meter.mjs` remains as a deprecated alias if your workflow already calls it.)
2. Read project instructions; record HEAD and dirty status; define exact allowed/forbidden paths, acceptance criteria, and argv-form verification. Create a task JSON matching `schemas/task-contract.schema.json`. Create temporary JSON files with `apply_patch`, never shell redirection.
3. Run `doctor --task TASK` (auto-selects a profile by difficulty unless `--profile` is given), then `prepare --task TASK --usage-start START` (the legacy `--codex-start` flag still works), then `run --id ID`. A setup/credential failure is a real blocker; report it without weakening isolation.
4. Run `verify --id ID`. When `selfReview.enabled=true` (default), verify advances to `selfReviewing` instead of `reviewing`; otherwise it goes straight to `reviewing`. Read `verification.json` and `references/review-policy.md`. Pi's summary and test claims are not evidence.
5. **Self-review (token saver, default on).** If state is `selfReviewing`, call `self-review --id ID`. Pi re-reads its own diff with `read`/`grep` tools (still no shell) and emits a structured `self-review.json` matching `schemas/self-review.schema.json`: per-criterion status (`met`/`uncertain`/`unmet`), self-reported findings, and a `diffSha256` it must echo. The command writes the report and advances to `reviewing`. Read `self-review.json` (compact, ~50 lines) instead of the full diff, and spot-check at least `spotCheckCount` (default 1) `met` criteria plus every `uncertain`/`unmet` one. If `diffSha256Mismatch=true`, `fallbackRecommended=true`, or any P0-P2 self-finding appears, fall back to a full-diff review. The command self-degrades to `reviewing` with `skipped:true` on Pi failure, parse failure, or `diff-too-small` (below `selfReview.minDiffBytes`, default 500) — never blocks the run. To skip entirely, set `selfReview.enabled=false` in config; `verify` then goes straight to `reviewing`. You may also skip ad-hoc by calling `approve`/`revise` directly from `selfReviewing` (the command will transition through `reviewing` for you).
6. If verification or parent review has a P0-P2 finding or verification gap, write `verdict: revise` matching `schemas/review-result.schema.json`, call `revise`, and return to step 4. Allow at most two revision turns. Then stop without commit if any gate still fails.
7. When every gate passes, write `verdict: approve`. Call `approve` immediately without asking the user, then `integrate`. A dirty or changed source must remain on the worker branch and report `blocked`; never stash, reset, checkout, or mix user changes.
8. For every created run, call `report`; pass `--chatgpt-image-generations N` when the same user task used ChatGPT web for images. If `doctor` fails before `prepare`, report that setup blocker directly because no run exists. Call `cleanup` only after successful integration and report persistence. Preserve failed/blocked worktrees and logs.

If a parent thread resumes after interruption, read the persisted `state.json` and reissue only the command corresponding to its current state. `run` and `revise` consume their Pi-turn receipt or terminal event evidence; never restart the entire workflow or recreate an existing run. If an active phase was interrupted and the lock owner is gone, call `pi-worker recover --id <run-id>` first: a partial worktree is sent to `verify`, while an empty worktree is sent back to `run`/`revise`. A live lock is never stolen.

## Self-review (parent token saver)

`verify` no longer goes straight to `reviewing` when `selfReview.enabled=true` (the default). It parks the run in `selfReviewing` so the parent agent can decide whether to spend a tiny Pi turn to pre-digest the diff.

- **What Pi does.** A second Pi turn with `mode=self-review`, the same profile, and the same `read,grep,find,ls` tools (no `edit`/`write`/shell). It receives the task contract, the **independent verification result** (so it cannot lie about tests), the changed-files list, the diff stat, and the `diffSha256` it must echo. It returns a single JSON object matching `schemas/self-review.schema.json`.
- **What the parent reads.** `self-review.json` (~50 lines) instead of the full diff (~thousands of lines). Spot-check at least `spotCheckCount` (default 1) `met` criteria plus every `uncertain`/`unmet` one. Token reduction is typically 5-10x for medium diffs.
- **Anti-cheat.** (1) `verification.json` is still produced by the wrapper, not Pi. (2) `diffSha256Mismatch=true` if Pi echoes the wrong hash → parent must do a full review. (3) `fallbackRecommended=true` when Pi self-reports `unmet`/`uncertain` or any P0-P2 finding → parent must do a full review. (4) `approve` still re-scans the diff and rejects if `diffSha256` changed. (5) High-risk tasks never reach this stage (`HIGH_RISK_BLOCKED`).
- **Failure modes.** Pi failure, JSON parse failure, or diff below `selfReview.minDiffBytes` (default 500) → command writes `selfReviewSkipped:true` with a `reason` and still advances to `reviewing`. Self-review never blocks the closed loop.
- **Disabling.** Set `selfReview.enabled=false` in `~/.config/pi-worker/config.json` (or per-profile override). `verify` then behaves as before: `verifying → reviewing`.

## Hard gates

- Require wrapper verification success, unchanged diff hash, passed security scan, acceptance evidence, and zero unresolved P0, P1, or P2 findings.
- Never enable Pi Bash, extensions, Skills, prompt templates, context files, or project auto-trust.
- Never push, create a PR, change remotes, or describe worktree isolation as an OS sandbox.
- Do not route around authentication errors or capability mismatches with a fallback.

## Monitoring

The worker persists every run under `~/.local/state/pi-worker/runs/<run-id>/` (state.json, pi-events.jsonl, metrics.json, report.md). Query it without touching the worker:

- `pi-worker list [--status <status>] [--caller <caller>] [--running]` — JSON array of runs. `--running` filters to active states (prepared/running/verifying/reviewing/revising).

## Live worker monitoring (tmux)

Every `run`/`revise` writes a **human-readable** stream to `~/.local/state/pi-worker/runs/<run-id>/worker.log` (one line per worker event: assistant text, tool calls/results, token totals — no raw JSON). The parent-agent auto-loop is unaffected; this is purely an observability companion.

To watch many CLI workers concurrently (e.g. several OpenCode dispatches at once), use the bundled tmux monitor:

```
scripts/pi-tmux-monitor            # open a tmux session with one pane per active run, tail -f its worker.log
scripts/pi-tmux-monitor --list     # print the runs it would monitor
scripts/pi-tmux-monitor --kill     # tear down the session
```

It auto-discovers active runs (state `status` ∈ prepared/running/verifying/selfReviewing/reviewing/revising, or a fresh `worker.log` with no state yet), opens one pane each via `tmux split-window` + `tiled` layout, and attaches. Re-running attaches to the existing session instead of rebuilding. Requires `tmux` (`brew install tmux`). For a single run you can also just `tail -f ~/.local/state/pi-worker/runs/<run-id>/worker.log` in any terminal.

To review a finished OpenCode conversation inside the OpenCode client itself: `opencode session` lists sessions, `opencode export <id>` dumps the full transcript as JSON. Note `opencode run` (headless, used by pi-delegate) may not always register an interactive session — the `worker.log` is the authoritative per-run transcript either way.

## Parallel execution

Multiple parent-agent sessions (e.g. one Codex + one Claude Code, or several Trae windows) can run pi-worker concurrently. Each run gets an isolated Git worktree, state directory, and per-run file lock (`~/.local/state/pi-worker/runs/<id>/state.lock`), so different runs never collide and the same run is never advanced by two processes at once. `list --running` shows active runs; the dashboard reads state.json with JSON-parse tolerance so a snapshot never crashes on a concurrent write.

The `maxConcurrentRuns` config (default 4, range 1-16) caps how many runs may be in an active state simultaneously; `prepare` rejects with `CONCURRENCY_LIMIT` when the cap is hit. Tune it to match your API rate limits and local resources. Pi itself is stateless across sessions (each `pi-worker run` spawns its own Pi process), so there is no global Pi lock.
- `pi-worker inspect --id <run-id>` — full state, metrics, verification, review, and Pi usage totals.
- `pi-worker dashboard [--output <file>]` — single-page HTML dashboard (summary cards + run table + expandable detail rows, filterable by caller and status). The generated HTML is a snapshot; rerun the command to refresh.
- `pi-worker serve [--port <port>] [--no-open]` — start a live HTTP dashboard at `http://localhost:<port>/` (default port 7317). The page exposes a "Refresh" button that fetches `/api/fragment` and replaces the dashboard body in place; an ordinary browser reload (F5) also re-reads `~/.local/state/pi-worker/runs/`. Routes: `GET /` (HTML), `GET /api/fragment` (rendered HTML fragment for refresh), `GET /api/runs` (raw JSON of state + metrics), `GET /health`. Ctrl+C to stop. Use this for real-time monitoring; do **not** rely on `file://`-opened `dashboard.html` for fresh data.

`prepare` records the invoking caller into `state.caller` from `PARENT_AGENT` / `PI_WORKER_CALLER` (`trae`, `codex`, `claude-code`, `cursor`, `pi-recursive`, `cli`; anything else becomes `unknown`). Set it in the environment that invokes `pi-worker prepare` so the dashboard can distinguish traffic sources.

## Final response

Report implementation, exact verification, parent verdict, revision count, commit/branch, integration status, actual parent-agent credits when available, Pi usage, estimated savings, cash impact, and "not pushed." The user needs no code-review action. Mention only blockers that require credentials, authority, or safe integration.

Read `references/provider-configuration.md` only for setup/provider changes. Read `references/review-policy.md` for every delegated review.
