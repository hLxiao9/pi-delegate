/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { access, constants, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, resolveWorkerPaths, selectProfile } from './config.mjs';
import { resolveAdapter, resolveBin } from './adapters/index.mjs';
import { assertDelegableCapabilities, validateTaskContract } from './contracts.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { runProcess } from './process.mjs';

function versionAtLeast(actual, required) {
  const left = actual.split('.').map(Number);
  const right = required.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
  if ((left[index] ?? 0) > (right[index] ?? 0)) return true;
  if ((left[index] ?? 0) < (right[index] ?? 0)) return false;
  }
  return true;
}

async function nearestExistingDirectory(target) {
  let current = target;
  while (true) {
  try {
  const info = await stat(current);
  if (info.isDirectory()) return current;
  } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(current);
  invariant(parent !== current, 'DOCTOR_FAILED', 'No writable state or cache directory');
  current = parent;
  }
}

async function probe(command, argv, options, label) {
  try {
  return await runProcess(command, argv, options);
  } catch (error) {
  throw new WorkerError('DOCTOR_FAILED', `${label} is unavailable`, { causeCode: error?.code ?? 'PROCESS_ERROR' });
  }
}

function commandEnvironment(env, credentialName = null) {
  const selected = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
  if (env[name]) selected[name] = env[name];
  }
  if (credentialName) selected[credentialName] = env[credentialName];
  return selected;
}

function doctorFailure(error) {
  const message = error instanceof WorkerError && error.code === 'DOCTOR_FAILED'
  ? error.message
  : 'Doctor preflight failed';
  const causeCode = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code)
  ? error.code
  : 'UNEXPECTED';
  return new WorkerError('DOCTOR_FAILED', message, { causeCode });
}

async function doctor(options = {}, runtime = {}) {
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  const checks = [];
  invariant(versionAtLeast(process.versions.node, '22.19.0'), 'DOCTOR_FAILED', `Node 22.19.0+ required; found ${process.versions.node}`);
  checks.push({ name: 'node', ok: true, version: process.versions.node });

  const git = await probe(paths.gitBin, ['--version'], { env: commandEnvironment(env), timeoutMs: 10000 }, 'Git');
  if (git.code !== 0) throw new WorkerError('DOCTOR_FAILED', 'Git is unavailable', { stderr: git.stderr });
  checks.push({ name: 'git', ok: true, version: git.stdout.trim() });

  const config = await loadConfig(paths);
  const profile = selectProfile(config, options.profile);
  const adapter = resolveAdapter(profile);
  const bin = resolveBin(adapter, env);

  // adapter version detection
  const versionProbe = await probe(bin, adapter.versionCommand().argv, { env: commandEnvironment(env), timeoutMs: 10000 }, `${adapter.name} CLI`);
  if (versionProbe.code !== 0) {
  throw new WorkerError('DOCTOR_FAILED', `${adapter.name} CLI is unavailable`, { stderr: versionProbe.stderr, adapter: adapter.name, bin });
  }
  const cliVersion = versionProbe.stdout.match(/\d+\.\d+\.\d+/)?.[0];
  if (adapter.minimumVersion) {
  invariant(cliVersion && versionAtLeast(cliVersion, adapter.minimumVersion), 'DOCTOR_FAILED', `${adapter.name} ${adapter.minimumVersion}+ required; found ${cliVersion ?? 'unknown'}`);
  }
  checks.push({ name: adapter.name, ok: true, version: cliVersion ?? 'unknown' });

  // credential check:Trae use OAuth skip;Pi/Kimi check env variable
  if (adapter.name === 'trae') {
  checks.push({ name: 'credential', ok: true, type: 'oauth', hint: 'Trae uses OAuth; ensure `traecli` has been logged in interactively at least once.' });
  } else {
  if (!env[profile.apiKeyEnv]) throw new WorkerError('DOCTOR_FAILED', `Missing provider credential: ${profile.apiKeyEnv}`);
  checks.push({ name: 'credential', ok: true, env: profile.apiKeyEnv });
  }

  // model availability check:only when adapter.supportsModelList=true execute at
  if (adapter.supportsModelList && adapter.name === 'pi') {
  const models = JSON.parse(await readFile(paths.modelsFile, 'utf8'));
  const provider = models.providers?.[profile.provider];
  invariant(provider, 'DOCTOR_FAILED', 'Configured provider is absent from models.json');
  const allowedReferences = [`$${profile.apiKeyEnv}`, '${' + profile.apiKeyEnv + '}'];
  invariant(allowedReferences.includes(provider.apiKey), 'DOCTOR_FAILED', 'Configured provider API key must be an environment variable reference');
  const listSpec = await adapter.listModels({ paths, profile, env: commandEnvironment(env, profile.apiKeyEnv), bin });
  if (listSpec) {
  const modelList = await probe(bin, listSpec.argv, { env: listSpec.env, timeoutMs: 30000 }, `${adapter.name} model listing`);
  if (modelList.code !== 0 || !listSpec.parse(modelList.stdout)) {
  throw new WorkerError('DOCTOR_FAILED', `Model is not available in ${adapter.name} for the configured provider`, { exitCode: modelList.code ?? -1 });
  }
  }
  checks.push({ name: 'model', ok: true, provider: profile.provider, model: profile.model });
  } else {
  // Kimi/Trae:skip model list check(no command-line list-models)
  checks.push({ name: 'model', ok: true, provider: profile.provider, model: profile.model, note: `${adapter.name} has no --list-models command; model availability checked at runtime` });
  }

  for (const target of [paths.stateRoot, paths.cacheRoot]) {
  const ancestor = await nearestExistingDirectory(target);
  await access(ancestor, constants.W_OK);
  }
  checks.push({ name: 'directories', ok: true });

  if (options.task) {
  const task = validateTaskContract(JSON.parse(await readFile(path.resolve(options.task), 'utf8')));
  assertDelegableCapabilities(task, profile);
  checks.push({ name: 'task', ok: true, runId: task.runId });
  }
  return { status: 'ready', profile: profile.name, provider: profile.provider, model: profile.model, checks };
}

export async function doctorCommand(options = {}, runtime = {}) {
  try {
  return await doctor(options, runtime);
  } catch (error) {
  throw doctorFailure(error);
  }
}
