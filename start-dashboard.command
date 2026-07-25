#!/usr/bin/env bash
# Pi Worker 监控台一键启动器
# macOS: 双击此文件即可在浏览器中打开实时监控台
# Linux/通用: bash start-dashboard.command
#
# 启动后浏览器会自动打开 http://localhost:7317/
# 页面右上角"刷新"按钮拉取最新用量数据，或直接 F5
# Ctrl+C 停止服务

set -e

# 切到脚本所在目录（便于在仓库内回退到 npm link）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 颜色输出
say() { printf "\033[1;36m[pi-delegate]\033[0m %s\n" "$1"; }
warn() { printf "\033[1;33m[pi-delegate]\033[0m %s\n" "$1" >&2; }
err() { printf "\033[1;31m[pi-delegate]\033[0m %s\n" "$1" >&2; }

# 1. 检测 pi-worker 命令
if ! command -v pi-worker >/dev/null 2>&1; then
  # 仓库内回退：尝试本地的 scripts/pi-worker.mjs
  LOCAL_ENTRY="$SCRIPT_DIR/scripts/pi-worker.mjs"
  if [ -f "$LOCAL_ENTRY" ]; then
    say "未找到全局 pi-worker，使用本地仓库入口。"
    say "提示：运行 \\`npm link\\` 可注册全局命令。"
    PI_WORKER="node $LOCAL_ENTRY"
  else
    err "未找到 pi-worker 命令。"
    echo ""
    echo "请先安装："
    echo "  npm install -g pi-delegate"
    echo ""
    echo "或在本仓库内开发模式："
    echo "  npm link"
    echo ""
    read -r -p "按回车退出..." _
    exit 1
  fi
else
  PI_WORKER="pi-worker"
fi

# 2. 端口（支持环境变量覆盖）
PORT="${PI_WORKER_PORT:-7317}"

# 3. 启动 serve（默认会自动打开浏览器）
say "启动 Pi Worker 监控台 → http://localhost:${PORT}/"
say "页面右上角点击 \"刷新\" 按钮拉取最新用量，或直接 F5"
say "Ctrl+C 停止服务"
echo ""

# 捕获 Ctrl+C 给个友好提示
trap 'say "已停止。"; exit 0' INT

# shellcheck disable=SC2086
exec $PI_WORKER serve --port "$PORT"
