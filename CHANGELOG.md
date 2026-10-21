# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Qoder price-aware model catalog** (`lib/qoder-catalog.mjs`). `--list-models` only prints a name column, so the adapter now reads `GET https://api.qoder.com.cn/api/v1/cloud/models` (Bearer PAT), which returns `price_factor`, `efforts`, `available_context_windows` and `max_input_tokens` per model. Cached to `~/.cache/pi-worker/qoder-models.json` for 30 minutes behind a schema version; `sanitizeHome` refreshes it, `invokeCommand` reads it synchronously, and any failure (no token, offline, bad payload) degrades to "no catalog" instead of failing the run.
- **`model: "free"` alias** (also `qoder-free`, `cheapest`): resolves at dispatch time to the lowest `price_factor` model the account can reach, so a profile never hardcodes a model that may be delisted. Ties break on context size then name, so the choice is stable across runs. `qoder-cli` now ships with `model: "free"` and `costTier: "free"`.
- **Per-model capability validation**: `reasoningEffort` and `maxContextSize` are checked against the pinned model's published tiers. An unsupported effort is snapped to its nearest legal neighbour (`DeepSeek-Flash` accepts `low|high|max`, `Qwen3.8-Flash` accepts `low|medium|xhigh`); an off-tier context window is rounded **down** to the largest published tier that still satisfies the request. The adapter returns `warnings[]` and the runner records each as a `worker_warning` event plus a `[warn]` line in `worker.log` — adjustments are visible, never silent.
- `pi-worker detect` now shows Qoder's live pricing: `12 model(s)  (2 free)` followed by per-model `[free]` / `[0.1x]` / `[1.4x]`, context tiers and legal effort levels.
- `doctor --profile qoder-cli` validates the selected model against the catalog (rejecting a name the account cannot reach, listing the priced roster) and reports the multiplier plus any effort/window snap for the configured values.
- Adapters may now return a pre-resolved `{ models }` roster from `listModels()` instead of an `{ argv, parse }` spec; `detectEnvironment` and `doctor` accept both shapes. `detectEnvironment` also fills a missing adapter credential from the shell profile, so a GUI-launched `detect` no longer reports `0 model(s)` for Qoder.

### Fixed
- Qoder adapter (`qoderclicn`) now runs genuinely headless: `-p/--print` is passed explicitly. Without it the CN build defaults to the interactive TUI and the worker hangs until the runner timeout. The obsolete positional `-` stdin marker was dropped (with `-p` the CLI reads the prompt from stdin on its own).
- Qoder adapter parses the json `result` object's usage block (`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` / `total_cost_usd` / `num_turns`), so token and duration metrics are recorded instead of degrading to `null`. `supportsTokenUsage` is now `true` for this adapter.
- Qoder auth failures are classified as `auth`: a rejected `QODERCN_PERSONAL_ACCESS_TOKEN` surfaces as `QoderAuthError` on stderr with **empty stdout**, which the base classifier previously reported as `permanent`.
- Documented that the CN build ignores the international `QODER_PERSONAL_ACCESS_TOKEN` variable; only `QODERCN_PERSONAL_ACCESS_TOKEN` is read and validated.
- `lastAssistant.usage` from the Qoder adapter is now emitted in the **raw** Pi shape (`input` / `output` / `cacheRead` / `cacheWrite` / `cost.total`). `normalizeUsage()` reads those keys, so passing the already-normalized `inputTokens` shape zeroed every counter in the `message_end` event (tokens showed as `0` while only `totalTokens` survived).
- Failed runs now expose the adapter failure class: `category` (`auth` / `transient` / `timeout` / `permanent`) was stripped by `redactDiagnostic`, so a `PI_FAILED` result gave no way to tell "never authenticated" apart from "wrote bad code".
- `doctor`'s model check no longer claims Qoder has no `--list-models` command (it has one, but it needs a live login); the note now covers both cases.

