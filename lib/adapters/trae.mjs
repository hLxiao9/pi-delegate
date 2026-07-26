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

// Trae CLI characteristics:
// - OAuth enterprise login,cannot programmatically provision credentials(user must manually traecli first login)
// - non-interactive mode: traecli -p "<prompt>" [--json]
// - --json output JSON array(includes system prompt, tool calls, execution process, final result)
// - --allowed-tool restricted tool set
// - --worktree built-in worktree(we already built,must be disabled to avoid conflicts)
// - --yolo skip permission check(non-interactive requires)
// - None token usage output
// - None --list-models command(models bound via account system)

const PASSTHROUGH_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

// Trae --allowed-tool mapping:converts pi -style tool names to Trae tool names
// Bash is intentionally excluded: the worker runs in an isolated worktree with
// a restricted environment, and granting shell execution would let the
// delegated model run arbitrary commands outside the file-edit sandbox.
// File-level edits (Read/Write/Edit/Grep/Glob) are sufficient for bounded
// implementation tasks; if a task truly needs shell execution it should be
// escalated to the parent agent, not delegated to the untrusted worker.
const TRAE_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write'];

function selectedEnvironment(env, traeHome) {
  const selected = { HOME: traeHome, CI: '1', NO_COLOR: '1' };
  for (const name of PASSTHROUGH_ENV) if (env[name]) selected[name] = env[name];
  // Trae use OAuth,not needed API key environment variable
  return selected;
}

// parse traecli --json output
// output format is JSON array,each element is an event record
// we need to find the last assistant message text content
function parseTraeJsonOutput(rawStdout) {
  try {
  const arr = JSON.parse(rawStdout);
  if (!Array.isArray(arr)) return null;
  // search backward from end assistant text
  for (let i = arr.length - 1; i >= 0; i -= 1) {
  const item = arr[i];
  if (item?.role === 'assistant' && typeof item.content === 'string') {
  return item.content;
  }
  // Trae --json format may use type field
  if (item?.type === 'assistant' && typeof item.text === 'string') {
  return item.text;
  }
  // or message nested
  if (item?.message?.role === 'assistant') {
  const content = item.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
  const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
  if (text) return text;
  }
  }
  }
  // fallback:if JSON no explicit in array assistant message,take the last one with text/content  
  for (let i = arr.length - 1; i >= 0; i -= 1) {
  const item = arr[i];
  if (typeof item?.text === 'string' && item.text.length > 0) return item.text;
  if (typeof item?.content === 'string' && item.content.length > 0) return item.content;
  }
  return null;
  } catch {
  return null;
  }
}

export const TraeAdapter = {
  ...WorkerAdapter,
  name: 'trae',
  defaultBin: 'traecli',
  configDirName: null,  // Trae use OAuth,no config directory
  configFormat: 'none',
  supportsStreaming: false,
  supportsTokenUsage: false,  // Trae --json does not contain token usage
  supportsModelList: false,  // None --list-models
  minimumVersion: null,

  versionCommand() {
  return { argv: ['-v'], env: {} };
  },

  invokeCommand({ state, profile, prompt, config, sessionDir, mode }) {
  // traecli -p "<prompt>" --json --yolo --allowed-tool <tools>
  // --json: output JSON format(includes tool calls and results)
  // --yolo: skip permission check(non-interactive requires)
  // --allowed-tool: restricted tool set,prevent Trae executes dangerous operations
  // not used --worktree(we already built worktree isolation)
  const argv = [
  '-p', prompt,
  '--json',
  '--yolo',
  '--allowed-tool', TRAE_ALLOWED_TOOLS.join(','),
  ];
  // session-id for session isolation
  if (state.runId) {
  argv.push('--session-id', state.runId);
  }
  return { argv, input: null, cwd: state.worktreePath };
  },

  parseOutput(rawStdout, rawStderr, exitCode, timedOut) {
  // first try --json parse
  let text = parseTraeJsonOutput(rawStdout);
  // fallback:if JSON parse failure,directly use stdout text
  if (!text) {
  text = rawStdout.trim();
  }
  const stopReason = exitCode === 0 ? 'stop' : (timedOut ? 'timeout' : 'error');
  return { text, usage: null, stopReason, lastAssistant: { content: text } };
  },

  async sanitizeHome({ paths, files, profile, env }) {
  // Trae use OAuth login,credentials stored at system level keychain or ~/.trae directory
  // we do not create isolated home(because OAuth token needs to reuse system-level login state)
  // only returns a temporary directory as HOME(for isolating other state)
  const traeHome = path.join(files.directory, 'trae-home');
  await mkdir(traeHome, { recursive: true });
  // note:Trae  OAuth token may be in system keychain in,not in HOME under
  // so here set HOME does not affect OAuth login state
  return { home: traeHome, env: selectedEnvironment(env, traeHome) };
  },

  async listModels({ paths, profile, env, bin }) {
  // Trae None --list-models,doctor skip
  return null;
  },

  // Trae specific:OAuth preflight
  // doctor if not logged in when invoked,should give clear prompt
  checkAuthHint() {
  return {
  requiresManualLogin: true,
  loginCommand: 'traecli',
  loginHint: 'Trae CLI requires OAuth login. Run `traecli` once interactively to complete enterprise login before using delegation.',
  };
  },
};
