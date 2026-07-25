import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ensureDir, readJson, writeJsonAtomic } from './atomic-json.mjs';
import { WorkerError, invariant } from './errors.mjs';

export const TERMINAL_STATUSES = new Set(['integrated', 'failed', 'blocked']);
export const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;
const TRANSITIONS = {
  prepared: new Set(['running', 'failed', 'blocked']),
  running: new Set(['verifying', 'failed', 'blocked']),
  verifying: new Set(['selfReviewing', 'reviewing', 'failed', 'blocked']),
  selfReviewing: new Set(['reviewing', 'failed', 'blocked']),
  reviewing: new Set(['revising', 'approved', 'failed', 'blocked']),
  revising: new Set(['verifying', 'failed', 'blocked']),
  approved: new Set(['committed', 'failed', 'blocked']),
  committed: new Set(['integrated', 'blocked']),
  integrated: new Set(),
  failed: new Set(),
  blocked: new Set(),
};

export function runDirectory(paths, runId) {
  invariant(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(runId), 'STATE_INVALID', 'Invalid run id');
  return path.join(paths.stateRoot, 'runs', runId);
}

export function runFiles(paths, runId) {
  const directory = runDirectory(paths, runId);
  return {
    directory,
    state: path.join(directory, 'state.json'),
    task: path.join(directory, 'task.json'),
    events: path.join(directory, 'pi-events.jsonl'),
    verification: path.join(directory, 'verification.json'),
    selfReview: path.join(directory, 'self-review.json'),
    review: path.join(directory, 'review.json'),
    metrics: path.join(directory, 'metrics.json'),
    report: path.join(directory, 'report.md'),
    lock: path.join(directory, '.lock'),
  };
}

export async function createRun(paths, state, task) {
  const files = runFiles(paths, state.runId);
  await ensureDir(files.directory);
  try {
    await open(files.state, 'wx').then(async (handle) => {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.close();
    });
  } catch (error) {
    if (error.code === 'EEXIST') throw new WorkerError('RUN_EXISTS', `Run already exists: ${state.runId}`);
    throw error;
  }
  await writeJsonAtomic(files.task, task);
  return files;
}

export async function loadRun(paths, runId) {
  const files = runFiles(paths, runId);
  try {
    return { files, state: await readJson(files.state), task: await readJson(files.task) };
  } catch (error) {
    if (error.code === 'ENOENT') throw new WorkerError('RUN_NOT_FOUND', `Run not found: ${runId}`);
    throw error;
  }
}

export function transition(state, nextStatus, patch = {}, reason = null) {
  const allowed = TRANSITIONS[state.status];
  invariant(allowed?.has(nextStatus), 'STATE_INVALID', `Cannot transition ${state.status} -> ${nextStatus}`, { runId: state.runId });
  const at = new Date().toISOString();
  return {
    ...state,
    ...patch,
    status: nextStatus,
    updatedAt: at,
    transitions: [...(state.transitions ?? []), { from: state.status, to: nextStatus, at, reason }],
  };
}

export async function updateRun(paths, runId, updater) {
  const loaded = await loadRun(paths, runId);
  const next = await updater(loaded.state, loaded);
  invariant(next?.runId === runId, 'STATE_INVALID', 'Updater changed run id');
  await writeJsonAtomic(loaded.files.state, next);
  return { ...loaded, state: next };
}

export async function withRunLock(paths, runId, action) {
  const files = runFiles(paths, runId);
  await ensureDir(files.directory);
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(files.lock, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), host: os.hostname() })}\n`);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 0 && await reclaimStaleLock(files.lock)) continue;
      throw new WorkerError('RUN_LOCKED', `Run is already being changed: ${runId}`);
    }
  }
  try {
    return await action();
  } finally {
    await handle?.close();
    await unlink(files.lock).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

function ownerIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this user cannot signal it.  Treat it
    // as live; only ESRCH proves that the owner is gone.
    return error.code !== 'ESRCH';
  }
}

async function reclaimStaleLock(lockFile, staleAfterMs = DEFAULT_STALE_LOCK_MS) {
  let raw;
  let lockStat;
  try {
    [raw, lockStat] = await Promise.all([
      readFile(lockFile, 'utf8'),
      stat(lockFile),
    ]);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    return false;
  }

  let metadata = null;
  try { metadata = JSON.parse(raw); } catch {}
  const pid = Number(metadata?.pid);
  const startedAt = Date.parse(metadata?.startedAt ?? metadata?.at ?? '');
  const ageMs = Date.now() - (Number.isFinite(startedAt) ? startedAt : lockStat.mtimeMs);
  const ownerGone = Number.isInteger(pid) && pid > 0 && !ownerIsAlive(pid);
  const malformedAndOld = (!Number.isInteger(pid) || pid <= 0) && ageMs >= staleAfterMs;
  if (!ownerGone && !malformedAndOld) return false;

  // Rename rather than unlink so we never remove a newly recreated lock in a
  // concurrent recovery attempt. A lock owner never replaces its file, so
  // this is safe once its PID is gone.
  const staleFile = `${lockFile}.stale-${process.pid}-${Date.now()}`;
  try {
    await rename(lockFile, staleFile);
    await unlink(staleFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    return false;
  }
}

/**
 * Apply a recovery-only state transition.  Normal command handlers continue
 * to use transition(), while this narrow helper allows a stale/interrupted
 * run to re-enter the closed loop without weakening ordinary state gates.
 */
export function recoverTransition(state, nextStatus, patch = {}, reason = 'recovered') {
  const allowed = {
    failed: new Set(['prepared', 'verifying', 'reviewing']),
    running: new Set(['prepared', 'verifying']),
    revising: new Set(['verifying', 'reviewing']),
  };
  invariant(allowed[state.status]?.has(nextStatus), 'STATE_INVALID', `Cannot recover ${state.status} -> ${nextStatus}`, { runId: state.runId });
  const at = new Date().toISOString();
  return {
    ...state,
    ...patch,
    status: nextStatus,
    updatedAt: at,
    transitions: [...(state.transitions ?? []), { from: state.status, to: nextStatus, at, reason }],
  };
}
