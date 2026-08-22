# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
