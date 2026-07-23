import { access, constants, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, resolveWorkerPaths, selectProfile } from './config.mjs';
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

  const pi = await probe(paths.piBin, ['--version'], { env: commandEnvironment(env), timeoutMs: 10000 }, 'Pi CLI');
  if (pi.code !== 0) throw new WorkerError('DOCTOR_FAILED', 'Pi CLI is unavailable', { stderr: pi.stderr });
  const config = await loadConfig(paths);
  const piVersion = pi.stdout.match(/\d+\.\d+\.\d+/)?.[0];
  invariant(piVersion && versionAtLeast(piVersion, config.minimumPiVersion), 'DOCTOR_FAILED', `Pi ${config.minimumPiVersion}+ required`);
  checks.push({ name: 'pi', ok: true, version: piVersion });

  const profile = selectProfile(config, options.profile);
  if (!env[profile.apiKeyEnv]) throw new WorkerError('DOCTOR_FAILED', `Missing provider credential: ${profile.apiKeyEnv}`);
  checks.push({ name: 'credential', ok: true, env: profile.apiKeyEnv });

  const models = JSON.parse(await readFile(paths.modelsFile, 'utf8'));
  const provider = models.providers?.[profile.provider];
  invariant(provider, 'DOCTOR_FAILED', 'Configured provider is absent from models.json');
  const allowedReferences = [`$${profile.apiKeyEnv}`, '${' + profile.apiKeyEnv + '}'];
  invariant(allowedReferences.includes(provider.apiKey), 'DOCTOR_FAILED', 'Configured provider API key must be an environment variable reference');

  const modelList = await probe(paths.piBin, [
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve',
    '--list-models', `${profile.provider}/${profile.model}`,
  ], { env: commandEnvironment(env, profile.apiKeyEnv), timeoutMs: 30000 }, 'Pi model listing');
  if (modelList.code !== 0 || !modelList.stdout.includes(profile.model)) {
    throw new WorkerError('DOCTOR_FAILED', 'Model is not available in Pi for the configured provider', { exitCode: modelList.code ?? -1 });
  }
  checks.push({ name: 'model', ok: true, provider: profile.provider, model: profile.model });

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
