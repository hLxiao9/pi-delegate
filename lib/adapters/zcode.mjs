/*
 * spotworkers - Delegate bounded coding tasks to cheap agent workers
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { WorkerAdapter } from './base.mjs';

// ZCode CLI characteristics (verified against zcode 0.17.0, Zhipu/Z.ai's open
// coding workbench; the desktop app bundles the same CLI at
// ZCode.app/Contents/Resources/glm/zcode.cjs):
// - Auth is the desktop app's shared Z.AI login (OAuth) — no env-var token, so
//   the profile omits apiKeyEnv and sanitizeHome deliberately KEEPS the real
//   HOME: a sanitized home would hide ~/.zcode and every run would be logged
//   out. Sessions are written to ~/.zcode, which is acceptable for a local CLI.
// - Headless mode is `-p/--prompt <text>`; the prompt goes in ARGV because the
//   CLI ignores stdin in print mode (unlike qoder). Same trade-off as the Kimi
//   adapter: the prompt is visible in `ps`, which is fine for a local worker.
// - `--json` prints one machine-readable object:
//   { sessionId, response, usage{inputTokens, outputTokens, cacheReadTokens,
//     cacheWriteTokens, reasoningTokens, modelRequestCount}, eventCount, ... }
//   Token usage IS reported (unlike Qoder CN's all-zero counters) ->
//   supportsTokenUsage: true.
// - Tool policy: `--disallowed-tools Bash` keeps the worker from running shell
//   commands (the worktree is edited via Read/Write/Edit; verification runs in
//   the parent). `--mode yolo` avoids interactive permission prompts that would
//   hang a headless run.
// - There is NO `--model` flag in 0.17.0: the model is the persisted
//   `defaultModelSelection` from the TUI (`/model`; free tier defaults to
//   GLM-5.3-Flash). A pinned profile model is therefore downgraded to a
//   recorded warning instead of being silently ignored.
// - PITFALL: running the app-bundled zcode.cjs directly fails with
//   "无法定位 CLI ZCode Built-in Provider Config" because the packaged config
//   sits at Resources/config/provider/, not glm/provider/. Install the CLI on
//   PATH (or shim it) instead of pointing PI_WORKER_ZCODE_BIN into the bundle.
// - PITFALL: a stale provider-refresh lock
//   (~/.zcode/v2/runtime/provider/**/zcode-builtin-refresh.json.lock) makes the
//   CLI print "ZCode Built-in 刷新失败: EEXIST" on stderr; the run itself still
//   succeeds, so it must not be classified as an error.

const PASSTHROUGH_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ZCODE_AGENT_CA_CERT'];

// Tools the worker must never get. Bash is the shell hole; everything else the
// CLI offers (web search, browser) is harmless for a bounded diff but also
// useless without a shell, so only Bash is removed explicitly.
const DISALLOWED_TOOLS = ['Bash'];

const AUTH_PATTERN = /not logged in|please run zcode login|login required|未登录|请先登录|登录已过期/i;
const INSTALL_PATTERN = /无法定位 CLI ZCode Built-in Provider Config|provider\/zcode-builtin\.json/i;

function selectedEnvironment(env) {
  // HOME is intentionally NOT sanitized: the shared Z.AI login lives there.
  return { ...env, CI: '1', NO_COLOR: '1' };
}

// Maps the CLI's camelCase usage block onto the metrics shape. Every counter
// can be present; an all-zero block still returns a usage object so metrics
// can distinguish "provider reported nothing" (null) from "free tier, zero
// billable tokens" (zeros).
function usageFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw.inputTokens ?? 0;
  const output = raw.outputTokens ?? 0;
  const cacheRead = raw.cacheReadTokens ?? 0;
  const cacheWrite = raw.cacheWriteTokens ?? 0;
  return {
    inputTokens: input,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: raw.reasoningTokens ?? 0,
    totalTokens: raw.totalTokens ?? (input + output + cacheRead + cacheWrite),
    providerReportedCostUsd: 0,
    totalCredits: 0,
    requests: raw.modelRequestCount ?? 1,
    durationMs: 0,
  };
}

