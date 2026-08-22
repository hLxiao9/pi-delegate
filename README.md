# pi-delegate

> **Save 80%+ on AI coding costs** by delegating bounded implementation tasks to cheap models (Pi / MiniMax / DeepSeek / GLM), while your main agent (Codex / Claude Code / Trae / Cursor) keeps architecture, review, and commit authority.

> Parent-agent-owned Pi implementation worker: delegate bounded code tasks to Pi CLI with isolation, verification, review, and a live monitoring dashboard.

[English](./README.md) | [简体中文](./README.zh-CN.md)

Keep architecture, acceptance criteria, independent verification, review, and commit authority with the **parent agent** (Codex / Claude Code / Trae / Cursor / another Pi). Treat Pi as an untrusted implementation worker. The parent agent never needs the user to review code.

---

## Features

### Closed-loop delegation with independent verification
`doctor → prepare → run → verify → self-review → approve → integrate → report → cleanup`. The wrapper re-runs your verification commands itself (not Pi's claims) and the diff hash is checked at every gate — a changed hash blocks approval.

### Anti-cheat self-review (parent token saver)
Before the parent agent reads the full diff, an optional second Pi turn re-reads its own work and emits a compact `self-review.json` (~50 lines vs thousands). Five anti-cheat safeguards keep it honest:
- `verification.json` is produced by the wrapper, not Pi — Pi cannot lie about test results.
- `diffSha256Mismatch=true` if Pi echoes the wrong hash → parent falls back to full review.
- `fallbackRecommended=true` when Pi self-reports `unmet`/`uncertain` or any P0–P2 finding → parent falls back.
- `approve` re-scans the diff and rejects if the hash changed.
- High-risk tasks never reach self-review (`HIGH_RISK_BLOCKED`).

Self-review never blocks the loop — on Pi failure, parse failure, or diff below `minDiffBytes`, it self-degrades to `reviewing` with `skipped:true`. Disable with `selfReview.enabled=false`.

### Hard gates & security
- Wrapper verification success, unchanged diff hash, passed security scan, acceptance evidence, and **zero unresolved P0–P2 findings** required to approve.
- Pi is treated as untrusted: Bash, extensions, Skills, prompt templates, context files, and project auto-trust are never enabled.
- Never pushes, creates PRs, changes remotes, or describes worktree isolation as an OS sandbox.
- Never routes around authentication errors or capability mismatches with a fallback — a setup/credential failure is a real blocker.

### Crash-safe recovery
Process-group timeouts, SIGINT/SIGTERM cleanup, and stale-lock reclamation. After an interruption, `pi-worker recover --id <run-id>` reopens the run in place: a partial diff goes to `verify`, an empty diff goes back to `run`. A live lock is never stolen — only a lock whose owner process is gone is reclaimed.

### Multi-parent dispatch
Tracks the caller (`trae`, `codex`, `claude-code`, `cursor`, `pi-recursive`, `cli`) via the `PARENT_AGENT` / `PI_WORKER_CALLER` env var, so the dashboard can attribute runs and `list --caller <name>` can filter.

### Parallel execution
Multiple parent-agent sessions can run concurrently — each run gets an isolated Git worktree, state directory, and per-run file lock, so different runs never collide and the same run is never advanced by two processes at once. `maxConcurrentRuns` (default 4, range 1–16) caps active runs; `prepare` rejects with `CONCURRENCY_LIMIT` when the cap is hit. The dashboard reads `state.json` with JSON-parse tolerance, so a snapshot never crashes on a concurrent write.

### Automatic model selection by difficulty
Task signals (goal length, acceptance-criteria count, risk, constraints, required capabilities, verification count, path breadth) map to `low`/`medium`/`high` difficulty, which selects a `cheap`/`standard`/`premium` profile. Within a tier, `task.domain` (or an inferred domain) soft-matches `profile.strengths`. Override with `--profile <name>`; disable auto-selection by leaving `costTier` off your profiles.

### Multi-CLI backends
Beyond the default Pi backend, profiles can set `adapter: kimi | trae | qoder` to drive other coding CLIs (Kimi Code CLI, Trae CLI, Qoder CLI). Cross-adapter fallback works seamlessly. See [`references/provider-configuration.md`](./references/provider-configuration.md).

### Cost & savings metrics
Every run records Pi token usage (input/output/cached), displaced parent-side credits, equivalent parent credits, saving rate, and subscription-allowance portion. The dashboard surfaces mean saving rate across runs and a cohort recommendation. For adapters without token usage (Kimi/Trae/Qoder), metrics degrade gracefully (`saving rate = null`, recommendation = `no-usage-data-available`).

### Live monitoring dashboard
HTTP server with refresh button, summary cards, filterable run table (by caller, status, free text), expandable detail rows, light/dark theme, and a "Connection status" tab showing CLI adapter and profile credential health.

## Prerequisites

- **Node.js** `>=22.19.0`
- **Pi CLI** `>=0.80.10` on `PATH` (or set `PI_WORKER_PI_BIN`)
- **Git** (the worker requires a Git repository)
- Provider credentials in env (e.g. `VOLCENGINE_API_KEY`)

## Install Pi CLI

pi-delegate drives the [Pi CLI](https://github.com/earendil-works/pi) (project page: <https://pi.dev/>), so Pi must be on your `PATH` before you run `pi-worker`. Pi is a separate open-source project — install it independently.

**Option A — npm global (cross-platform)**

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version          # verify; pi-delegate requires >= 0.80.10
```

**Option B — one-line installer (macOS / Linux)**

```bash
curl -fsSL https://pi.dev/install.sh | sh
pi --version
```

**First-time Pi setup**: launch `pi` once in any directory, then run `/login` inside Pi to configure a model provider (API key or subscription login). See the [Pi documentation](https://pi.dev/) for the full provider list (Anthropic, OpenAI, Google, Volcengine, DeepSeek, Kimi, MiniMax, GLM, Qwen, OpenRouter, Ollama, …).

> pi-delegate only invokes Pi non-interactively (`pi -p`), so the interactive TUI is just for initial `/login` and model setup. You never need to drive Pi by hand for delegated tasks.

## Install

### Option 1 — npm global (recommended once published)

```bash
npm install -g pi-delegate
pi-worker --help
```

### Option 2 — npx (no install)

```bash
npx pi-delegate serve
```

### Option 3 — local link (for development / pre-publish verification)

```bash
git clone https://github.com/hLxiao9/pi-delegate.git
cd pi-delegate
npm install        # only if you add deps later; currently zero runtime deps
npm link           # exposes `pi-worker` on PATH
pi-worker --help
```

> **Roadmap**: Homebrew tap (`brew tap hLxiao9/pi-delegate && brew install pi-delegate`) and a `curl | sh` one-line installer will be added after the first npm release.

## First-time setup

`npm install -g pi-delegate` automatically runs `node scripts/install-config.mjs` (via the `postinstall` hook) to merge the default config into `~/.config/pi-worker/config.json` and the Volcengine provider into `~/.pi/agent/models.json`. The merge is idempotent — your existing profiles, rate card, and subscription are preserved.

If the auto-config did not run (e.g., `npm install --ignore-scripts`, a sandboxed package manager, or a tarball install), run it manually:

```bash
node scripts/install-config.mjs   # merges defaults; never overwrites user edits
pi-worker init                    # interactive provider selection + credential report
```

> **`apiKeyEnv` contract warning**: the `apiKeyEnv` field in `~/.config/pi-worker/config.json` and the `$VAR` reference in `~/.pi/agent/models.json` must point to the **same** environment variable name. Mismatched names (e.g., `apiKeyEnv: VOLCENGINE_API_KEY` in config but `$API_KEY` in models.json) cause silent 401s at run time. `pi-worker doctor` detects this and suggests the correct name.

## Quickstart

```bash
# 1. Pre-flight check (validates Pi, model, credentials, config — no run created)
pi-worker doctor --task ./task.json

# 2. Prepare an isolated worker branch + worktree
pi-worker prepare --task ./task.json --usage-start ./usage-start.json

# 3. Run Pi on the isolated worktree
pi-worker run --id <run-id>

# 4. Verify the actual diff (independent of Pi's claims)
pi-worker verify --id <run-id>

# 5. Approve + integrate into the source branch
pi-worker approve --id <run-id> --review ./review.json --message "feat: ..."
pi-worker integrate --id <run-id>

# 6. Persist metrics + clean up
pi-worker report --id <run-id>
pi-worker cleanup --id <run-id>
```

If the terminal or parent process is interrupted, inspect the persisted run and
re-enter the same closed loop instead of creating a new run:

```bash
pi-worker inspect --id <run-id>
pi-worker recover --id <run-id>
```

`recover` only reopens an interrupted or timed-out run. If the worker left a
partial diff, it sends the run to `verify`; if no diff exists, it sends it back
to `run`. A live lock is never stolen; only a lock whose owner process is gone
is reclaimed.

See [`SKILL.md`](./SKILL.md) for the full parent-agent workflow, hard gates, and routing rules.

## Integrating with parent agents

pi-delegate is a **skill**: it is driven by your parent agent (Codex / Claude Code / Trae / Cursor / another Pi) reading [`SKILL.md`](./SKILL.md) and then invoking the `pi-worker` CLI. The parent keeps architecture, review, and commit authority; Pi only implements the bounded task.

### Step 1 — Give the parent agent the skill

Load `SKILL.md` into the parent agent's context using whichever mechanism that agent supports:

| Parent agent | How to load `SKILL.md` |
|---|---|
| **Pi** | `pi install path/to/pi-delegate` (treats it as a local Pi skill package) |
| **Codex (OpenAI)** | Drop `SKILL.md` (or a symlink) into `~/.codex/skills/` and restart Codex, or paste its contents into your project's `AGENTS.md` |
| **Claude Code** | Add the skill under `~/.claude/skills/` or include the contents in `.claude/CLAUDE.md` |
| **Trae** | Add the contents of `SKILL.md` to your Trae project rules / instructions |
| **Cursor** | Add the contents of `SKILL.md` to `.cursor/rules/` (project rules) |
| **Ad-hoc shell** | Just `node scripts/pi-worker.mjs <command> ...` — no skill loading needed |

`SKILL.md` is self-contained: it tells the parent agent the closed-loop workflow (`doctor → prepare → run → verify → self-review → approve → integrate → report → cleanup`), the hard gates, the routing rules, and the exact `pi-worker` commands. The parent agent then calls `pi-worker` via its normal shell/bash tool.

### Step 2 — Identify the caller

Set `PARENT_AGENT` (or `PI_WORKER_CALLER`) in the environment that invokes `pi-worker prepare`, so usage tracking and the dashboard can attribute runs correctly:

```bash
export PARENT_AGENT=codex      # one of: codex | claude-code | trae | cursor | pi-recursive | cli
```

### Step 3 — Run a delegated task

Once the skill is loaded, ask your parent agent in natural language, e.g.:

> "Delegate to Pi: add a `slugify` function to `utils.js` that lowercases, trims, collapses whitespace to hyphens, and strips non-alphanumerics. Tests in `test.js` must pass."

The parent agent will construct a `task.json` matching [`schemas/task-contract.schema.json`](./schemas/task-contract.schema.json), then drive the full closed loop itself. You do not need to call `pi-worker` manually.

### Step 4 — Watch the dashboard

While the parent agent works, open a second terminal:

```bash
pi-worker serve    # http://localhost:7317/
```

The dashboard groups runs by caller, so you can see which agent is delegating what, in real time.

> **Note on `trae` and `cursor` callers**: usage metering for these two is not yet implemented — the dashboard reports `available: false` for their usage numbers. Set `PARENT_AGENT=codex` or `claude-code` instead if you need usage stats.

## Monitoring

Every run is persisted under `~/.local/state/pi-worker/runs/<run-id>/` (`state.json`, `pi-events.jsonl`, `metrics.json`, `report.md`). Query it without touching the worker:

| Command | Purpose |
|---|---|
| `pi-worker list [--status <s>] [--caller <c>]` | JSON array of runs |
| `pi-worker inspect --id <run-id>` | Full state + metrics + verification + review + Pi usage |
| `pi-worker recover --id <run-id>` | Reopen an interrupted/timed-out run safely |
| `pi-worker dashboard [--output <file>]` | Static single-page HTML snapshot |
| `pi-worker serve [--port <port>] [--no-open]` | **Live** HTTP dashboard with refresh button |

### Live dashboard

**Fastest: double-click launcher**

The [`start-dashboard.command`](./start-dashboard.command) at the repo root is a one-click launcher (double-click on macOS):

- Auto-detects the `pi-worker` command; prints `npm install -g pi-delegate` or `npm link` hints when missing
- Starts a local HTTP server and opens the browser automatically
- The "Refresh" button in the browser pulls the latest usage in real time, or just press F5
- `Ctrl+C` stops the server
- Port can be overridden with the `PI_WORKER_PORT` env var (default 7317)

Linux / generic environments:

```bash
bash start-dashboard.command
# or directly
pi-worker serve
```

**Direct CLI invocation**:

```bash
pi-worker serve              # http://localhost:7317/
pi-worker serve --port 8080  # custom port
pi-worker serve --no-open    # do not auto-open browser
```

- `GET /` — HTML dashboard
- `GET /api/fragment` — rendered HTML fragment (used by the "Refresh" button)
- `GET /api/runs` — raw JSON of state + metrics
- `GET /health` — health check

The "Refresh" button (and ordinary F5) re-reads `~/.local/state/pi-worker/runs/` so you always see the latest runs. A statically opened `dashboard.html` (`file://`) is a snapshot — use `serve` for real-time monitoring.

### Caller identification

Set `PARENT_AGENT` (or `PI_WORKER_CALLER`) in the environment that invokes `pi-worker prepare`:

```bash
PARENT_AGENT=codex   pi-worker prepare --task ./task.json   # → caller: codex
PARENT_AGENT=trae    pi-worker prepare --task ./task.json   # → caller: trae
PARENT_AGENT=cli     pi-worker prepare --task ./task.json   # → caller: cli
```

The dashboard groups runs by caller; `list --caller <name>` filters accordingly.

## Configuration

### File locations

- Default config: `fixtures/default-config.json`
- User config: `~/.config/pi-worker/config.json`
- Models registry: `~/.config/pi-worker/models.json`
- Override paths via env: `PI_WORKER_CONFIG`, `PI_WORKER_MODELS_FILE`, `PI_WORKER_STATE_DIR`, `PI_WORKER_CACHE_DIR`, `PI_WORKER_PI_BIN`

### Configuring models

pi-delegate does **not** manage model credentials itself — Pi does. The flow is:

1. **Configure providers in Pi first.** Launch `pi`, run `/login`, and add your API keys / subscriptions. Pi stores them in `~/.pi/agent/models.json`. See the [Pi documentation](https://pi.dev/) for the full provider list and setup steps.
2. **List models Pi can see**, to confirm what you can reference in pi-delegate profiles:

   ```bash
   pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --list-models
   ```
3. **Map those models to pi-delegate profiles** in `~/.config/pi-worker/config.json`. Each profile picks a `provider` + `model` from Pi's registry and tags it with a `costTier` (`cheap` / `standard` / `premium`), `strengths` (domains), and `modalities`. Nine profiles ship by default (`volcengine`, `deepseek`, `kimi`, `minimax-m3`, `gemini-vision`, `gpt-image`, `kimi-cli`, `trae-cli`, `qoder-cli`) — see [`references/provider-configuration.md`](./references/provider-configuration.md) for the full table and copy-paste JSON snippets for adding your own.
4. **Validate** with `pi-worker doctor` — it checks Node, Git, Pi, credentials, model availability, and task schema in one pass.

> **Tip**: pi-delegate auto-selects a profile by task difficulty (`low → cheap`, `medium → standard`, `high → premium`). To force a specific profile (e.g. you only have MiniMax credentials), pass `--profile minimax-m3` to `doctor` / `prepare`.

### Multi-CLI backends (Pi / Kimi / Trae / Qoder)

Beyond the default Pi backend, profiles can set `adapter: kimi | trae | qoder` to drive other coding CLIs. See the "Multi-CLI Adapter Support" section in [`references/provider-configuration.md`](./references/provider-configuration.md).

## Development

```bash
npm test              # node:test suite
npm run check:syntax  # node --check on all entry points
npm run check         # syntax + tests
```

Tests live in `tests/*.test.mjs` and run with `node --test --test-concurrency=1`.

## Project layout

```
pi-delegate/
├── scripts/
│   ├── pi-worker.mjs        # CLI entry (bin)
│   ├── install-config.mjs   # one-time config bootstrap
│   └── parent-meter.mjs     # parent-agent usage snapshot
├── lib/
│   ├── cli.mjs              # arg parsing + dispatch
│   ├── dashboard.mjs        # HTML rendering + summary logic
│   ├── server.mjs           # `serve` HTTP server
│   ├── state.mjs            # run state machine + persistence
│   ├── pi-runner.mjs        # Pi invocation
│   ├── verification.mjs     # independent verification gate
│   ├── review.mjs           # parent review / approve
│   ├── integration.mjs      # branch integrate + cleanup
│   ├── report.mjs           # metrics + report.md
│   └── ...
├── schemas/                 # JSON schemas (task, review)
├── fixtures/                # default config + provider templates
├── references/              # provider-configuration.md, review-policy.md
├── agents/                  # parent-agent adapters
└── tests/                   # node:test suite
```

## License

This project is licensed under the [GNU Affero General Public License v3.0 or later](./LICENSE) (AGPL-3.0-or-later).

Commercial use that keeps derivatives closed-source requires a separate commercial license — please open an issue to discuss.
