/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { invariant } from '../errors.mjs';
import { WorkerAdapter } from './base.mjs';

// Pi proprietary tool set and disable flags
const PI_TOOLS = 'read,grep,find,ls,edit,write';
const PI_DISABLE_FLAGS = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve'];

// passthrough environment variable allowlist
const PASSTHROUGH_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

function selectedEnvironment(env, profile, piHome) {
  const selected = { HOME: piHome, CI: '1', NO_COLOR: '1' };
  for (const name of PASSTHROUGH_ENV) if (env[name]) selected[name] = env[name];
  if (env[profile.apiKeyEnv]) selected[profile.apiKeyEnv] = env[profile.apiKeyEnv];
  return selected;
}

async function createSanitizedPiHome(paths, files, profile) {
  const models = JSON.parse(await readFile(paths.modelsFile, 'utf8'));
  const provider = models.providers?.[profile.provider];
  invariant(provider, 'CONFIG_INVALID', `Provider missing from models.json: ${profile.provider}`);
  const expectedKeys = [`$${profile.apiKeyEnv}`, '${' + profile.apiKeyEnv + '}'];
  invariant(expectedKeys.includes(provider.apiKey), 'CONFIG_INVALID', 'Selected provider must resolve its key from the selected environment variable');
  const piHome = path.join(files.directory, 'pi-home');
  const agentDir = path.join(piHome, '.pi', 'agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, 'models.json'), `${JSON.stringify({ providers: { [profile.provider]: provider } }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(agentDir, 'settings.json'), '{"quietStartup":true}\n', { mode: 0o600 });
  return piHome;
}

export const PiAdapter = {
  ...WorkerAdapter,
  name: 'pi',
  defaultBin: 'pi',
  configDirName: '.pi/agent',
  configFormat: 'json',
  supportsStreaming: true,
  supportsTokenUsage: true,
  supportsModelList: true,
  minimumVersion: '0.80.10',

  versionCommand() {
  return { argv: ['--version'], env: {} };
  },

  invokeCommand({ state, profile, prompt, config, sessionDir, mode }) {
  // note:at actual invocation env will be in pi-runner merged in HOME/passthrough/apiKeyEnv
  // here only returns argv; env by sanitizeHome returned home + selectedEnvironment combination
  const argv = [
  '--mode', 'json', '--provider', profile.provider, '--model', profile.model,
  '--thinking', profile.thinking ?? 'high', '--session-dir', sessionDir, '--session-id', state.runId,
  '--tools', PI_TOOLS, ...PI_DISABLE_FLAGS,
  ];
  return { argv, input: prompt, cwd: state.worktreePath };
  },

  // Pi is streaming NDJSON,parseOutput not used in main flow(main flow uses onStdoutLine line-by-line parsing)
  // but keeps a fallback for non-streaming scenarios
  parseOutput(rawStdout, rawStderr, exitCode, timedOut) {
  // try from stdout extract the last one from message_end event
  const lines = rawStdout.split('\n').filter(Boolean);
  let lastAssistant = null;
  for (const line of lines) {
  try {
  const event = JSON.parse(line);
  if (event.type === 'message_end' && event.message?.role === 'assistant') lastAssistant = event.message;
  } catch {}
  }
  const text = Array.isArray(lastAssistant?.content)
  ? lastAssistant.content.filter((c) => c?.text).map((c) => c.text).join('\n')
  : (lastAssistant?.content ?? '');
  const usage = lastAssistant?.usage
  ? {
  inputTokens: lastAssistant.usage.input ?? 0,
  cachedInputTokens: lastAssistant.usage.cacheRead ?? 0,
  cacheWriteInputTokens: lastAssistant.usage.cacheWrite ?? 0,
  outputTokens: lastAssistant.usage.output ?? 0,
  reasoningOutputTokens: lastAssistant.usage.reasoning ?? 0,
  totalTokens: lastAssistant.usage.totalTokens ?? 0,
  providerReportedCostUsd: lastAssistant.usage.cost?.total ?? 0,
  requests: 1,
  durationMs: 0,
  }
  : null;
  const stopReason = lastAssistant?.stopReason ?? (timedOut ? 'timeout' : (exitCode === 0 ? 'stop' : 'error'));
  return { text, usage, stopReason, lastAssistant };
  },

  async sanitizeHome({ paths, files, profile, env }) {
  const piHome = await createSanitizedPiHome(paths, files, profile);
  return { home: piHome, env: selectedEnvironment(env, profile, piHome) };
  },

  async listModels({ paths, profile, env, bin }) {
  // reuse doctor  list-models logic
  return {
  argv: [...PI_DISABLE_FLAGS, '--list-models', `${profile.provider}/${profile.model}`],
  env: { ...env },
  parse: (stdout) => stdout.includes(profile.model),
  };
  },
};
