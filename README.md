# pi-delegate

> Parent-agent-owned Pi implementation worker: delegate bounded code tasks to Pi CLI with isolation, verification, review, and a live monitoring dashboard.

Keep architecture, acceptance criteria, independent verification, review, and commit authority with the **parent agent** (Codex / Claude Code / Trae / Cursor / another Pi). Treat Pi as an untrusted implementation worker. The parent agent never needs the user to review code.

---

## Features

- **Closed-loop delegation**: `doctor → prepare → run → verify → approve → integrate → report → cleanup`
- **Multi-parent dispatch**: tracks caller (`trae`, `codex`, `claude-code`, `cursor`, `pi-recursive`, `cli`) via env vars
- **Automatic model selection by difficulty**: cheap / standard / premium profiles
- **Hard gates**: wrapper verification, diff-hash integrity, security scan, zero unresolved P0–P2 findings
- **Live monitoring dashboard**: HTTP server with refresh button, summary cards, filterable run table, expandable detail rows

## Prerequisites

- **Node.js** `>=22.19.0`
- **Pi CLI** `>=0.80.10` on `PATH` (or set `PI_WORKER_PI_BIN`)
- **Git** (the worker requires a Git repository)
- Provider credentials in env (e.g. `VOLCENGINE_API_KEY`)

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
git clone https://github.com/your-org/pi-delegate.git
cd pi-delegate
npm install        # only if you add deps later; currently zero runtime deps
npm link           # exposes `pi-worker` on PATH
pi-worker --help
```

> **Roadmap**: Homebrew tap (`brew tap your-org/pi-delegate && brew install pi-delegate`) and a `curl | sh` one-line installer will be added after the first npm release.

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

See [`SKILL.md`](./SKILL.md) for the full parent-agent workflow, hard gates, and routing rules.

## Monitoring

Every run is persisted under `~/.local/state/pi-worker/runs/<run-id>/` (`state.json`, `pi-events.jsonl`, `metrics.json`, `report.md`). Query it without touching the worker:

| Command | Purpose |
|---|---|
| `pi-worker list [--status <s>] [--caller <c>]` | JSON array of runs |
| `pi-worker inspect --id <run-id>` | Full state + metrics + verification + review + Pi usage |
| `pi-worker dashboard [--output <file>]` | Static single-page HTML snapshot |
| `pi-worker serve [--port <port>] [--no-open]` | **Live** HTTP dashboard with refresh button |

### Live dashboard

**最快方式：双击启动**

仓库根目录的 [`start-dashboard.command`](./start-dashboard.command) 是一个一键启动器（macOS 双击即可）：

- 自动检测 `pi-worker` 命令；未安装时给出 `npm install -g pi-delegate` 或 `npm link` 提示
- 启动本地 HTTP 服务并自动打开浏览器
- 浏览器里的"刷新"按钮实时拉取最新用量，或直接 F5
- `Ctrl+C` 停止服务
- 端口可用 `PI_WORKER_PORT` 环境变量覆盖（默认 7317）

Linux / 通用环境：

```bash
bash start-dashboard.command
# 或直接
pi-worker serve
```

**命令行直接调用**：

```bash
pi-worker serve              # http://localhost:7317/
pi-worker serve --port 8080  # custom port
pi-worker serve --no-open    # do not auto-open browser
```

- `GET /` — HTML dashboard
- `GET /api/fragment` — rendered HTML fragment (used by the "刷新" button)
- `GET /api/runs` — raw JSON of state + metrics
- `GET /health` — health check

The "刷新" button (and ordinary F5) re-reads `~/.local/state/pi-worker/runs/` so you always see the latest runs. A statically opened `dashboard.html` (`file://`) is a snapshot — use `serve` for real-time monitoring.

### Caller identification

Set `PARENT_AGENT` (or `PI_WORKER_CALLER`) in the environment that invokes `pi-worker prepare`:

```bash
PARENT_AGENT=codex   pi-worker prepare --task ./task.json   # → caller: codex
PARENT_AGENT=trae    pi-worker prepare --task ./task.json   # → caller: trae
PARENT_AGENT=cli     pi-worker prepare --task ./task.json   # → caller: cli
```

The dashboard groups runs by caller; `list --caller <name>` filters accordingly.

## Configuration

- Default config: `fixtures/default-config.json`
- User config: `~/.config/pi-worker/config.json`
- Models registry: `~/.config/pi-worker/models.json`
- Override paths via env: `PI_WORKER_CONFIG`, `PI_WORKER_MODELS_FILE`, `PI_WORKER_STATE_DIR`, `PI_WORKER_CACHE_DIR`, `PI_WORKER_PI_BIN`

See [`references/provider-configuration.md`](./references/provider-configuration.md) for provider setup.

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

MIT
