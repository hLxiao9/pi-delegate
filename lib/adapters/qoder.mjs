/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkerAdapter } from './base.mjs';
import {
  refreshCatalog,
  readCatalogSync,
  resolveModelAlias,
  findModel,
  resolveEffort,
  resolveContextWindow,
  formatCatalog,
  sortByPrice,
} from '../qoder-catalog.mjs';

// Qoder CN CLI characteristics (verified against qoderclicn 1.1.73):
// - Personal Access Token authentication via QODERCN_PERSONAL_ACCESS_TOKEN.
//   PITFALL: the international variable QODER_PERSONAL_ACCESS_TOKEN is IGNORED by
//   the CN build. Setting it leaves every run at "Not logged in · Please run /login";
//   only the CN-named variable is read and validated.
// - non-interactive mode REQUIRES -p/--print. Without it the CLI defaults to the
//   interactive TUI, so the worker hangs until the runner timeout. The prompt goes
//   over stdin (no positional argument) to keep argv clean in ps / cmdline.
// - --output-format=json prints ONE object:
//   { type:'result', result, is_error, usage{input_tokens,...}, total_cost_usd,
//     num_turns, duration_ms, session_id, stop_reason }
//   so token usage IS available -> supportsTokenUsage: true.
// - --yolo and --max-turns are accepted although absent from --help (hidden flags).
// - --allowed-tools takes a comma-separated tool list.
// - config directory: ~/.qoder-cn/ (QODERCN_CONFIG_DIR overrides the config root).
// - --list-models exists but needs a live login, so it is not used for dispatch.
// - PITFALL: an invalid PAT fails with "QoderAuthError: ... token that was rejected"
//   on stderr and EMPTY stdout. The base classifier would call that 'permanent';
//   classifyFailure maps it to 'auth' so the runner reports a login problem.

const PASSTHROUGH_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

// Qoder tool names are capitalized like Trae's.
// Bash is intentionally excluded (same policy as the Trae/CodeBuddy adapters):
// the worker only edits files inside its worktree; verification runs in the parent.
const QODER_ALLOWED_TOOLS = ['Read', 'Write', 'Grep', 'Glob', 'Edit', 'MultiEdit'];

const AUTH_PATTERN = /qoderautherror|token that was rejected|not logged in|please run \/login/i;

function selectedEnvironment(env, qoderHome, profile) {
  const selected = { HOME: qoderHome, CI: '1', NO_COLOR: '1' };
  for (const name of PASSTHROUGH_ENV) if (env[name]) selected[name] = env[name];
  // Qoder uses environment variable authentication.
  const tokenEnv = profile.apiKeyEnv || 'QODERCN_PERSONAL_ACCESS_TOKEN';
  if (env[tokenEnv]) selected[tokenEnv] = env[tokenEnv];
  return selected;
}

// Maps the CLI's snake_case usage block onto the metrics shape.
// PITFALL: Qoder CN reports every `usage.*_tokens` counter as 0 and bills in
// `total_credits` instead, so a token-only emptiness check would throw away the
// one number the provider actually measures. `totalCredits` is carried as its
// own field rather than folded into providerReportedCostUsd (a credit is not a
// dollar).
function usageFrom(raw, totalCostUsd, totalCredits, numTurns, durationMs) {
  if (!raw || typeof raw !== 'object') {
    return (totalCredits ?? 0) > 0
      ? { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, providerReportedCostUsd: totalCostUsd ?? 0, totalCredits, requests: numTurns ?? 1, durationMs: durationMs ?? 0 }
      : null;
  }
  const input = raw.input_tokens ?? 0;
  const output = raw.output_tokens ?? 0;
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  const cacheWrite = raw.cache_creation_input_tokens ?? 0;
  const credits = totalCredits ?? 0;
  if (!input && !output && !cacheRead && !cacheWrite && !credits) return null;
  return {
    inputTokens: input,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: 0,
    totalTokens: input + output + cacheRead + cacheWrite,
    providerReportedCostUsd: totalCostUsd ?? 0,
    totalCredits: credits,
    requests: numTurns ?? 1,
    durationMs: durationMs ?? 0,
  };
}

