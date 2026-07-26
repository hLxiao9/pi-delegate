/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { invariant } from '../errors.mjs';
import { WorkerAdapter } from './base.mjs';

// Kimi Code CLI config directory ~/.kimi-code/
// configuration file config.toml, credentials written in [providers.<name>.api_key]
// non-interactive mode: kimi -p "<prompt>"
// output:plain text(None token usage)
// tool restrictions via config.toml  [tools] table configuration

const PASSTHROUGH_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

function selectedEnvironment(env, kimiHome) {
  const selected = { HOME: kimiHome, KIMI_CODE_HOME: kimiHome, CI: '1', NO_COLOR: '1', KIMI_DISABLE_TELEMETRY: '1' };
  for (const name of PASSTHROUGH_ENV) if (env[name]) selected[name] = env[name];
  return selected;
}

// generate Kimi config.toml content,only includes the current profile used by provider and model
function buildKimiConfigToml(profile) {
  // note:Kimi requirement api_key written in config.toml in,does not accept environment variable direct reading.
  // but we can put env actual key value into the file,achieves equivalent effect.
  // profile.apiKeyEnv is the variable name(as KIMI_API_KEY),at runtime from env takes value.
  // this step is in sanitizeHome done in(because it needs env).
  // here only returns the template,key placeholder by sanitizeHome replace.
  const providerName = profile.provider || 'kimi';
  const modelName = profile.model;
  const modelAlias = `${providerName}/${modelName}`;
  return {
  default_model: modelAlias,
  default_permission_mode: 'yolo',  // non-interactive mode must auto-approve tool calls
  default_plan_mode: false,
  telemetry: false,
  providers: {
  [providerName]: {
  type: profile.providerType || 'kimi',
  base_url: profile.baseUrl || 'https://api.kimi.com/coding/v1',
  api_key: '__KIMI_API_KEY_PLACEHOLDER__',  // by sanitizeHome replace
  },
  },
  models: {
  [modelAlias]: {
  provider: providerName,
  model: modelName,
  max_context_size: profile.maxContextSize || 1048576,
  capabilities: ['thinking', 'always_thinking', 'tool_use', ...(profile.modalities?.includes('vision') ? ['image_in'] : [])],
  display_name: modelName,
  support_efforts: ['max'],
  default_effort: 'max',
  },
  },
  thinking: { enabled: true, effort: 'high', keep: 'all' },
  loop_control: { max_retries_per_step: 10, reserved_context_size: 50000 },
  permission: {
  rules: [
  { decision: 'allow', pattern: 'Read' },
  { decision: 'allow', pattern: 'Grep' },
  { decision: 'allow', pattern: 'Glob' },
  { decision: 'allow', pattern: 'Edit' },
  { decision: 'allow', pattern: 'Write' },
  ],
  },
  };
}


