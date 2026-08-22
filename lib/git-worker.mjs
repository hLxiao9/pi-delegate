/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readlink, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { readJson } from './atomic-json.mjs';
import { loadConfig, resolveWorkerPaths, selectProfile } from './config.mjs';
import { selectProfileForTask } from './difficulty.mjs';
import { listRunStates } from './dashboard.mjs';
import { validateTaskContract } from './contracts.mjs';
import { doctorCommand } from './doctor.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { runProcess } from './process.mjs';
import { snapshotParentUsage } from './parent-usage.mjs';
import { createRun } from './state.mjs';
import { buildCredentialHint, loadShellProfileEnv } from './shell-profile.mjs';
import { resolveAdapter, resolveBin } from './adapters/index.mjs';
import { getRegistry, presentWorkerChooser } from './environment.mjs';

const KNOWN_CALLERS = new Set(['trae', 'codex', 'claude-code', 'cursor', 'pi-recursive', 'cli']);

function normalizeCaller(value) {
  if (typeof value !== 'string') return 'unknown';
  const lower = value.toLowerCase().trim();
  return KNOWN_CALLERS.has(lower) ? lower : 'unknown';
}

export async function git(paths, cwd, argv, options = {}) {
  const result = await runProcess(paths.gitBin, argv, {
  cwd,
  env: options.env ?? process.env,
  input: options.input,
  timeoutMs: options.timeoutMs ?? 120000,
  maxCaptureChars: options.maxCaptureChars ?? 200000,
  });
  if (result.stdoutTruncated && !options.allowTruncated) {
  throw new WorkerError('GIT_OUTPUT_LIMIT', `git ${argv[0]} output exceeded the safe capture limit`, { cwd, argv });
  }
  if (result.code !== 0 && !options.allowFailure) {
  throw new WorkerError('GIT_FAILED', `git ${argv[0]} failed`, { cwd, argv, stderr: result.stderr, stdout: result.stdout });
  }
  return result;
}

export async function getHead(paths, cwd, env = process.env) {
  return (await git(paths, cwd, ['rev-parse', 'HEAD'], { env })).stdout.trim();
}

function completeOutput(result, operation) {
  invariant(!result.stdoutTruncated, 'FINGERPRINT_INCOMPLETE', `Git output was truncated while ${operation}`);
  return result.stdout;
}

async function untrackedFiles(paths, root, env) {
  const output = completeOutput(
  await git(paths, root, ['ls-files', '--others', '--exclude-standard', '-z'], { env, allowTruncated: true }),
  'listing untracked files',
  );
  return output.split('\0').filter(Boolean).sort();
}

async function modifiedTrackedFiles(paths, root, env) {
  const output = completeOutput(
  await git(paths, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { env, allowTruncated: true }),
  'listing modified tracked files',
  );
  const records = output.split('\0');
  const files = [];
  for (let index = 0; index < records.length; index += 1) {
  const record = records[index];
  if (!record || record.length < 4 || record[2] !== ' ') continue;
  const status = record.slice(0, 2);
  const isRenameOrCopy = /[RC]/.test(status);
  if (isRenameOrCopy) index += 1;
  if (status !== '??' && status !== '!!') files.push(record.slice(3));
  }
  return files;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertSafeSymlink(worktreeRoot, relative, target) {
  invariant(!path.isAbsolute(relative) && !relative.split('/').includes('..'), 'SYMLINK_ESCAPE', 'Unsafe Git path');
  const destination = path.resolve(worktreeRoot, relative);
  const resolved = path.resolve(path.dirname(destination), target);
  invariant(isInside(worktreeRoot, resolved), 'SYMLINK_ESCAPE', 'Source symlink escapes the worker worktree');
}

async function validateSourceSymlinks(paths, sourceRoot, worktreeRoot, env) {
  const tracked = completeOutput(
  await git(paths, sourceRoot, ['ls-files', '-s', '-z'], { env, allowTruncated: true }),
  'listing tracked files',
  );
  const trackedLinks = tracked.split('\0').flatMap((record) => {
  if (!record) return [];
  const tab = record.indexOf('\t');
  return tab > 0 && record.startsWith('120000 ') ? [record.slice(tab + 1)] : [];
  });
  const candidates = new Set([
  ...trackedLinks,
  ...await modifiedTrackedFiles(paths, sourceRoot, env),
  ...await untrackedFiles(paths, sourceRoot, env),
  ]);
  for (const relative of candidates) {
  invariant(!path.isAbsolute(relative) && !relative.split('/').includes('..'), 'SYMLINK_ESCAPE', 'Unsafe Git path');
  try {
  const info = await lstat(path.join(sourceRoot, relative));
  if (info.isSymbolicLink()) assertSafeSymlink(worktreeRoot, relative, await readlink(path.join(sourceRoot, relative)));
  } catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  }
  }
}