// The runner normalizes `lastAssistant.usage` itself, and `normalizeUsage()`
// reads the RAW Pi-shaped keys (input/output/cacheRead/cacheWrite/cost.total).
// Handing it the already-normalized `inputTokens` shape silently zeroes every
// counter, so the raw shape is returned alongside the normalized one.
function rawUsageFrom(raw, totalCostUsd, totalCredits) {
  const credits = totalCredits ?? 0;
  const hasRaw = raw && typeof raw === 'object';
  const input = hasRaw ? (raw.input_tokens ?? 0) : 0;
  const output = hasRaw ? (raw.output_tokens ?? 0) : 0;
  const cacheRead = hasRaw ? (raw.cache_read_input_tokens ?? 0) : 0;
  const cacheWrite = hasRaw ? (raw.cache_creation_input_tokens ?? 0) : 0;
  if (!input && !output && !cacheRead && !cacheWrite && !credits) return null;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: 0,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { total: totalCostUsd ?? 0 },
    credits,
  };
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
  return '';
}

// Parses qoderclicn --output-format=json output. The shape may be a JSON array
// (older builds) or a single object (verified 1.1.73).
// Returns { text, usage, isError } or null when nothing parses.
function parseQoderJsonOutput(rawStdout) {
  let parsed;
  try {
    parsed = JSON.parse(rawStdout);
  } catch {
    return null;
  }
  const events = Array.isArray(parsed) ? parsed : [parsed];
  if (events.length === 0) return null;

  let text = '';
  let usage = null;
  let rawUsage = null;
  let isError = false;

  for (const item of events) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'result') {
      if (typeof item.result === 'string') text = item.result;
      if (item.is_error === true || (typeof item.subtype === 'string' && item.subtype.startsWith('error'))) isError = true;
      usage = usageFrom(item.usage, item.total_cost_usd, item.total_credits, item.num_turns, item.duration_ms) ?? usage;
      rawUsage = rawUsageFrom(item.usage, item.total_cost_usd, item.total_credits) ?? rawUsage;
    } else if (item.role === 'assistant' || item.type === 'assistant' || item.message?.role === 'assistant') {
      const t = textFromContent(item.message?.content ?? item.content ?? item.text);
      if (t) text = t;
    }
  }

  // Fallback for shapes without a typed event.
  if (!text) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const item = events[i];
      if (typeof item?.text === 'string' && item.text.length > 0) { text = item.text; break; }
      if (typeof item?.content === 'string' && item.content.length > 0) { text = item.content; break; }
    }
  }

  return { text, usage, rawUsage, isError };
}

