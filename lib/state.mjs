import { open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic } from './atomic-json.mjs';
import { WorkerError, invariant } from './errors.mjs';

export const TERMINAL_STATUSES = new Set(['integrated', 'failed', 'blocked']);
const TRANSITIONS = {
  prepared: new Set(['running', 'failed', 'blocked']),
  running: new Set(['verifying', 'failed', 'blocked']),
  verifying: new Set(['reviewing', 'failed', 'blocked']),
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
  try {
    handle = await open(files.lock, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
  } catch (error) {
    if (error.code === 'EEXIST') throw new WorkerError('RUN_LOCKED', `Run is already being changed: ${runId}`);
    throw error;
  }
  try {
    return await action();
  } finally {
    await handle?.close();
    await unlink(files.lock).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}
