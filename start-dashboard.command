#!/usr/bin/env bash
# Pi Worker Dashboard one-click launcher
# macOS: double-click this file to open the live dashboard in your browser
# Linux/generic: bash start-dashboard.command
#
# After startup the browser will open http://localhost:7317/
# top-right of the page"Refresh"button to fetch the latest usage data, or directly F5
# Ctrl+C stop the service

set -e

# Switch to the script directory(to allow falling back to npm link)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Color output
say() { printf "\033[1;36m[pi-delegate]\033[0m %s\n" "$1"; }
warn() { printf "\033[1;33m[pi-delegate]\033[0m %s\n" "$1" >&2; }
err() { printf "\033[1;31m[pi-delegate]\033[0m %s\n" "$1" >&2; }

# 1. Detect pi-worker command
if ! command -v pi-worker >/dev/null 2>&1; then
  # In-repo fallback: Try the local scripts/pi-worker.mjs
  LOCAL_ENTRY="$SCRIPT_DIR/scripts/pi-worker.mjs"
  if [ -f "$LOCAL_ENTRY" ]; then
  say "Global not found pi-worker, using local repo entry."
  say "Hint: run \\`npm link\\` can register the global command."
  PI_WORKER="node $LOCAL_ENTRY"
  else
  err "not found pi-worker command."
  echo ""
  echo "Please install first: "
  echo "  npm install -g pi-delegate"
  echo ""
  echo "Or in development mode within this repo: "
  echo "  npm link"
  echo ""
  read -r -p "Press Enter to exit..." _
  exit 1
  fi
else
  PI_WORKER="pi-worker"
fi

# 2. Port(supports environment variable override)
PORT="${PI_WORKER_PORT:-7317}"

# 3. start serve(browser auto-opens by default)
say "Starting Pi Worker Dashboard → http://localhost:${PORT}/"
say "Click at the top-right of the page \"Refresh\" button to fetch the latest usage, or directly F5"
say "Ctrl+C stop the service"
echo ""

# Catch Ctrl+C for a friendly message
trap 'say "Stopped."; exit 0' INT

# Load export statements from user shell profile(API keys etc.)
# Solves the issue of missing environment variables when starting from GUI/non-interactive shell startup missing environment variables issue
load_shell_exports() {
  local exports=""
  for f in "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile"; do
  [ -f "$f" ] || continue
  # Only extract export NAME=value lines,to avoid zsh/bash specific syntax errors
  exports+="$(grep -E '^\s*export\s+[A-Z_][A-Z0-9_]*=' "$f" 2>/dev/null)"
  done
  [ -n "$exports" ] && eval "$exports" 2>/dev/null || true
}
load_shell_exports

# shellcheck disable=SC2086
exec $PI_WORKER serve --port "$PORT"