export const QoderAdapter = {
  ...WorkerAdapter,
  name: 'qoder',
  defaultBin: 'qoderclicn',
  configDirName: '.qoder-cn',
  configFormat: 'json',
  supportsStreaming: false,  // json mode is enough; stream-json format not verified
  supportsTokenUsage: true,  // verified: json result carries usage + total_cost_usd
  supportsModelList: true,   // `--list-models` returns one model name per line (needs a live login)
  minimumVersion: null,

  versionCommand() {
    return { argv: ['--version'], env: {} };
  },

  invokeCommand({ state, profile, prompt, config, paths }) {
    // -p/--print is mandatory: without it qoderclicn starts the interactive TUI.
    // The prompt is piped over stdin to avoid argv leakage (ps / cmdline).
    const argv = [
      '-p',
      '--output-format=json',
      '--yolo',
      '--allowed-tools', QODER_ALLOWED_TOOLS.join(','),
    ];
    const warnings = [];
    // The catalog is read from the on-disk cache (populated by sanitizeHome)
    // because this method is synchronous. `null` simply disables the price
    // alias and the capability validation — dispatch must never depend on a
    // network round-trip having succeeded.
    const catalog = paths ? readCatalogSync(paths) : null;
    const models = catalog?.models ?? null;

    // Model pinning: `-m/--model` takes the model NAME shown by --list-models
    // (e.g. Qwen3.8-Flash, DeepSeek-Flash, Kimi-K3). Skip the profile placeholder
    // so an unpinned run keeps the CLI's own default (Auto).
    //
    // The pseudo-name `free` (also `qoder-free` / `cheapest`) resolves to the
    // lowest price_factor the account can currently reach, so a caller can ask
    // for "whatever costs nothing right now" without hardcoding a roster that
    // changes weekly.
    const requestedModel = typeof profile.model === 'string' ? profile.model.trim() : '';
    const isPlaceholder = !requestedModel || requestedModel === 'qoder-default' || requestedModel.toLowerCase() === 'default';
    let model = '';
    if (!isPlaceholder) {
      const resolved = resolveModelAlias(requestedModel, models);
      model = resolved.model;
      if (resolved.note) warnings.push(resolved.note);
    }
    if (model) {
      argv.push('-m', model);
    }

    // Thinking depth and context window are validated against the SELECTED
    // model, because both are per-model: DeepSeek-Flash rejects `xhigh`, and
    // context windows are published as discrete tiers rather than a range.
    const pinnedModel = model ? findModel(model, models) : null;

    // A per-invocation env var overrides the profile so one run can differ
    // without editing config.json.
    const requestedEffort = String(
      process.env.PI_WORKER_QODER_REASONING_EFFORT ?? profile.reasoningEffort ?? '',
    ).trim();
    if (requestedEffort) {
      const effort = resolveEffort(requestedEffort, pinnedModel);
      if (effort.note) warnings.push(effort.note);
      if (effort.effort) argv.push('--reasoning-effort', effort.effort);
    }

    // Reuses the existing maxContextSize profile field; env var wins for one-off runs.
    const requestedWindow = String(
      process.env.PI_WORKER_QODER_CONTEXT_WINDOW ?? profile.maxContextSize ?? '',
    ).trim();
    if (requestedWindow) {
      const window = resolveContextWindow(requestedWindow, pinnedModel);
      if (window.note) warnings.push(window.note);
      if (window.contextWindow) argv.push('--context-window', window.contextWindow);
    }

    // max-turns limits prevent infinite loops (hidden flag, accepted by 1.1.73).
    if (config.limits?.piMaxTurns) {
      argv.push('--max-turns', String(config.limits.piMaxTurns));
    }
    return { argv, input: prompt, cwd: state.worktreePath, warnings };
  },

  parseOutput(rawStdout, rawStderr, exitCode, timedOut) {
    const parsed = parseQoderJsonOutput(rawStdout);
    // fallback: JSON on parse failure directly use stdout text
    const text = parsed?.text || rawStdout.trim();
    let stopReason = 'stop';
    if (timedOut) stopReason = 'timeout';
    else if (exitCode !== 0 || parsed?.isError) stopReason = 'error';
    return {
      text,
      usage: parsed?.usage ?? null,
      stopReason,
      // lastAssistant.usage must stay in the RAW Pi shape: the runner pipes it
      // through normalizeUsage(), which reads input/output/cacheRead/cost.total.
      lastAssistant: { content: text, stopReason, usage: parsed?.rawUsage ?? undefined },
    };
  },

  classifyFailure(args) {
    if (AUTH_PATTERN.test(`${args.stderr}\n${args.stdout}`)) return 'auth';
    return WorkerAdapter.classifyFailure(args);
  },

  async sanitizeHome({ paths, files, profile, env }) {
    // creates isolated ~/.qoder-cn directory
    // Qoder authentication token passed via environment variable, no need to write config file
    const qoderHome = path.join(files.directory, 'qoder-home');
    const qoderCnDir = path.join(qoderHome, '.qoder-cn');
    await mkdir(qoderCnDir, { recursive: true });
    // Warm the price/capability catalog here because invokeCommand is
    // synchronous and must not block on the network. Cache-first, so this costs
    // one request per TTL window at most, and a failure is non-fatal.
    if (paths?.cacheRoot) {
      await refreshCatalog({ paths, env: { ...env, ...selectedEnvironment(env, qoderHome, profile) }, profile });
    }
    return { home: qoderHome, env: selectedEnvironment(env, qoderHome, profile) };
  },

  // The cloud catalog replaces `--list-models` for enumeration: the CLI prints a
  // bare name column (no price, no capability tiers) AND needs a live login,
  // whereas the API returns price_factor, efforts and context windows. Adapters
  // may return pre-resolved `models` instead of an argv spec; environment.mjs
  // and doctor.mjs understand both shapes.
  async listModels({ paths, profile, env }) {
    if (!paths?.cacheRoot) return null;
    const catalog = await refreshCatalog({ paths, env, profile });
    const models = catalog?.models ?? [];
    if (models.length === 0) return null;
    // `id` is what detect/choosers key on, so expose the display name there —
    // the opaque catalog id (qfmodel, dfmodel) means nothing to a user and `-m`
    // does not accept it. Cheapest first so a human sees the free models first.
    return { models: sortByPrice(models).map((m) => ({ ...m, id: m.name })) };
  },

  // Human-readable roster with price multipliers, used by detect/doctor.
  formatModels(models) {
    return formatCatalog(models);
  },
};
