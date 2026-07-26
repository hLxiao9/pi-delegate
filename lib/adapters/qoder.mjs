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

// Qoder CN CLI characteristics:
// - support Personal Access Token environment variable authentication:QODERCN_PERSONAL_ACCESS_TOKEN
// - non-interactive mode: qoderclicn -p "<prompt>" --output-format=json --yolo
// - --output-format support text / json / stream-json
// - --allowed-tools restricted tool set(comma-separated)
// - --max-turns limits conversation turns
// - config directory: ~/.qoder-cn/
// - None --list-models command(models bound via account system)
// - json output format not yet confirmed to contain token usage,first treat as no usage handle

const PASSTHROUGH_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

// Qoder tool name mapping(capitalizes first letter,and Trae similar to)
const QODER_ALLOWED_TOOLS = ['Read', 'Write', 'Grep', 'Glob', 'Edit', 'MultiEdit'];

function selectedEnvironment(env, qoderHome, profile) {
  const selected = { HOME: qoderHome, CI: '1', NO_COLOR: '1' };
  for (const name of PASSTHROUGH_ENV) if (env[name]) selected[name] = env[name];
  // Qoder uses environment variable authentication
  const tokenEnv = profile.apiKeyEnv || 'QODERCN_PERSONAL_ACCESS_TOKEN';
  if (env[tokenEnv]) selected[tokenEnv] = env[tokenEnv];
  return selected;
}

// parse qoderclicn --output-format=json output
// output format may be JSON array or single JSON object
function parseQoderJsonOutput(rawStdout) {
  try {
  const parsed = JSON.parse(rawStdout);
  if (Array.isArray(parsed)) {
  // search backward from end assistant text
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
  const item = parsed[i];
  if (item?.role === 'assistant' && typeof item.content === 'string') return item.content;
  if (item?.type === 'assistant' && typeof item.text === 'string') return item.text;
  if (item?.message?.role === 'assistant') {
  const content = item.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
  const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
  if (text) return text;
  }
  }
  }
  // fallback
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
  const item = parsed[i];
  if (typeof item?.text === 'string' && item.text.length > 0) return item.text;
  if (typeof item?.content === 'string' && item.content.length > 0) return item.content;
  }
  } else if (typeof parsed === 'object' && parsed !== null) {
  // single JSON object
  if (typeof parsed.content === 'string') return parsed.content;
  if (typeof parsed.text === 'string') return parsed.text;
  if (parsed.message?.role === 'assistant') {
  const content = parsed.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
  return content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
  }
  }
  }
  return null;
  } catch {
  return null;
  }
}

export const QoderAdapter = {
  ...WorkerAdapter,
  name: 'qoder',
  defaultBin: 'qoderclicn',
  configDirName: '.qoder-cn',
  configFormat: 'json',
  supportsStreaming: false,  // support stream-json but format unconfirmed,first use json mode
  supportsTokenUsage: false,  // json output format pending confirmation for usage
  supportsModelList: false,
  minimumVersion: null,

  versionCommand() {
  return { argv: ['--version'], env: {} };
  },

  invokeCommand({ state, profile, prompt, config, sessionDir, mode }) {
  // qoderclicn reads prompt from stdin (append '-' per --help) to avoid
  // argv leakage (ps / /proc/<pid>/cmdline). Output via --output-format=json.
  const argv = [
  '--output-format=json',
  '--yolo',
  '--allowed-tools', QODER_ALLOWED_TOOLS.join(','),
  '-',
  ];
  // max-turns limits prevent infinite loops
  if (config.limits?.piMaxTurns) {
  argv.push('--max-turns', String(config.limits.piMaxTurns));
  }
  return { argv, input: prompt, cwd: state.worktreePath };
  },

  parseOutput(rawStdout, rawStderr, exitCode, timedOut) {
  // first try JSON parse
  let text = parseQoderJsonOutput(rawStdout);
  // fallback:JSON on parse failure directly use stdout text
  if (!text) {
  text = rawStdout.trim();
  }
  const stopReason = exitCode === 0 ? 'stop' : (timedOut ? 'timeout' : 'error');
  return { text, usage: null, stopReason, lastAssistant: { content: text } };
  },

  async sanitizeHome({ paths, files, profile, env }) {
  // creates isolated ~/.qoder-cn directory
  // Qoder authentication token passed via environment variable,no need to write config file
  const qoderHome = path.join(files.directory, 'qoder-home');
  const qoderCnDir = path.join(qoderHome, '.qoder-cn');
  await mkdir(qoderCnDir, { recursive: true });
  return { home: qoderHome, env: selectedEnvironment(env, qoderHome, profile) };
  },

  async listModels({ paths, profile, env, bin }) {
  // Qoder None --list-models command
  return null;
  },
};