// Raw Pi shape for lastAssistant.usage (the runner's normalizeUsage() reads
// input/output/cacheRead/cacheWrite/cost.total).
function rawUsageFrom(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw.inputTokens ?? 0;
  const output = raw.outputTokens ?? 0;
  const cacheRead = raw.cacheReadTokens ?? 0;
  const cacheWrite = raw.cacheWriteTokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: raw.reasoningTokens ?? 0,
    totalTokens: raw.totalTokens ?? (input + output + cacheRead + cacheWrite),
    cost: { total: 0 },
    credits: 0,
  };
}

// Parses `zcode -p ... --json` output. The happy path is a single JSON object,
// but stderr warnings must never leak into stdout, and a leading banner would
// break a bare JSON.parse — so fall back to the first `{` ... last `}` slice.
// Returns { text, usage, rawUsage, isError } or null when nothing parses.
function parseZcodeJsonOutput(rawStdout) {
  const trimmed = rawStdout.trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const text = typeof parsed.response === 'string' ? parsed.response : '';
  const usage = usageFrom(parsed.usage);
  const rawUsage = usage ? rawUsageFrom(parsed.usage) : undefined;
  const isError = parsed.is_error === true || typeof parsed.error === 'string';
  return { text, usage, rawUsage, isError };
}

export const ZcodeAdapter = {
  ...WorkerAdapter,
  name: 'zcode',
  defaultBin: 'zcode',
  configDirName: '.zcode',
  configFormat: 'json',
  supportsStreaming: false,  // --json is one-shot; no stream format verified
  supportsTokenUsage: true,  // verified: --json carries per-run token usage
  supportsModelList: false,  // no model enumeration; selection lives in the TUI
  minimumVersion: null,

  versionCommand() {
    return { argv: ['--version'], env: {} };
  },

  invokeCommand({ state, profile, prompt, config }) {
    const argv = [
      '--mode', 'yolo',
      '--disallowed-tools', DISALLOWED_TOOLS.join(','),
      '--json',
    ];
    const warnings = [];
    // No --model flag exists in 0.17.0: the model is the TUI's persisted
    // defaultModelSelection. Say so instead of silently ignoring a pin.
    const requestedModel = typeof profile.model === 'string' ? profile.model.trim() : '';
    if (requestedModel) {
      warnings.push(`zcode CLI has no --model flag; the model comes from the TUI's defaultModelSelection (profile pinned "${requestedModel}" is ignored)`);
    }
    void config;
    // The prompt travels in argv because print mode ignores stdin (same
    // trade-off as the Kimi adapter; visible in `ps`, acceptable locally).
    return { argv: [...argv, '-p', prompt], input: '', cwd: state.worktreePath, warnings };
  },

  parseOutput(rawStdout, rawStderr, exitCode, timedOut) {
    const parsed = parseZcodeJsonOutput(rawStdout);
    const text = parsed?.text || rawStdout.trim();
    let stopReason = 'stop';
    if (timedOut) stopReason = 'timeout';
    else if (exitCode !== 0 || parsed?.isError) stopReason = 'error';
    return {
      text,
      usage: parsed?.usage ?? null,
      stopReason,
      lastAssistant: { content: text, stopReason, usage: parsed?.rawUsage },
    };
  },

  classifyFailure(args) {
    const text = `${args.stderr}\n${args.stdout}`;
    if (AUTH_PATTERN.test(text)) return 'auth';
    // A broken packaging/provider-config install is not retryable.
    if (INSTALL_PATTERN.test(text)) return 'permanent';
    return WorkerAdapter.classifyFailure(args);
  },

  async sanitizeHome({ env }) {
    // KEEP the real HOME: the shared Z.AI OAuth credentials live under ~/.zcode
    // (and the system keychain), so a sanitized home logs every run out. The
    // trade-off is that the worker CLI sees the user's real profile — the same
    // trust level as the desktop app itself.
    return { home: env.HOME, env: selectedEnvironment(env) };
  },

  // No model enumeration: selection is the TUI's persisted default. doctor
  // skips the model check for adapters that return null.
  async listModels() {
    return null;
  },
};