export async function fingerprintSource(paths, root, env = process.env) {
  const hash = createHash('sha256');
  const head = await getHead(paths, root, env);
  const status = completeOutput(
  await git(paths, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { env, allowTruncated: true }),
  'reading source status',
  );
  const trackedPatch = completeOutput(
  await git(paths, root, ['diff', '--binary', 'HEAD'], { env, maxCaptureChars: 20_000_000, allowTruncated: true }),
  'reading source patch',
  );
  hash.update(head).update('\0').update(status).update('\0').update(trackedPatch);
  for (const relative of await untrackedFiles(paths, root, env)) {
  const absolute = path.join(root, relative);
  const info = await lstat(absolute);
  hash.update(relative).update('\0').update(String(info.mode)).update('\0');
  if (info.isSymbolicLink()) hash.update(await readlink(absolute));
  else if (info.isFile()) hash.update(await readFile(absolute));
  }
  return { head, dirty: status.length > 0, digest: hash.digest('hex') };
}

async function copyUntracked(paths, sourceRoot, worktreeRoot, env) {
  for (const relative of await untrackedFiles(paths, sourceRoot, env)) {
  invariant(!path.isAbsolute(relative) && !relative.split('/').includes('..'), 'SYMLINK_ESCAPE', 'Unsafe untracked path');
  const source = path.join(sourceRoot, relative);
  const destination = path.join(worktreeRoot, relative);
  const info = await lstat(source);
  await mkdir(path.dirname(destination), { recursive: true });
  if (info.isSymbolicLink()) {
  const target = await readlink(source);
  assertSafeSymlink(worktreeRoot, relative, target);
  await symlink(target, destination);
  }
  else if (info.isFile()) await copyFile(source, destination);
  else throw new WorkerError('GIT_FAILED', 'Unsupported untracked entry type', { relative });
  }
}

