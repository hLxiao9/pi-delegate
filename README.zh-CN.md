# pi-delegate

> 主控端 Agent 拥有的 Pi 实现 Worker：把有边界的代码任务委托给 Pi CLI，自带隔离、独立验证、审查与实时监控面板。

[English](./README.md) | [简体中文](./README.zh-CN.md)

把架构决策、验收标准、独立验证、审查与提交权限都留在**主控端 Agent**（Codex / Claude Code / Trae / Cursor / 另一个 Pi）手里。把 Pi 当作不可信的实现 Worker 对待。主控端永远不需要让用户审查代码。

---

## 特性

- **闭环委托**：`doctor → prepare → run → verify → approve → integrate → report → cleanup`
- **崩溃安全恢复**：进程组超时、SIGINT/SIGTERM 清理、过期锁回收、`recover` 重入
- **多主控端调度**：通过环境变量追踪调用方（`trae`、`codex`、`claude-code`、`cursor`、`pi-recursive`、`cli`）
- **按难度自动选模型**：cheap / standard / premium 三档 profile
- **硬性闸门**：wrapper 验证、diff 哈希完整性、安全扫描、零未解决 P0–P2 问题
- **实时监控面板**：HTTP 服务，带刷新按钮、汇总卡片、可过滤的 run 表格、可展开详情行

## 前置条件

- **Node.js** `>=22.19.0`
- **Pi CLI** `>=0.80.10` 在 `PATH` 中（或设置 `PI_WORKER_PI_BIN`）
- **Git**（worker 需要 Git 仓库）
- 环境变量中的 provider 凭证（如 `VOLCENGINE_API_KEY`）

## 安装 Pi CLI

