import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readlink, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, resolveWorkerPaths, selectProfile } from './config.mjs';
import { validateTaskContract } from './contracts.mjs';
import { doctorCommand } from './doctor.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { runProcess } from './process.mjs';
import { createRun } from './state.mjs';

export async function git(paths, cwd, argv, options = {}) {
  const result = await runProcess(paths.gitBin, argv, {
    cwd,
    env: options.env ?? process.env,
    input: options.input,
    timeoutMs: options.timeoutMs ?? 120000,
    maxCaptureChars: options.maxCaptureChars ?? 200000,
  });
  if (result.code !== 0 && !options.allowFailure) {
    throw new WorkerError('GIT_FAILED', `git ${argv[0]} failed`, { cwd, argv, stderr: result.stderr, stdout: result.stdout });
  }
  return result;
}

export async function getHead(paths, cwd, env = process.env) {
  return (await git(paths, cwd, ['rev-parse', 'HEAD'], { env })).stdout.trim();
}

async function untrackedFiles(paths, root, env) {
  const output = (await git(paths, root, ['ls-files', '--others', '--exclude-standard', '-z'], { env })).stdout;
  return output.split('\0').filter(Boolean).sort();
}

export async function fingerprintSource(paths, root, env = process.env) {
  const hash = createHash('sha256');
  const head = await getHead(paths, root, env);
  const status = (await git(paths, root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { env })).stdout;
  const trackedPatch = (await git(paths, root, ['diff', '--binary', 'HEAD'], { env, maxCaptureChars: 20_000_000 })).stdout;
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
    invariant(!path.isAbsolute(relative) && !relative.split('/').includes('..'), 'GIT_FAILED', 'Unsafe untracked path', { relative });
    const source = path.join(sourceRoot, relative);
    const destination = path.join(worktreeRoot, relative);
    const info = await lstat(source);
    await mkdir(path.dirname(destination), { recursive: true });
    if (info.isSymbolicLink()) await symlink(await readlink(source), destination);
    else if (info.isFile()) await copyFile(source, destination);
    else throw new WorkerError('GIT_FAILED', 'Unsupported untracked entry type', { relative });
  }
}

async function currentBranch(paths, root, env) {
  const result = await git(paths, root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { env, allowFailure: true });
  return result.code === 0 ? result.stdout.trim() : null;
}

export async function sourceUnchanged(paths, state, env = process.env) {
  const current = await fingerprintSource(paths, state.sourceRoot, env);
  return current.head === state.sourceHead && current.digest === state.sourceFingerprint.digest;
}

export async function prepareCommand(options = {}, runtime = {}) {
  invariant(options.task, 'CLI_USAGE', 'prepare requires --task', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  const taskPath = path.resolve(options.task);
  const task = validateTaskContract(JSON.parse(await readFile(taskPath, 'utf8')));

  const doctor = await doctorCommand({ task: taskPath, profile: options.profile }, { env, paths });
  const configured = await loadConfig(paths);
  const profile = selectProfile(configured, doctor.profile);
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
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await git(paths, sourceRoot, ['worktree', 'add', '-b', workerBranch, worktreePath, task.baseRevision], { env });

  let snapshotCommit = null;
  if (sourceFingerprint.dirty) {
    const patch = (await git(paths, sourceRoot, ['diff', '--binary', 'HEAD'], { env, maxCaptureChars: 20_000_000 })).stdout;
    if (patch.length > 0) await git(paths, worktreePath, ['apply', '--whitespace=nowarn', '-'], { env, input: patch });
    await copyUntracked(paths, sourceRoot, worktreePath, env);
    await git(paths, worktreePath, ['add', '-A'], { env });
    await git(paths, worktreePath, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-m', `chore(pi-worker): snapshot source ${task.runId}`], { env });
    snapshotCommit = await getHead(paths, worktreePath, env);
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
    profile: profile.name,
    provider: profile.provider,
    model: profile.model,
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
