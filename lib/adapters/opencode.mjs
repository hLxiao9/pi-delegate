/*
 * pi-delegate - Parent-agent-owned OpenCode implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { invariant } from '../errors.mjs';
import { WorkerAdapter } from './base.mjs';

// OpenCode (opencode-ai/opencode) CLI adapter.
//
// Non-interactive run (verified against docs for v0.0.55):
//   opencode run "<prompt>" --dir <worktree> --model <provider/model> --auto --format json
//   - run          : one-shot headless execution, no TUI
//   - --dir        : working directory (project root) -- verified flag name
//   - --model      : provider/model id selection
//   - --auto       : auto-approve / skip permission prompts (the "yolo" equivalent)
//   - --format json: structured output (single JSON object, NOT NDJSON stream)
//   - --version    : prints the CLI version
//
// NOTE: token usage is NOT emitted by `run`. OpenCode exposes cost via the
// separate `opencode stats` command, so supportsTokenUsage is false and the
// cost-saving metric gracefully degrades (same as Kimi/Trae).
//
// Credentials are supplied via the provider's standard env var (e.g.
// OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY). profile.apiKeyEnv must
// name that variable; sanitizeHome forwards it into the isolated HOME env.
// We deliberately do NOT write an opencode.json config file: the `--auto`
// flag already grants auto-approval, and the exact config schema differs by
// version -- writing a wrong-shape file would break startup. Add a config
// file here only after confirming the schema for the installed version.

const PASSTHROUGH_ENV = [
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
];

function selectedEnvironment(env, opencodeHome, profile) {
  const selected = {
    HOME: opencodeHome,
    CI: '1',
    NO_COLOR: '1',
    OPENCODE_DISABLE_TELEMETRY: '1',
  };
  for (const name of PASSTHROUGH_ENV) {
    if (env[name]) selected[name] = env[name];
  }
  // Forward the provider credential OpenCode expects (e.g. OPENAI_API_KEY).
  const apiKey = env[profile.apiKeyEnv];
  if (apiKey) selected[profile.apiKeyEnv] = apiKey;
  return selected;
}

// Best-effort text extraction for `opencode run --format json`.
// `--format json` emits "raw JSON events" (one JSON object per line, NDJSON).
// The exact event schema varies by version, so we do a bounded recursive walk
// collecting string values under the common leaf keys (text / result / content/
// message) rather than assuming a fixed shape. This also covers a single
// non-streamed JSON object.
const TEXT_KEYS = new Set(['text', 'result', 'content', 'message']);

function collectTextLeaves(node, out, depth = 0) {
  if (depth > 12 || out.length > 200) return;
  if (typeof node === 'string') {
    // Only push when reached as a top-level value (not under a non-text key).
    if (depth === 0) {
      const t = node.trim();
      if (t) out.push(t);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectTextLeaves(item, out, depth + 1);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (TEXT_KEYS.has(key) && typeof value === 'string' && value.trim()) {
        out.push(value.trim());
      } else {
        // recurse into non-text values to find nested text-bearing keys
        collectTextLeaves(value, out, depth + 1);
      }
    }
  }
}

function extractTextFromJson(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const found = [];
  for (const line of lines) {
    try {
      collectTextLeaves(JSON.parse(line), found);
    } catch {
      // not a JSON line (e.g. a log line) -> ignore
    }
  }
  return found.join('\n').trim();
}

export const OpenCodeAdapter = {
  ...WorkerAdapter,
  name: 'opencode',
  defaultBin: 'opencode',
  configDirName: '.config/opencode',
  configFormat: 'json',
  supportsStreaming: false,  // `run --format json` is a single JSON object, not a stream
  supportsTokenUsage: false, // usage only via `opencode stats`, not `run`
  supportsModelList: false,  // no stable `--list-models`; doctor skips the check
  minimumVersion: null,      // version scheme is 1.x (anomalyco/opencode); doctor skips the gate

  versionCommand() {
    return { argv: ['--version'], env: {} };
  },

  invokeCommand({ state, profile, prompt, config, sessionDir, mode }) {
    // OpenCode `run` takes the prompt as a positional arg (like Kimi's -p).
    // Known limitation: the prompt leaks onto argv; all other secrets stay off
    // argv via selectedEnvironment / apiKeyEnv. This matches the Kimi adapter.
    const argv = [
      'run',
      prompt,
      '--dir', state.worktreePath,
      '--model', `${profile.provider}/${profile.model}`,
      '--auto',
      '--format', 'json',
    ];
    return { argv, input: '', cwd: state.worktreePath };
  },

  parseOutput(rawStdout, rawStderr, exitCode, timedOut) {
    const trimmed = (rawStdout || '').trim();
    // Prefer structured JSON extraction; fall back to raw stdout as-is.
    const text = trimmed ? (extractTextFromJson(trimmed) || trimmed) : trimmed;
    const stopReason = exitCode === 0
      ? 'stop'
      : (timedOut ? 'timeout' : 'error');
    // usage stays null -> metrics degrade gracefully
    return { text, usage: null, stopReason, lastAssistant: { content: text } };
  },

  async sanitizeHome({ paths, files, profile, env }) {
    // Isolated HOME so OpenCode cannot read the host user's real config/keys.
    const opencodeHome = path.join(files.directory, 'opencode-home');
    await mkdir(opencodeHome, { recursive: true });

    const apiKeyValue = env[profile.apiKeyEnv];
    invariant(
      apiKeyValue,
      'PI_FAILED',
      `Missing provider credential: ${profile.apiKeyEnv}`,
      { category: 'auth' },
    );

    // Forward-compat: copy the host OpenCode config (providers/models) into the
    // isolated HOME so the user's existing OpenCode setup is reused once they
    // configure it. Harmless when absent/empty (host currently has only a stub).
    const hostCfg = path.join(env.HOME || '', '.config', 'opencode', 'opencode.jsonc');
    const isolatedCfgDir = path.join(opencodeHome, '.config', 'opencode');
    try {
      await copyFile(hostCfg, path.join(isolatedCfgDir, 'opencode.jsonc'));
    } catch {
      // no host config yet -> create the dir so OpenCode has a place to write
      await mkdir(isolatedCfgDir, { recursive: true });
    }

    return {
      home: opencodeHome,
      env: selectedEnvironment(env, opencodeHome, profile),
    };
  },

  async listModels({ paths, profile, env, bin }) {
    // No stable list-models command across versions; doctor skips the check.
    return null;
  },
};