// more reliable TOML generate:manually built,because the generic approach above is not stable enough for nesting
function buildTomlManual(config) {
  const lines = [];
  // top-level scalar
  lines.push(`default_model = ${JSON.stringify(config.default_model)}`);
  lines.push(`default_permission_mode = ${JSON.stringify(config.default_permission_mode)}`);
  lines.push(`default_plan_mode = ${config.default_plan_mode}`);
  lines.push(`telemetry = ${config.telemetry}`);
  // providers
  for (const [name, prov] of Object.entries(config.providers)) {
  lines.push('');
  lines.push(`[providers.${JSON.stringify(name)}]`);
  lines.push(`type = ${JSON.stringify(prov.type)}`);
  lines.push(`base_url = ${JSON.stringify(prov.base_url)}`);
  lines.push(`api_key = ${JSON.stringify(prov.api_key)}`);
  }
  // models
  for (const [alias, model] of Object.entries(config.models)) {
  lines.push('');
  lines.push(`[models.${JSON.stringify(alias)}]`);
  lines.push(`provider = ${JSON.stringify(model.provider)}`);
  lines.push(`model = ${JSON.stringify(model.model)}`);
  lines.push(`max_context_size = ${model.max_context_size}`);
  lines.push(`capabilities = [${model.capabilities.map((c) => JSON.stringify(c)).join(', ')}]`);
  lines.push(`display_name = ${JSON.stringify(model.display_name)}`);
  lines.push(`support_efforts = [${model.support_efforts.map((c) => JSON.stringify(c)).join(', ')}]`);
  lines.push(`default_effort = ${JSON.stringify(model.default_effort)}`);
  }
  // thinking
  lines.push('');
  lines.push('[thinking]');
  lines.push(`enabled = ${config.thinking.enabled}`);
  lines.push(`effort = ${JSON.stringify(config.thinking.effort)}`);
  lines.push(`keep = ${JSON.stringify(config.thinking.keep)}`);
  // loop_control
  lines.push('');
  lines.push('[loop_control]');
  lines.push(`max_retries_per_step = ${config.loop_control.max_retries_per_step}`);
  lines.push(`reserved_context_size = ${config.loop_control.reserved_context_size}`);
  // permission.rules (array of tables)
  for (const rule of config.permission.rules) {
  lines.push('');
  lines.push('[[permission.rules]]');
  lines.push(`decision = ${JSON.stringify(rule.decision)}`);
  lines.push(`pattern = ${JSON.stringify(rule.pattern)}`);
  }
  return lines.join('\n') + '\n';
}

export const KimiAdapter = {
  ...WorkerAdapter,
  name: 'kimi',
  defaultBin: 'kimi',
  configDirName: '.kimi-code',
  configFormat: 'toml',
  supportsStreaming: false,
  supportsTokenUsage: false,  // Kimi -p mode does not output token usage
  supportsModelList: false,  // Kimi pass /model interactive switching,no command-line list-models
  minimumVersion: null,  // docs do not mandate a minimum version

  versionCommand() {
  return { argv: ['--version'], env: {} };
  },

  invokeCommand({ state, profile, prompt, config, sessionDir, mode }) {
  // Kimi non-interactive mode: kimi -p "<prompt>"
  // -p prints response and exits immediately,suitable for pipeline scenarios
  // note:Kimi no --tools limit,tool permissions via config.toml  permission.rules control
  const argv = ['-p', prompt];
  return { argv, input: null, cwd: state.worktreePath };
  },

  parseOutput(rawStdout, rawStderr, exitCode, timedOut) {
  // Kimi -p outputs plain text,no structured events
  // text may contain tool call logs,we only take the last assistant text
  const text = rawStdout.trim();
  const stopReason = exitCode === 0 ? 'stop' : (timedOut ? 'timeout' : 'error');
  // usage for null,metrics gracefully degrades
  return { text, usage: null, stopReason, lastAssistant: { content: text } };
  },

  async sanitizeHome({ paths, files, profile, env }) {
  // creates isolated ~/.kimi-code directory,writes only the current provider  config.toml
  const kimiHome = path.join(files.directory, 'kimi-home');
  const kimiCodeDir = path.join(kimiHome, '.kimi-code');
  await mkdir(kimiCodeDir, { recursive: true });

  // from env takes the actual api key value
  const apiKeyValue = env[profile.apiKeyEnv];
  invariant(apiKeyValue, 'PI_FAILED', `Missing provider credential: ${profile.apiKeyEnv}`, { category: 'auth' });

  // build config.toml
  const configObj = buildKimiConfigToml(profile);
  configObj.providers[profile.provider || 'kimi'].api_key = apiKeyValue;
  const tomlContent = buildTomlManual(configObj);
  await writeFile(path.join(kimiCodeDir, 'config.toml'), tomlContent, { mode: 0o600 });

  return { home: kimiHome, env: selectedEnvironment(env, kimiHome) };
  },

  async listModels({ paths, profile, env, bin }) {
  // Kimi no command-line list-models,doctor skip model list check
  return null;
  },
};
