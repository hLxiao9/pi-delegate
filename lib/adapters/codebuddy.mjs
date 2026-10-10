/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import os from 'node:os';
import { WorkerAdapter } from './base.mjs';

// CodeBuddy Code CLI (npm: @tencent-ai/codebuddy-code) characteristics:
// - OAuth login via interactive `codebuddy` then `/login`; credentials live under
//   CODEBUDDY_CONFIG_DIR (default ~/.codebuddy).
// - PITFALL: the copy bundled inside WorkBuddy.app is a headless-only build that
//   cannot log in by itself (WorkBuddy injects auth); do not use it as the worker.
// - non-interactive mode: codebuddy -p --output-format stream-json, prompt on stdin
// - PITFALL: --output-format json dumps the whole transcript (system prompt
//   included, >17KB even for a trivial task), which overflows the runner's
//   tail-kept capture; stream-json ends with a small `result` line that survives.
// - --tools restricts the built-in tool set; -y skips permission prompts
// - --model <id> (auto, glm-5.1, kimi-k2.5, deepseek-v3-2-volc, ...); no list-models command
// - --max-turns limits agentic turns
// - PITFALL: an unauthenticated run prints "Authentication required" and still exits 0,
//   so parseOutput must flag it as an error instead of trusting the exit code.

const PASSTHROUGH_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

// Bash is intentionally excluded (same policy as the Trae/Qoder adapters): the
// worker only edits files inside its worktree; verification runs in the parent.
const CODEBUDDY_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write'];

const AUTH_PATTERN = /authentication required|please use \/login|not logged in/i;

function selectedEnvironment(env) {
  // PITFALL: HOME must stay the real one. The OAuth credential is not fully
  // inside ~/.codebuddy (likely the macOS keychain, located via HOME); with an
  // isolated HOME, even CODEBUDDY_CONFIG_DIR=~/.codebuddy yields
  // "Authentication required". The env itself is still allowlisted.
  const selected = { HOME: env.HOME || os.homedir(), CI: '1', NO_COLOR: '1' };
  for (const name of [...PASSTHROUGH_ENV, 'CODEBUDDY_CONFIG_DIR']) if (env[name]) selected[name] = env[name];
  return selected;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
  return '';
}

function usageFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw.input_tokens ?? raw.inputTokens ?? raw.input ?? 0;
  const output = raw.output_tokens ?? raw.outputTokens ?? raw.output ?? 0;
  const cacheRead = raw.cache_read_input_tokens ?? raw.cacheRead ?? 0;
  const cacheWrite = raw.cache_creation_input_tokens ?? raw.cacheWrite ?? 0;
  if (!input && !output) return null;
  return { input, output, cacheRead, cacheWrite, reasoning: 0, totalTokens: input + output + cacheRead + cacheWrite, cost: { total: raw.total_cost_usd ?? 0 } };
}

function parseEvents(rawStdout) {
  try {
    const parsed = JSON.parse(rawStdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {}
  // NDJSON (stream-json). The capture keeps the tail, so the first line may be
  // a cut-off fragment; skip lines that do not parse.
  const events = [];
  for (const line of rawStdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { events.push(JSON.parse(trimmed)); } catch {}
  }
  return events.length > 0 ? events : null;
}

// Parses stream-json NDJSON (or a json array / single object). The decisive
// event is { type: 'result', result, is_error, usage, total_cost_usd };
// returns { text, usage, isError } or null when nothing parses.
export function parseCodeBuddyJsonOutput(rawStdout) {
  const events = parseEvents(rawStdout);
  if (!events) return null;
  let text = '';
  let usage = null;
  let isError = false;
  for (const item of events) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'result') {
      if (typeof item.result === 'string') text = item.result;
      if (item.is_error === true || (typeof item.subtype === 'string' && item.subtype.startsWith('error'))) isError = true;
      usage = usageFrom(item.usage ? { ...item.usage, total_cost_usd: item.total_cost_usd } : null) ?? usage;
    } else if (item.type === 'assistant' || item.role === 'assistant' || item.message?.role === 'assistant') {
      const t = textFromContent(item.message?.content ?? item.content ?? item.text);
      if (t) text = t;
    }
  }
  return { text, usage, isError };
}

export const CodeBuddyAdapter = {
  ...WorkerAdapter,
  name: 'codebuddy',
  defaultBin: 'codebuddy',
  configDirName: '.codebuddy',
  configFormat: 'none',
  supportsStreaming: false,
  supportsTokenUsage: true,
  supportsModelList: false,
  minimumVersion: null,

  versionCommand() {
    return { argv: ['--version'], env: {} };
  },

  invokeCommand({ state, profile, prompt, config }) {
    // prompt goes over stdin to avoid argv leakage (ps / /proc/<pid>/cmdline)
    const argv = ['-p', '--output-format', 'stream-json', '-y', '--tools', CODEBUDDY_TOOLS.join(',')];
    if (profile.model && !['codebuddy-default', 'default'].includes(profile.model)) {
      argv.push('--model', profile.model);
    }
    if (config.limits?.piMaxTurns) argv.push('--max-turns', String(config.limits.piMaxTurns));
    if (state.runId) argv.push('--no-session-persistence');
    return { argv, input: prompt, cwd: state.worktreePath };
  },

  parseOutput(rawStdout, rawStderr, exitCode, timedOut) {
    const parsed = parseCodeBuddyJsonOutput(rawStdout);
    const text = parsed?.text || rawStdout.trim();
    const authFailed = AUTH_PATTERN.test(`${rawStdout}\n${rawStderr}`) && !parsed?.text;
    let stopReason = 'stop';
    if (timedOut) stopReason = 'timeout';
    else if (exitCode !== 0 || authFailed || parsed?.isError || !parsed) stopReason = 'error';
    return { text, usage: null, stopReason, lastAssistant: { content: text, stopReason, usage: parsed?.usage ?? undefined } };
  },

  classifyFailure(args) {
    if (AUTH_PATTERN.test(`${args.stderr}\n${args.stdout}`)) return 'auth';
    return WorkerAdapter.classifyFailure(args);
  },

  async sanitizeHome({ env }) {
    const selected = selectedEnvironment(env);
    return { home: selected.HOME, env: selected };
  },

  async listModels() {
    return null;
  },

  checkAuthHint() {
    return {
      requiresManualLogin: true,
      loginCommand: 'codebuddy',
      loginHint: 'CodeBuddy CLI needs its own OAuth login (separate from the WorkBuddy app). Run `codebuddy` once interactively and use /login.',
    };
  },
};