### Added
- Qoder adapter honours **thinking depth** (`--reasoning-effort`: `auto|none|low|medium|high|xhigh|max|ultracode`, where `xhigh` is "extra high") and **context window** (`--context-window <tokens>`, `1000000` = 1M). Configure per profile (`reasoningEffort`, `maxContextSize`) or per run via `PI_WORKER_QODER_REASONING_EFFORT` / `PI_WORKER_QODER_CONTEXT_WINDOW`. Verified: with the same prompt the reported `context_usage_ratio` falls from `0.117` to `0.024` once the window is set to 1M.
- `reasoningEffort` is now an accepted profile extension field (validated as string/number like `maxContextSize`).
- Qoder adapter supports **model pinning**: `profile.model` is forwarded as `-m/--model <name>`, so `pi-worker prepare --model Qwen3.8-Flash` (or a pinned `model` in `~/.config/pi-worker/config.json`) actually reaches the CLI. The `qoder-default` placeholder is skipped so an unpinned run keeps the CLI's own default (`Auto`). Verified end to end: the run event reports `model: Qwen3.8-Flash` and `modelUsage` in the raw payload switches from `auto` to the Qwen-specific id.
- Qoder adapter implements `listModels()` over `--list-models` (works once authenticated), so `pi-worker detect` now enumerates all 15 models — `Auto`, `Fast`, `Qwen3.8-Max`/`Flash`, `Qwen3.7-*`, `DeepSeek-V4-Pro`, `DeepSeek-Flash`, `GLM-5.3*`, `Kimi-K3`, `MiniMax-M3.1-Flash` — and the interactive model picker can offer them.
- Provider-native **credits** are captured end to end. Qoder CN reports every `usage.*_tokens` counter as `0` and bills in `total_credits` (verified: a trivial run returns `input_tokens: 0, output_tokens: 0, total_credits: 1.455`), so a token-only emptiness check discarded the one number the provider actually measures. `totalCredits` now flows adapter → `message_end` → `readPiUsage` → `report.md` as its own field, deliberately not folded into `providerReportedCostUsd` (a credit is not a dollar).
- `references/credentials.md`: a single place documenting where credentials go (one env var per profile), the full profile→variable map, adapter exceptions (Qoder CN-named token, Trae/CodeBuddy OAuth, OpenCode free tier), rotation, and the rules that keep secrets out of `config.json`, argv and generated artifacts.
- `lib/shell-profile.mjs` now scans `~/.config/pi-worker/credentials.env` first, then `.zshenv` / `.zprofile`, before the previous `.zshrc` / `.bash_profile` / `.bashrc` / `.profile` order. A token exported only in `.zshrc` is invisible to GUI-launched and non-interactive (`ssh host 'cmd'`, CI, cron) processes — the "works in my terminal but doctor says it is missing" trap.
- Credential hints now point at `~/.config/pi-worker/credentials.env` instead of `source ~/.zshrc`, in `doctor`, `prepare` and `run`.
- `pi-worker detect` command: probes every known worker CLI (`pi`/`kimi`/`trae`/`qoder`/`opencode`) for install status + model list, caches the result to `~/.cache/pi-worker/registry.json` (10-minute freshness) for cheap repeated dispatch and parent-agent introspection.
- Interactive CLI+model chooser in `prepare`: when a human is at a TTY (no `PARENT_AGENT`/`PI_WORKER_CALLER`) and gives no `--profile`/`--model`, detection runs and the user confirms which CLI + model to dispatch with. Force it with `--select-worker true` / `--select-model true`.
- OpenCode discovery via `~/.opencode/bin/opencode` candidate bin, so OpenCode is found even when it isn't on `PATH`. `doctor` and `detect` both use candidate-aware bin resolution.
- `doctor` now appends a non-fatal `environment` block listing every installed CLI and its model count.

### Changed
- Removed the opencode-only TTY model picker from `git-worker.mjs`; unified by the new chooser in `lib/environment.mjs`.
- `free` cost tier is now a valid config tier (profiles can be opted into via `--profile` or used as fallback targets).
- Token/duration usage now captured for **every** adapter (Pi, OpenCode, Kimi, Trae, Qoder), not just Pi: non-streaming adapters echo a `message_end` usage event into `pi-events.jsonl` so `readPiUsage` aggregates them uniformly. The dashboard "Token" / "duration" columns now reflect real per-connector numbers.
- Dashboard labels are adapter-agnostic: "Pi Token" → "Token", "Pi duration" → "duration", "Pi call count" → "call count", "Pi-side balance" → "balance", and the per-run detail block is labeled "usage".
- `workbuddy` is a recognised caller/source (Source column + filter + badge). It is auto-detected via the `WORKBUDDY` / `WORKBUDDY_AGENT` env var, or set explicitly with `PARENT_AGENT=workbuddy`.
- Live dashboard adds an **Auto-refresh (60s)** toggle (persisted in localStorage) that polls `/api/fragment` + `/api/connections` every 60s and refreshes on tab focus/visibility; the per-panel "Refresh" button remains for manual in-place refresh without a full browser reload.

### Added
- Per-run human-readable `worker.log` (`~/.local/state/pi-worker/runs/<run-id>/worker.log`): each `run`/`revise` tees NDJSON worker events into readable text (assistant text, tool calls/results, token totals). Does not affect the headless auto-loop.
- `scripts/pi-tmux-monitor`: tmux session with one pane per active run, each `tail -f`-ing its `worker.log`, for concurrent live monitoring of many CLI workers.

## [0.1.0] - 2026-07-25

First public release. Closed-loop delegation to Pi CLI with isolation, independent verification, parent review, self-review (token saver), live monitoring dashboard, multi-parent dispatch, difficulty-based model selection, and multi-CLI adapter support (Pi / Kimi / Trae / Qoder).

### Added
- AGPL-3.0-or-later license (migrated from MIT).
- Bilingual README: English (`README.md`) + Simplified Chinese (`README.zh-CN.md`) with language switcher.
- GitHub community files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md`.
- Issue templates (bug report, feature request) and pull request template.
- CI workflow (`.github/workflows/ci.yml`) running syntax check + full test suite on push and PR.
- Copyright headers on all `.mjs` source files.
- Expanded README: "Install Pi CLI", "Integrating with parent agents" (Codex / Claude Code / Trae / Cursor / Pi), and "Configuring models" sections.
- Expanded "Features" section documenting anti-cheat self-review, hard gates, crash-safe recovery, parallel execution, multi-CLI adapters, and cost/savings metrics.

### Changed
- Translated all remaining Chinese (comments, strings, dashboard UI, CLI output, test assertions) to English.
- Fixed dashboard footer/alert text containing leftover CJK punctuation.
- Dashboard filter `<select>` elements now inherit `color: var(--text)` so they are visible in dark mode.
- Expanded `.gitignore` to cover pi-worker runtime state/cache, OS files, IDE folders, and secrets.

[Unreleased]: https://github.com/hLxiao9/pi-delegate/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hLxiao9/pi-delegate/releases/tag/v0.1.0
