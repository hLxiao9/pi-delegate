# spotworkers

[![npm version](https://img.shields.io/npm/v/spotworkers.svg)](https://www.npmjs.com/package/spotworkers)
[![npm downloads](https://img.shields.io/npm/dm/spotworkers.svg)](https://www.npmjs.com/package/spotworkers)
[![license](https://img.shields.io/npm/l/spotworkers.svg)](./LICENSE)
[![CI](https://github.com/hLxiao9/spotworkers/actions/workflows/ci.yml/badge.svg)](https://github.com/hLxiao9/spotworkers/actions/workflows/ci.yml)

> **不再把 Claude Code / Codex 的额度，消耗在便宜模型也能完成的工作上。**
>
> `spot` 把有边界的实现任务派给便宜的 Agent Worker（Pi / Qwen / DeepSeek / Kimi / Qoder / CodeBuddy），随后自行重跑你的测试、校验 diff 哈希，所有闸门通过才合并。架构、审查与提交权始终留在主控端 Agent 手里。

[English](./README.md) | [简体中文](./README.zh-CN.md)

主控端不必让用户去为不是自己写的代码背书。**把 Worker 视为不可信方**：它拿不到 Bash、extensions、Skills 与项目信任，也无法对测试结果撒谎 —— `verification.json` 由 wrapper 生成，而非 Worker 自身。

> 原项目名 `pi-delegate`，现已更名。`pi-worker` 命令仍可作为 `spot` 的别名使用。

---

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/delegation-loop-dark.svg">
  <img src="docs/delegation-loop.svg" alt="委托闭环：主控端保留判断权，Worker 只负责产出 diff。主控端 Agent 定架构与验收标准，prepare 按难度选模型档位，廉价 Worker 实现，verify 重跑测试并校验 diff 哈希，approve 仅在所有闸门通过时合并。" width="100%">
</picture>

## 特性

### 闭环委托 + 独立验证
`doctor → prepare → run → verify → self-review → approve → integrate → report → cleanup`。wrapper 会自己重跑你的验证命令（不依赖 Pi 的自述），并且每个闸门都校验 diff 哈希 —— 哈希一变就阻断审批。

### 防作弊 self-review（主控端 token 省钱）
主控端读完整 diff 之前，可选的第二个 worker 回合会重读自己的产出，吐出紧凑的 `self-review.json`（约 50 行 vs 数千行）。防作弊机制：
- `verification.json` 由 wrapper 生成，不是 worker —— 它无法对测试结果撒谎。
- `diffSha256Mismatch=true`（回错哈希）→ 主控端升级为全量审查。
- `fallbackRecommended=true`（自报 `unmet`/`uncertain` 或任意 P0–P2）→ 主控端升级。
- `approve` 会再扫一次 diff，哈希变了就拒。
- 高危任务永远到不了 self-review（`HIGH_RISK_BLOCKED`）。

self-review 永远不会卡住闭环 —— worker 失败、JSON 解析失败、diff 小于 `minDiffBytes`、或审查面（diff + 改动文件体积）小于 `minSurfaceBytes` 时，它会自动降级到 `reviewing` 并标 `skipped:true`。`minSurfaceBytes`（默认 4000）的理由是：报告约每条约 700 字节，而小 diff 直接读更便宜。用 `selfReview.enabled=false` 完全关闭；`selfReview.spotCheckRatio`（默认 0.34）调整按比例的抽查量。

### 硬性闸门与安全
- 审批前必须：wrapper 验证通过、diff 哈希不变、安全扫描通过、有验收证据、**零未解决 P0–P2 问题**。
- worker 不能改给它打分的装置：契约 `lockedPaths`、配置 `alwaysLockedPaths`（CI 与测试运行器配置）、以及 `package.json` 里决定执行方式的键（`scripts`、`jest`、`vitest`、`mocha`、`ava`、`nyc`、`c8`、`workspaces`、`packageManager`）全部冻结；依赖仍可改。违反即 `LOCKED_PATH_CHANGED` / `VERIFICATION_SCRIPT_CHANGED` 阻断。
- worker 被当作不可信：永不开 Bash、extensions、Skills、prompt templates、context files、项目 auto-trust。
- 永不 push、建 PR、改 remote，也不会把 worktree 隔离说成 OS 沙箱。
- 永不绕过鉴权错误或能力不匹配 —— setup/凭证失败就是真 blocker。

### 崩溃安全恢复
进程组超时、SIGINT/SIGTERM 清理、过期锁回收。中断后 `spot recover --id <run-id>` 原地重开 run：有部分 diff 送 `verify`，没 diff 送回 `run`。活动锁永远不会被抢 —— 只有 owner 进程已不在的锁才会被回收。

### 多主控端调度
通过 `PARENT_AGENT` / `PI_WORKER_CALLER` 环境变量追踪调用方（`trae`、`codex`、`claude-code`、`cursor`、`pi-recursive`、`cli`），面板可归因、`list --caller <name>` 可过滤。

### 并行执行
多个主控端会话可并发 —— 每个 run 有独立的 Git worktree、state 目录、per-run 文件锁，不同 run 互不碰撞，同一 run 不会被两个进程同时推进。`maxConcurrentRuns`（默认 4，范围 1–16）限制活动 run 数；超限 `prepare` 返回 `CONCURRENCY_LIMIT`。面板读 `state.json` 时容忍 JSON 解析失败，并发写入时快照不会崩。

### 按难度自动选模型
在契约里直接声明 `difficulty`（`low`/`medium`/`high`）即按声明路由。不声明时由 `risk` 与 `domain` 主导（`medium` 风险 + `backend`/`systems`/`algorithm` 领域即判 `medium`），而验收条数、验证数、约束数、`tool-use` 这类规模信号最多贡献 +2。难度再选 `cheap`/`standard`/`premium` profile；同档内 `task.domain` 软匹配 `profile.strengths`。用 `--profile <name>` 强制；不写 `costTier` 即关闭自动选择。

### 多 CLI 后端
除默认 Pi 后端外，profile 可设 `adapter: kimi | trae | qoder | opencode | codebuddy | zcode` 驱动其他编码 CLI（Kimi Code CLI、Trae CLI、Qoder CLI、OpenCode、CodeBuddy Code CLI、ZCode CLI）。跨 adapter fallback 无缝工作。详见 [`references/provider-configuration.md`](./references/provider-configuration.md)。

### 成本与节省指标
头号指标是**主模型少花的 token**：worker 侧要么免费、要么有折扣、要么单价低一个数量级，所以判断值不值得委派，看的是主模型那一边。每次 run 都会记录两件事——委派模式下父级实际读的内容（self-review 报告，或完整审查面），以及反事实：自己动手要读 diff + 改动文件（按 1.5 轮算）并写出新增的那些行。两个口径都报：纯 token 比例，和按价格加权的比例（输出 token 约为输入的 4 倍）。计算依据与被排除项都写进 `metrics.json`，数字可复核而不是凭信。

单次明细还记录 token 用量（输入/输出/缓存）、worker 侧 provider 上报的用量，以及——仅当父级 backend 配了费率卡时——折算 credits 与订阅额度占比。按 credits 计费的后端（Qoder CN 只报 `total_credits`，不报 token 数）会把这个值单独暴露，credit 口径的节省率降级为 `null`，绝不编造。

### 实时监控面板
HTTP 服务，带刷新按钮、汇总卡片、可过滤 run 表（按 caller、状态、自由文本）、可展开详情行、亮/暗主题，以及 "Connection status" tab 展示 CLI adapter 与 profile 凭证健康度。

## 最近更新

`v0.1.0` 发布的是闭环主干。此后（未发布，位于 `main`）：

- **免费档位路由。** `model: "free"`（别名 `qoder-free`、`cheapest`）在派发时解析为账户可达的最低 `price_factor` 模型，profile 无需硬编码模型名，避免模型下架后失效。Qoder 当前有两个 `0x` 档位：`DeepSeek-Flash` 与 `Qwen3.8-Flash`。
- **带定价的模型目录。** `spot detect` 逐行输出倍率、上下文档位与合法 effort 档位 —— `12 model(s) (2 free)`，其后每个模型标注 `[free]` / `[0.1x]` / `[1.4x]`。目录缓存 30 分钟；离线时降级为「无目录」而非中断 run。
- **按模型校验能力参数。** 不支持的 `reasoningEffort` 或 `maxContextSize` 会吸附到该模型最近的合法档位，并记为 `worker_warning` 事件与 `worker.log` 的 `[warn]` 行。调整可见，不会静默改写。
- **CodeBuddy CLI adapter。** 第六个后端，与 Pi、Kimi、Trae、Qoder、OpenCode 并列（`adapter: codebuddy`）。
- **所有 adapter 统一计量。** 非流式后端回显 `message_end` 用量事件，`readPiUsage` 统一聚合 token 与时长；面板标签不再绑定 Pi（"Token"、"duration"、"call count"）。
- **修复：`EXCESSIVE_DELETION` 会拦截所有纯修改。** 原守卫按 `删除行 / (新增 + 删除)` 计算，单行修改恒为 `0.5`，必被拦下 —— 而这恰是最常见的委托形态。现改为对照原文件行数，并以 `limits.maxDeletedLines`（默认 `300`）作为绝对上限兜底。
- **修复：Qoder 以交互模式启动并挂起。** CN 版本现显式传入 `-p/--print`；缺此参数时 worker 会打开 TUI 并卡到超时。鉴权失败也归类为 `auth` 而非 `permanent`，凭证问题不再被误报为代码问题。
- **面板。** 60 秒自动刷新（存于 localStorage，标签页获得焦点时刷新）；`workbuddy` 作为来源被识别；新增 `worker.log` 与 `scripts/pi-tmux-monitor`，可并发监视多个 run。

## 前置条件

- **Node.js** `>=22.19.0`
- **至少一个 Worker CLI** 在 `PATH` 中 —— Pi（默认），或 Kimi / Trae / Qoder / OpenCode / CodeBuddy，并在 profile 中配置对应的 `adapter`。`PI_WORKER_PI_BIN` 仅对 Pi adapter 生效，其余后端不会调用 `pi`。
- **Git**（worker 需要 Git 仓库）
- 环境变量中的 provider 凭证（如 `VOLCENGINE_API_KEY`）

运行 `spot detect` 可查看本机已安装哪些 Worker CLI。

## 安装 Worker CLI

默认后端为 [Pi CLI](https://github.com/earendil-works/pi)（项目主页：<https://pi.dev/>）。Pi 是一个独立的开源项目，需单独安装。若你打算使用其他后端，可直接跳到 [`adapter`](#多-cli-后端) 并安装对应 CLI —— 只需确保你所选的 adapter 在 `PATH` 上。

**方式 A — npm 全局安装（跨平台）**

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version          # 验证；spotworkers 要求 >= 0.80.10
```

**方式 B — 一行安装脚本（macOS / Linux）**

```bash
curl -fsSL https://pi.dev/install.sh | sh
pi --version
```

**首次配置 Pi**：在任意目录启动 `pi`，然后在 Pi 内执行 `/login` 配置模型 provider（API key 或订阅登录）。完整 provider 列表（Anthropic、OpenAI、Google、Volcengine、DeepSeek、Kimi、MiniMax、GLM、Qwen、OpenRouter、Ollama 等）见 [Pi 官方文档](https://pi.dev/)。

> spotworkers 只会非交互式地调用 Pi（`pi -p`），所以交互式 TUI 仅用于首次 `/login` 和模型配置。委托任务你永远不需要手动驱动 Pi。

## 安装

### 方式 1 — npm 全局安装（推荐）

```bash
npm install -g spotworkers
spot --help
```

### 方式 2 — npx（免安装）

```bash
npx -p spotworkers spot serve
```

包内提供两个可执行入口（`spot` 与 `pi-worker` 别名），npx 无法自行判断该执行哪一个，需显式指定。

### 方式 3 — 作为 Pi package 安装

```bash
pi install npm:spotworkers
```

该方式会把包内的 `SKILL.md` 注册到 Pi，使 `/skill:spotworkers` 在 Pi 会话中可用。它**不会**把 `spot` 放进 `PATH`；若两者都要，请用方式 1。

### 方式 4 — 本地 link（开发 / 发布前验证用）

```bash
git clone https://github.com/hLxiao9/spotworkers.git
cd spotworkers
npm install        # 仅在后续添加依赖时需要；当前零运行时依赖
npm link           # 把 `spot` 暴露到 PATH
spot --help
```

> **路线图**：首个 npm 版本发布后，会增加 Homebrew tap（`brew tap hLxiao9/spotworkers && brew install spotworkers`）与 `curl | sh` 一行安装脚本。

## 首次配置

`npm install -g spotworkers` 会通过 `postinstall` 钩子自动运行 `node scripts/install-config.mjs`，把默认配置合并进 `~/.config/pi-worker/config.json`，并把 Volcengine provider 合并进 `~/.pi/agent/models.json`。合并是幂等的 —— 你已有的 profile、rate card、subscription 都会保留。

如果自动配置没有跑（比如 `npm install --ignore-scripts`、沙箱包管理器或 tarball 安装），手动执行：

```bash
node scripts/install-config.mjs   # 合并默认配置；绝不覆盖用户已有改动
spot init                    # 交互式选择 provider + 凭证状态报告
```

> **`apiKeyEnv` 契约警告**：`~/.config/pi-worker/config.json` 里的 `apiKeyEnv` 字段与 `~/.pi/agent/models.json` 里的 `$VAR` 引用必须指向**同一个**环境变量名。名字不一致（例如 config 里写 `apiKeyEnv: VOLCENGINE_API_KEY`，但 models.json 里写 `$API_KEY`）会在运行时静默 401。`spot doctor` 会检测这种情况并给出正确名字的建议。

## 快速开始

```bash
# 1. 预检（校验 Pi、模型、凭证、配置 —— 不会创建 run）
spot doctor --task ./task.json

# 2. 准备隔离的 worker 分支 + worktree
spot prepare --task ./task.json --usage-start ./usage-start.json

# 3. 在隔离 worktree 上运行 Pi
spot run --id <run-id>

# 4. 验证真实 diff（不依赖 Pi 的自述）
spot verify --id <run-id>

# 5. 审批 + 集成回源分支
spot approve --id <run-id> --review ./review.json --message "feat: ..."
spot integrate --id <run-id>

# 6. 持久化 metrics + 清理
spot report --id <run-id>
spot cleanup --id <run-id>
```

如果终端或主控进程被中断，检查已持久化的 run，重新进入同一闭环，而不是创建新 run：

```bash
spot inspect --id <run-id>
spot recover --id <run-id>
```

`recover` 只重开被中断或超时的 run。如果 worker 留下了部分 diff，它会送到 `verify`；如果没有 diff，会送回 `run`。活动锁永远不会被抢占；只有锁的 owner 进程已不在时才会被回收。

完整的主控端工作流、硬性闸门与路由规则见 [`SKILL.md`](./SKILL.md)。

## 与主控端 Agent 集成

spotworkers 是一个 **skill**：由你的主控端 Agent（Codex / Claude Code / Trae / Cursor / 另一个 Pi）读取 [`SKILL.md`](./SKILL.md)，然后调用 `spot` CLI 来驱动。主控端保留架构、审查、提交权限；Pi 只实现被分配的有边界任务。

### 第 1 步 —— 把 skill 装载给主控端

用主控端支持的方式把 `SKILL.md` 加载进它的上下文：

| 主控端 | 加载 `SKILL.md` 的方式 |
|---|---|
| **Pi** | `pi install path/to/spotworkers`（作为本地 Pi skill 包加载） |
| **Codex (OpenAI)** | 把 `SKILL.md`（或软链接）放到 `~/.codex/skills/` 后重启 Codex，或把内容粘进项目的 `AGENTS.md` |
| **Claude Code** | 加到 `~/.claude/skills/`，或把内容写进 `.claude/CLAUDE.md` |
| **Trae** | 把 `SKILL.md` 内容加到 Trae 项目规则 / 指令中 |
| **Cursor** | 把 `SKILL.md` 内容加到 `.cursor/rules/`（项目规则） |
| **临时 shell** | 直接 `node scripts/spot.mjs <命令> ...` —— 不需要加载 skill |

`SKILL.md` 是自包含的：它告诉主控端完整闭环流程（`doctor → prepare → run → verify → self-review → approve → integrate → report → cleanup`）、硬性闸门、路由规则，以及精确的 `spot` 命令。主控端之后通过它正常的 shell/bash 工具调用 `spot`。

### 第 2 步 —— 标识调用方

在调用 `spot prepare` 的环境里设置 `PARENT_AGENT`（或 `PI_WORKER_CALLER`），这样用量追踪和面板才能正确归因：

```bash
export PARENT_AGENT=codex      # 可选值: codex | claude-code | trae | cursor | pi-recursive | cli
```

### 第 3 步 —— 跑一个委托任务

skill 装载好后，用自然语言告诉主控端，比如：

> "委托给 Pi：给 `utils.js` 加一个 `slugify` 函数，要小写、trim、把空白折叠成连字符、剔除非字母数字。`test.js` 里的测试必须通过。"

主控端会自己构造符合 [`schemas/task-contract.schema.json`](./schemas/task-contract.schema.json) 的 `task.json`，然后自己驱动整个闭环。你不需要手动调用 `spot`。

### 第 4 步 —— 看面板

主控端干活时，另开一个终端：

```bash
spot serve    # http://localhost:7317/
```

面板按 caller 分组显示 runs，所以你能实时看到哪个 agent 在委托什么。

> **关于 `trae` 和 `cursor` 调用方**：这两个的用量计量尚未实现 —— 面板对它们的用量数字会报 `available: false`。如果你需要用量统计，请改用 `PARENT_AGENT=codex` 或 `claude-code`。

## 监控

每个 run 都持久化在 `~/.local/state/pi-worker/runs/<run-id>/`（`state.json`、`pi-events.jsonl`、`metrics.json`、`report.md`）。无需触碰 worker 即可查询：

| 命令 | 用途 |
|---|---|
| `spot list [--status <s>] [--caller <c>]` | runs 的 JSON 数组 |
| `spot inspect --id <run-id>` | 完整 state + metrics + 验证 + 审查 + Pi 用量 |
| `spot recover --id <run-id>` | 安全重开被中断/超时的 run |
| `spot dashboard [--output <file>]` | 静态单页 HTML 快照 |
| `spot serve [--port <port>] [--no-open]` | **实时** HTTP 面板，带刷新按钮 |

### 实时面板

**最快方式：双击启动**

仓库根目录的 [`start-dashboard.command`](./start-dashboard.command) 是一个一键启动器（macOS 双击即可）：

- 自动检测 `spot` 命令；未安装时给出 `npm install -g spotworkers` 或 `npm link` 提示
- 启动本地 HTTP 服务并自动打开浏览器
- 浏览器里的"刷新"按钮实时拉取最新用量，或直接 F5
- `Ctrl+C` 停止服务
- 端口可用 `PI_WORKER_PORT` 环境变量覆盖（默认 7317）

Linux / 通用环境：

```bash
bash start-dashboard.command
# 或直接
spot serve
```

**命令行直接调用**：

```bash
spot serve              # http://localhost:7317/
spot serve --port 8080  # 自定义端口
spot serve --no-open    # 不自动打开浏览器
```

- `GET /` — HTML 面板
- `GET /api/fragment` — 渲染后的 HTML 片段（"刷新"按钮使用）
- `GET /api/runs` — state + metrics 的原始 JSON
- `GET /health` — 健康检查

"刷新"按钮（以及普通的 F5）会重新读取 `~/.local/state/pi-worker/runs/`，所以你看到的永远是最新的 runs。静态打开的 `dashboard.html`（`file://`）只是快照 —— 实时监控请用 `serve`。

### 调用方识别

在调用 `spot prepare` 的环境里设置 `PARENT_AGENT`（或 `PI_WORKER_CALLER`）：

```bash
PARENT_AGENT=codex   spot prepare --task ./task.json   # → caller: codex
PARENT_AGENT=trae    spot prepare --task ./task.json   # → caller: trae
PARENT_AGENT=cli     spot prepare --task ./task.json   # → caller: cli
```

面板按 caller 分组显示 runs；`list --caller <name>` 可按调用方过滤。

## 配置

### 文件位置

- 默认配置：`fixtures/default-config.json`
- 用户配置：`~/.config/pi-worker/config.json`
- 模型注册表：`~/.config/pi-worker/models.json`
- 通过环境变量覆盖路径：`PI_WORKER_CONFIG`、`PI_WORKER_MODELS_FILE`、`PI_WORKER_STATE_DIR`、`PI_WORKER_CACHE_DIR`、`PI_WORKER_PI_BIN`

### 配置模型

spotworkers **不**自己管理模型凭证 —— 那是 Pi 的职责。流程是：

1. **先在 Pi 里配置 provider。** 启动 `pi`，运行 `/login`，添加你的 API key / 订阅。Pi 会把它们存到 `~/.pi/agent/models.json`。完整 provider 列表和配置步骤见 [Pi 官方文档](https://pi.dev/)。
2. **列出 Pi 能看到的模型**，确认你在 spotworkers profile 里能引用哪些：

   ```bash
   pi --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --list-models
   ```
3. **把这些模型映射成 spotworkers profile**，写到 `~/.config/pi-worker/config.json`。每个 profile 从 Pi 的注册表里挑一个 `provider` + `model`，并打上 `costTier`（`cheap` / `standard` / `premium`）、`strengths`（领域）、`modalities` 标签。默认带 9 个 profile（`volcengine`、`deepseek`、`kimi`、`minimax-m3`、`gemini-vision`、`gpt-image`、`kimi-cli`、`trae-cli`、`qoder-cli`）—— 完整表格和添加自定义 profile 的可复制 JSON 片段见 [`references/provider-configuration.md`](./references/provider-configuration.md)。
4. **用 `spot doctor` 校验** —— 它一次过检查 Node、Git、Pi、凭证、模型可用性、task schema。

> **提示**：spotworkers 会按任务难度自动选 profile（`low → cheap`、`medium → standard`、`high → premium`）。如果想强制用某个 profile（比如你只有 MiniMax 凭证），给 `doctor` / `prepare` 传 `--profile minimax-m3`。

### 个人路由偏好（`callerProfiles`）

「从哪个模型起跳」是个人喜好，不该写死在共享仓库的 Agent 规则里。把它写在你自己的 `~/.config/pi-worker/config.json`，按调用方区分：

```json
{
  "callerProfiles": {
    "claude-code": "qoder-qwen-flash",
    "codex": "minimax-m3"
  }
}
```

不传 `--profile` 时的选择顺序：`--profile` → `callerProfiles[<调用方>]` → 按难度自动路由 → `defaultProfile`。调用方取自 `PARENT_AGENT`（见[调用方识别](#调用方识别)）；键必须是已知调用方、值必须是已有 profile，否则配置校验失败。首选 profile 沿用它自己的 `fallbackProfiles`，所以免费模型接力链（如 Qoder 免费 → CodeBuddy flash）每台机器配一次即可。首选 profile 缺任务所需能力/模态时自动跳过，且永远不会放行 `risk: high` 任务。不带 `--profile` 运行 `spot doctor` 会显示 `profileSource: caller-preference` 和将要使用的接力链。包自带的默认配置不设任何偏好。

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
spotworkers/
├── scripts/
│   ├── spot.mjs        # CLI 入口（bin）
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