pi-delegate 驱动的是 [Pi CLI](https://github.com/earendil-works/pi)（项目主页：<https://pi.dev/>），所以运行 `pi-worker` 之前必须先把 `pi` 放到 `PATH` 上。Pi 是一个独立的开源项目，需要单独安装。

**方式 A — npm 全局安装（跨平台）**

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version          # 验证；pi-delegate 要求 >= 0.80.10
```

**方式 B — 一行安装脚本（macOS / Linux）**

```bash
curl -fsSL https://pi.dev/install.sh | sh
pi --version
```

**首次配置 Pi**：在任意目录启动 `pi`，然后在 Pi 内执行 `/login` 配置模型 provider（API key 或订阅登录）。完整 provider 列表（Anthropic、OpenAI、Google、Volcengine、DeepSeek、Kimi、MiniMax、GLM、Qwen、OpenRouter、Ollama 等）见 [Pi 官方文档](https://pi.dev/)。

> pi-delegate 只会非交互式地调用 Pi（`pi -p`），所以交互式 TUI 仅用于首次 `/login` 和模型配置。委托任务你永远不需要手动驱动 Pi。

## 安装

### 方式 1 — npm 全局安装（发布后推荐）

```bash
npm install -g pi-delegate
pi-worker --help
```

### 方式 2 — npx（免安装）

```bash
npx pi-delegate serve
```

### 方式 3 — 本地 link（开发 / 发布前验证用）

```bash
git clone https://github.com/hLxiao9/pi-delegate.git
cd pi-delegate
npm install        # 仅在后续添加依赖时需要；当前零运行时依赖
npm link           # 把 `pi-worker` 暴露到 PATH
pi-worker --help
```

> **路线图**：首个 npm 版本发布后，会增加 Homebrew tap（`brew tap hLxiao9/pi-delegate && brew install pi-delegate`）与 `curl | sh` 一行安装脚本。

## 快速开始

```bash
# 1. 预检（校验 Pi、模型、凭证、配置 —— 不会创建 run）
pi-worker doctor --task ./task.json

# 2. 准备隔离的 worker 分支 + worktree
pi-worker prepare --task ./task.json --usage-start ./usage-start.json

# 3. 在隔离 worktree 上运行 Pi
pi-worker run --id <run-id>

# 4. 验证真实 diff（不依赖 Pi 的自述）
pi-worker verify --id <run-id>

# 5. 审批 + 集成回源分支
pi-worker approve --id <run-id> --review ./review.json --message "feat: ..."
pi-worker integrate --id <run-id>

# 6. 持久化 metrics + 清理
pi-worker report --id <run-id>
pi-worker cleanup --id <run-id>
```

如果终端或主控进程被中断，检查已持久化的 run，重新进入同一闭环，而不是创建新 run：

```bash
pi-worker inspect --id <run-id>
pi-worker recover --id <run-id>
```

`recover` 只重开被中断或超时的 run。如果 worker 留下了部分 diff，它会送到 `verify`；如果没有 diff，会送回 `run`。活动锁永远不会被抢占；只有锁的 owner 进程已不在时才会被回收。

完整的主控端工作流、硬性闸门与路由规则见 [`SKILL.md`](./SKILL.md)。

## 与主控端 Agent 集成

pi-delegate 是一个 **skill**：由你的主控端 Agent（Codex / Claude Code / Trae / Cursor / 另一个 Pi）读取 [`SKILL.md`](./SKILL.md)，然后调用 `pi-worker` CLI 来驱动。主控端保留架构、审查、提交权限；Pi 只实现被分配的有边界任务。

### 第 1 步 —— 把 skill 装载给主控端

用主控端支持的方式把 `SKILL.md` 加载进它的上下文：

| 主控端 | 加载 `SKILL.md` 的方式 |
|---|---|
| **Pi** | `pi install path/to/pi-delegate`（作为本地 Pi skill 包加载） |
| **Codex (OpenAI)** | 把 `SKILL.md`（或软链接）放到 `~/.codex/skills/` 后重启 Codex，或把内容粘进项目的 `AGENTS.md` |
| **Claude Code** | 加到 `~/.claude/skills/`，或把内容写进 `.claude/CLAUDE.md` |
| **Trae** | 把 `SKILL.md` 内容加到 Trae 项目规则 / 指令中 |
| **Cursor** | 把 `SKILL.md` 内容加到 `.cursor/rules/`（项目规则） |
| **临时 shell** | 直接 `node scripts/pi-worker.mjs <命令> ...` —— 不需要加载 skill |

`SKILL.md` 是自包含的：它告诉主控端完整闭环流程（`doctor → prepare → run → verify → self-review → approve → integrate → report → cleanup`）、硬性闸门、路由规则，以及精确的 `pi-worker` 命令。主控端之后通过它正常的 shell/bash 工具调用 `pi-worker`。

### 第 2 步 —— 标识调用方

在调用 `pi-worker prepare` 的环境里设置 `PARENT_AGENT`（或 `PI_WORKER_CALLER`），这样用量追踪和面板才能正确归因：

```bash
export PARENT_AGENT=codex      # 可选值: codex | claude-code | trae | cursor | pi-recursive | cli
```

### 第 3 步 —— 跑一个委托任务

skill 装载好后，用自然语言告诉主控端，比如：

> "委托给 Pi：给 `utils.js` 加一个 `slugify` 函数，要小写、trim、把空白折叠成连字符、剔除非字母数字。`test.js` 里的测试必须通过。"

主控端会自己构造符合 [`schemas/task-contract.schema.json`](./schemas/task-contract.schema.json) 的 `task.json`，然后自己驱动整个闭环。你不需要手动调用 `pi-worker`。

### 第 4 步 —— 看面板

主控端干活时，另开一个终端：

```bash
pi-worker serve    # http://localhost:7317/
```

面板按 caller 分组显示 runs，所以你能实时看到哪个 agent 在委托什么。

> **关于 `trae` 和 `cursor` 调用方**：这两个的用量计量尚未实现 —— 面板对它们的用量数字会报 `available: false`。如果你需要用量统计，请改用 `PARENT_AGENT=codex` 或 `claude-code`。

## 监控

每个 run 都持久化在 `~/.local/state/pi-worker/runs/<run-id>/`（`state.json`、`pi-events.jsonl`、`metrics.json`、`report.md`）。无需触碰 worker 即可查询：

| 命令 | 用途 |
|---|---|
| `pi-worker list [--status <s>] [--caller <c>]` | runs 的 JSON 数组 |
| `pi-worker inspect --id <run-id>` | 完整 state + metrics + 验证 + 审查 + Pi 用量 |
| `pi-worker recover --id <run-id>` | 安全重开被中断/超时的 run |
| `pi-worker dashboard [--output <file>]` | 静态单页 HTML 快照 |
| `pi-worker serve [--port <port>] [--no-open]` | **实时** HTTP 面板，带刷新按钮 |

### 实时面板

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
pi-worker serve --port 8080  # 自定义端口
pi-worker serve --no-open    # 不自动打开浏览器
```

- `GET /` — HTML 面板
- `GET /api/fragment` — 渲染后的 HTML 片段（"刷新"按钮使用）
- `GET /api/runs` — state + metrics 的原始 JSON
- `GET /health` — 健康检查

"刷新"按钮（以及普通的 F5）会重新读取 `~/.local/state/pi-worker/runs/`，所以你看到的永远是最新的 runs。静态打开的 `dashboard.html`（`file://`）只是快照 —— 实时监控请用 `serve`。

### 调用方识别

在调用 `pi-worker prepare` 的环境里设置 `PARENT_AGENT`（或 `PI_WORKER_CALLER`）：

```bash
PARENT_AGENT=codex   pi-worker prepare --task ./task.json   # → caller: codex
PARENT_AGENT=trae    pi-worker prepare --task ./task.json   # → caller: trae
PARENT_AGENT=cli     pi-worker prepare --task ./task.json   # → caller: cli
```

面板按 caller 分组显示 runs；`list --caller <name>` 可按调用方过滤。

## 配置

### 文件位置

- 默认配置：`fixtures/default-config.json`
- 用户配置：`~/.config/pi-worker/config.json`
- 模型注册表：`~/.config/pi-worker/models.json`
- 通过环境变量覆盖路径：`PI_WORKER_CONFIG`、`PI_WORKER_MODELS_FILE`、`PI_WORKER_STATE_DIR`、`PI_WORKER_CACHE_DIR`、`PI_WORKER_PI_BIN`

### 配置模型

pi-delegate **不**自己管理模型凭证 —— 那是 Pi 的职责。流程是：

1. **先在 Pi 里配置 provider。** 启动 `pi`，运行 `/login`，添加你的 API key / 订阅。Pi 会把它们存到 `~/.pi/agent/models.json`。完整 provider 列表和配置步骤见 [Pi 官方文档](https://pi.dev/)。
2. **列出 Pi 能看到的模型**，确认你在 pi-delegate profile 里能引用哪些：

   ```bash
   pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --list-models
   ```
3. **把这些模型映射成 pi-delegate profile**，写到 `~/.config/pi-worker/config.json`。每个 profile 从 Pi 的注册表里挑一个 `provider` + `model`，并打上 `costTier`（`cheap` / `standard` / `premium`）、`strengths`（领域）、`modalities` 标签。默认带 6 个 profile（`volcengine`、`deepseek`、`kimi`、`minimax-m3`、`gemini-vision`、`gpt-image`）—— 完整表格和添加自定义 profile 的可复制 JSON 片段见 [`references/provider-configuration.md`](./references/provider-configuration.md)。
4. **用 `pi-worker doctor` 校验** —— 它一次过检查 Node、Git、Pi、凭证、模型可用性、task schema。

> **提示**：pi-delegate 会按任务难度自动选 profile（`low → cheap`、`medium → standard`、`high → premium`）。如果想强制用某个 profile（比如你只有 MiniMax 凭证），给 `doctor` / `prepare` 传 `--profile minimax-m3`。

### 多 CLI 后端（Pi / Kimi / Trae / Qoder）

除了默认的 Pi 后端，profile 还可以设置 `adapter: kimi | trae | qoder` 来驱动其他编码 CLI。详见 [`references/provider-configuration.md`](./references/provider-configuration.md) 中的 "Multi-CLI Adapter Support" 段落。

## 开发

```bash
npm test              # node:test 测试套件
npm run check:syntax  # 对所有入口执行 node --check
npm run check         # 语法 + 测试
```

测试位于 `tests/*.test.mjs`，用 `node --test --test-concurrency=1` 运行。

## 项目结构

```
pi-delegate/
├── scripts/
│   ├── pi-worker.mjs        # CLI 入口（bin）
│   ├── install-config.mjs   # 一次性配置引导
│   └── parent-meter.mjs     # 主控端用量快照
├── lib/
│   ├── cli.mjs              # 参数解析 + 分发
│   ├── dashboard.mjs        # HTML 渲染 + 汇总逻辑
│   ├── server.mjs           # `serve` HTTP 服务
│   ├── state.mjs            # run 状态机 + 持久化
│   ├── pi-runner.mjs        # Pi 调用
│   ├── verification.mjs     # 独立验证闸门
│   ├── review.mjs           # 主控端审查 / 审批
│   ├── integration.mjs      # 分支集成 + 清理
│   ├── report.mjs           # metrics + report.md
│   └── ...
├── schemas/                 # JSON schema（task、review）
├── fixtures/                # 默认配置 + provider 模板
├── references/              # provider-configuration.md、review-policy.md
├── agents/                  # 主控端 adapter
└── tests/                   # node:test 测试套件
```

## 协议

本项目基于 [GNU Affero General Public License v3.0 or later](./LICENSE)（AGPL-3.0-or-later）授权。

如需闭源商业使用，需另行购买商业授权 —— 请提 issue 联系。
