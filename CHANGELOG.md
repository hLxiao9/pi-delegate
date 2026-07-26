# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [0.1.0] - 2026-07-XX (pre-public)

Initial public release. Closed-loop delegation to Pi CLI with isolation, independent verification, parent review, self-review (token saver), live monitoring dashboard, multi-parent dispatch, difficulty-based model selection, and multi-CLI adapter support (Pi / Kimi / Trae / Qoder).

[Unreleased]: https://github.com/hLxiao9/pi-delegate/compare/HEAD
[0.1.0]: https://github.com/hLxiao9/pi-delegate/releases/tag/v0.1.0