export async function currentBranch(paths, root, env) {
  const result = await git(paths, root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { env, allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function sourceUnchanged(paths, state, env = process.env) {
  const current = await fingerprintSource(paths, state.sourceRoot, env);
  return current.head === state.sourceHead && current.digest === state.sourceFingerprint.digest;
}

// Resolve the effective model id for a run. Interactive selection is handled
// upstream by the unified CLI+model chooser (environment.mjs); this helper
// only resolves the non-interactive cases:
//   1. explicit `--model <id>` override            -> used as-is
//   2. the profile's pinned `model` (config.json)  -> used as-is
//   3. empty string -> the adapter/worker uses its own default (zero-config)
async function resolveModelForPrepare({ requestedModel, profile }) {
  if (requestedModel && requestedModel.trim() && requestedModel.trim() !== 'auto') {
    return requestedModel.trim();
  }
  return (profile.model || '').trim();
}

export async function prepareCommand(options = {}, runtime = {}) {
  invariant(options.task, 'CLI_USAGE', 'prepare requires --task', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  const taskPath = path.resolve(options.task);
  const task = validateTaskContract(JSON.parse(await readFile(taskPath, 'utf8')));

  const configured = await loadConfig(paths);
  // concurrency limit: count currently active(running/verifying/reviewing/revising)run count,
  // exceeds maxConcurrentRuns then reject prepare,prevents exhausting API quota during multi-session concurrency.
  const activeStates = (await listRunStates(paths)).filter((s) => ['running', 'verifying', 'selfReviewing', 'reviewing', 'revising'].includes(s.status));
  invariant(activeStates.length < configured.maxConcurrentRuns, 'CONCURRENCY_LIMIT', `Max concurrent runs (${configured.maxConcurrentRuns}) reached; active: ${activeStates.length}`, { active: activeStates.length, limit: configured.maxConcurrentRuns });

  // Interactive CLI+model chooser: when a human is at a TTY (and no parent
  // agent drives pi-delegate headlessly), and no explicit --profile/--model was
  // given, detect the environment and let the user confirm which CLI + model to
  // dispatch with. Explicit flags or a parent agent skip the prompt.
  const forceSelect = options['select-worker'] === 'true' || options['select-model'] === 'true' || options.interactive === 'true';
  const interactive = forceSelect
    || (Boolean(process.stdin.isTTY) && !process.env.PARENT_AGENT && !process.env.PI_WORKER_CALLER);

  let profileName = null;
  let chosenModel = null;
  if (interactive && !options.profile && !options.model) {
    const reg = await getRegistry({ paths, env });
    const choice = await presentWorkerChooser({ config: configured, reg, defaultProfile: configured.defaultProfile });
    if (choice && choice.profile) {
      profileName = choice.profile;
      chosenModel = choice.model || '';
    }
  }

  // user passes --profile then respect;otherwise auto route by difficulty + domain + modality.
  let routed = null;
  if (!profileName) {
    routed = options.profile ? null : selectProfileForTask(configured, task);
    if (!options.profile && !routed) {
      throw new WorkerError('NO_ROUTABLE_PROFILE', 'No Pi profile matches the task difficulty/domain/modalities; configure a profile with the matching costTier/strengths/modalities or pass --profile', { runId: task.runId });
    }
    profileName = routed?.name ?? options.profile;
  }
  const doctor = await doctorCommand({ task: taskPath, profile: profileName }, { env, paths });
  const profile = selectProfile(configured, doctor.profile);
  // Fix 5: defensive credential precheck before any worktree/branch is created.
  // doctorCommand already validates credentials, but we re-check here so that a
  // future code path that bypasses doctor (or an env mutation between doctor and
  // prepare) cannot build a worktree + branch for a run that will immediately
  // fail on missing credentials. Throws PREPARE_FAILED with the actionable hint
  // from buildCredentialHint (which itself calls loadShellProfileEnv +
  // findSimilarEnvVarNames) so the user knows exactly what to do.
  const preAdapter = resolveAdapter(profile);
  // Skip the credential precheck when the worker manages its own credentials
  // (trae OAuth, or opencode which reads its own provider config). Only enforce
  // when apiKeyEnv is declared AND the variable is missing from env + shell profile.
  if (preAdapter.name !== 'trae' && profile.apiKeyEnv !== undefined && !env[profile.apiKeyEnv]) {
    const profileEnv = await loadShellProfileEnv([profile.apiKeyEnv], { home: env.HOME });
    if (!Object.prototype.hasOwnProperty.call(profileEnv, profile.apiKeyEnv)) {
      throw new WorkerError('PREPARE_FAILED', await buildCredentialHint(profile.apiKeyEnv, { home: env.HOME }), { category: 'auth' });
    }
  }
  // Resolve the model for this run: a chooser selection (if interactive) takes
  // priority, otherwise explicit --model > profile pin > adapter default.
  // Stored on state so run/revise reuse the choice without re-prompting and
  // without editing config.json.
  const effectiveModel = chosenModel !== null
    ? chosenModel
    : await resolveModelForPrepare({ requestedModel: options.model, profile });

  const discoveredRoot = (await git(paths, task.repositoryRoot, ['rev-parse', '--show-toplevel'], { env })).stdout.trim();
  const sourceRoot = await realpath(discoveredRoot);
  invariant(sourceRoot === await realpath(task.repositoryRoot), 'CONTRACT_INVALID', 'repositoryRoot must be the Git top level');
  const sourceHead = await getHead(paths, sourceRoot, env);
  if (sourceHead !== task.baseRevision) {
  throw new WorkerError('BASE_REVISION_MISMATCH', 'Task baseRevision no longer matches source HEAD', { expected: task.baseRevision, actual: sourceHead });
  }

  const workerBranch = `pi-worker/${task.runId}`;
  const existing = await git(paths, sourceRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${workerBranch}`], { env, allowFailure: true });
  invariant(existing.code !== 0, 'RUN_EXISTS', `Worker branch already exists: ${workerBranch}`);
  const sourceFingerprint = await fingerprintSource(paths, sourceRoot, env);
  const worktreePath = path.join(paths.cacheRoot, 'worktrees', task.runId);
  await validateSourceSymlinks(paths, sourceRoot, worktreePath, env);
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await git(paths, sourceRoot, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-b', workerBranch, worktreePath, task.baseRevision], { env });

  // M6: worktree after creation if snapshot fails,clean up created worktree + branch,avoid residue.
  let snapshotCommit = null;
  try {
  if (sourceFingerprint.dirty) {
  const patch = (await git(paths, sourceRoot, ['diff', '--binary', 'HEAD'], { env, maxCaptureChars: 20_000_000 })).stdout;
  if (patch.length > 0) await git(paths, worktreePath, ['apply', '--whitespace=nowarn', '-'], { env, input: patch });
  await copyUntracked(paths, sourceRoot, worktreePath, env);
  await git(paths, worktreePath, ['add', '-A'], { env });
  await git(paths, worktreePath, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-m', `chore(pi-worker): snapshot source ${task.runId}`], { env });
  snapshotCommit = await getHead(paths, worktreePath, env);
  }
  } catch (err) {
  await git(paths, sourceRoot, ['worktree', 'remove', '--force', worktreePath], { env, allowFailure: true });
  await git(paths, sourceRoot, ['branch', '-D', workerBranch], { env, allowFailure: true });
  throw err;
  }

  const usageStartFile = options['usage-start'] ?? options['codex-start'];
  let parentUsageStart;
  let parentUsageStartSource;
  if (usageStartFile) {
  parentUsageStart = await readJson(path.resolve(usageStartFile));
  invariant(typeof parentUsageStart?.available === 'boolean' && typeof parentUsageStart.at === 'string' && Number.isFinite(Date.parse(parentUsageStart.at)), 'CONTRACT_INVALID', 'The parent usage baseline is invalid');
  parentUsageStartSource = 'early-meter';
  } else {
  parentUsageStart = await snapshotParentUsage({ home: env.HOME, env });
  parentUsageStartSource = 'prepare-fallback';
  }

  const now = new Date().toISOString();
  const state = {
  schemaVersion: 1,
  runId: task.runId,
  status: 'prepared',
  createdAt: now,
  updatedAt: now,
  sourceRoot,
  sourceHead,
  sourceBranch: await currentBranch(paths, sourceRoot, env),
  sourceFingerprint,
  sourceDirty: sourceFingerprint.dirty,
  worktreePath,
  workerBranch,
  workerBaseRevision: snapshotCommit ?? task.baseRevision,
  snapshotCommit,
  implementationCommit: null,
  revisionRound: 0,
  fallbackUsed: false,
  parentUsageStart,
  parentUsageStartSource,
  caller: normalizeCaller(env.PARENT_AGENT ?? env.PI_WORKER_CALLER),
  profile: profile.name,
  provider: profile.provider,
  model: effectiveModel,
  profileRouting: routed?.routing ?? null,
  transitions: [],
  };
  await createRun(paths, state, task);
  return {
  runId: task.runId,
  status: state.status,
  sourceDirty: state.sourceDirty,
  worktreePath,
  workerBranch,
  snapshotCommit,
  };
}
