/*
 * pi-delegate - Parent-agent-owned OpenCode implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import os from 'node:os';
import path from 'node:path';
import { WorkerAdapter } from './base.mjs';

// OpenCode (anomalyco/opencode) CLI adapter.
//
// Non-interactive run (verified against the installed binary, v1.x):
//   opencode run "<prompt>" --dir <worktree> [--model <provider/model>] --auto --format json
//   - run          : one-shot headless execution, no TUI
//   - --dir        : working directory (project root)
//   - --model      : OPTIONAL. provider/model id. When omitted, OpenCode uses its
//                    own configured default model -- so a profile can leave `model`
//                    empty and still "just work" with zero per-task configuration.
//   - --auto       : auto-approve / skip permission prompts (the "yolo" equivalent)
//   - --format json: structured NDJSON events (one JSON object per line)
//   - --version    : prints the CLI version
//
// Credentials / model selection are intentionally NOT injected by pi-delegate:
// OpenCode manages its own providers + keys (configured once via `opencode
// providers login` / opencode.jsonc). The worker therefore runs with the real
// HOME so OpenCode can read its existing credentials, while `--dir` keeps the
// file scope limited to the isolated git worktree and `--auto` suppresses
// interactive permission prompts. `profile.apiKeyEnv` is OPTIONAL and only
// forwarded when present.
//
// Token usage IS emitted by `run`: each `step_finish` event carries
// `part.tokens: { total, input, output, reasoning, cache: { write, read } }`.
// We parse the last (cumulative) step_finish and normalize it.

const PASSTHROUGH_ENV = [
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
];

function selectedEnvironment(env, profile) {
  const selected = {
    CI: '1',
    NO_COLOR: '1',
    OPENCODE_DISABLE_TELEMETRY: '1',
  };
  for (const name of PASSTHROUGH_ENV) {
    if (env[name]) selected[name] = env[name];
  }
  // Optional: forward a provider credential if the profile declares one.
  const apiKey = profile.apiKeyEnv ? env[profile.apiKeyEnv] : undefined;
  if (apiKey) selected[profile.apiKeyEnv] = apiKey;
  return selected;
}

// Resolve the `--model` argument. Returns null when the profile does not pin a
// model, so OpenCode falls back to its configured default (zero-config path).
function resolveModelArg(profile) {
  const raw = (profile.model || '').trim();
  if (!raw || raw === 'auto' || raw === 'default') return null;
  // Accept either "hy3-free" (joined with provider) or a full "provider/model".
  if (raw.includes('/')) return raw;
  const provider = (profile.provider || '').trim();
  return provider ? `${provider}/${raw}` : raw;
}

// Best-effort parser for `opencode run --format json` NDJSON output.
//   - assistant text  : events of type "text" (part.text) + "result" (result)
//   - token usage     : events of type "step_finish" (part.tokens) -- take last
function parseRunOutput(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const textParts = [];
  let lastTokens = null;
  let sawJson = false;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
      sawJson = true;
    } catch {
      continue; // non-JSON line (log noise) -- ignore
    }
    if (!event || typeof event !== 'object') continue;
    const type = event.type;
    if (type === 'text' && typeof event?.part?.text === 'string') {
      textParts.push(event.part.text);
    } else if (type === 'result' && typeof event.result === 'string') {
      textParts.push(event.result);
    } else if (type === 'step_finish' && event?.part?.tokens) {
      lastTokens = event.part.tokens;
    }
  }
  const extracted = textParts.join('\n').trim();
  const usage = lastTokens
    ? {
        input: lastTokens.input ?? 0,
        output: lastTokens.output ?? 0,
        cacheRead: lastTokens.cache?.read ?? 0,
        cacheWrite: lastTokens.cache?.write ?? 0,
        reasoning: lastTokens.reasoning ?? 0,
        totalTokens: lastTokens.total ?? 0,
        cost: { total: lastTokens.cost ?? 0 },
      }
    : null;
  return { extracted, usage, sawJson };
}

export const OpenCodeAdapter = {
  ...WorkerAdapter,
  name: 'opencode',
  defaultBin: 'opencode',
  // When `opencode` is not on PATH, detection also probes these well-known
  // install locations so the CLI+model chooser can offer OpenCode even from a
  // shell that hasn't exported its bin directory.
  candidateBins: [
    path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
  ],
  configDirName: '.config/opencode',
  configFormat: 'json',
  supportsStreaming: false, // `run --format json` emits all events at once (one-shot)
  supportsTokenUsage: true, // parsed from step_finish events
  supportsModelList: true, // `opencode models` enumerates available models
  minimumVersion: null, // version scheme is 1.x; doctor skips the gate

  versionCommand() {
    return { argv: ['--version'], env: {} };
  },

  invokeCommand({ state, profile, prompt, config, sessionDir, mode }) {
    // OpenCode `run` takes the prompt as a positional arg.
    // Known limitation: the prompt leaks onto argv; all secrets stay off argv
    // via selectedEnvironment / optional apiKeyEnv. This matches the Kimi adapter.
    const argv = ['run', prompt, '--dir', state.worktreePath, '--auto', '--format', 'json'];
    const modelArg = resolveModelArg(profile);
    if (modelArg) argv.push('--model', modelArg);
    return { argv, input: '', cwd: state.worktreePath };
  },

  parseOutput(rawStdout, rawStderr, exitCode, timedOut) {
    const { extracted, usage, sawJson } = parseRunOutput(rawStdout);
    // Fall back to raw stdout when no structured text was extracted.
    const text = extracted || (rawStdout || '').trim();
    const stopReason = exitCode === 0
      ? 'stop'
      : (timedOut ? 'timeout' : 'error');
    return {
      text,
      usage,
      sawJson,
      stopReason,
      lastAssistant: { content: text, usage: usage ?? undefined },
    };
  },

  // Real HOME (not isolated) so OpenCode can read its own configured providers
  // and credentials. `--dir` already confines file access to the worktree and
  // `--auto` suppresses permission prompts.
  async sanitizeHome({ paths, files, profile, env }) {
    return {
      home: env.HOME,
      env: selectedEnvironment(env, profile),
    };
  },

  async listModels({ paths, profile, env, bin }) {
    // `opencode models` lists every available provider/model id, one per line
    // (e.g. "opencode/hy3-free", "minimax/MiniMax-M3").
    return {
      argv: ['models'],
      env: selectedEnvironment(env, profile),
      parse(stdout) {
        const models = String(stdout || '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((id) => ({ id, label: id }));
        return models;
      },
    };
  },
};
