/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { resolveWorkerPaths } from './config.mjs';
import { invariant } from './errors.mjs';
import { git } from './git-worker.mjs';
import { loadRun, recoverTransition, updateRun, withRunLock } from './state.mjs';

const ACTIVE_RECOVERY_STATUSES = new Set(['running', 'revising']);

async function worktreeChanged(paths, state, env) {
  const result = await git(paths, state.worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { env, allowTruncated: true });
  return result.stdout.length > 0;
}

function recoveryTarget(status, changed, interruption = null) {
  const sourceStatus = interruption?.recoverableFrom ?? status;
  if (sourceStatus === 'revising' || status === 'revising') return changed ? 'verifying' : 'reviewing';
  return changed ? 'verifying' : 'prepared';
}

export async function recoverCommand(options = {}, runtime = {}) {
  invariant(options.id, 'CLI_USAGE', 'recover requires --id', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  return withRunLock(paths, options.id, async () => {
    const loaded = await loadRun(paths, options.id);
    const { state } = loaded;

    if (['integrated', 'blocked'].includes(state.status)) {
      return { runId: options.id, status: state.status, recovered: false, reason: 'terminal' };
    }
    if (['prepared', 'verifying', 'selfReviewing', 'reviewing', 'approved', 'committed'].includes(state.status)) {
      return { runId: options.id, status: state.status, recovered: false, reason: 'already-resumable' };
    }
    invariant(ACTIVE_RECOVERY_STATUSES.has(state.status) || (state.status === 'failed' && ['PI_INTERRUPTED', 'PI_TIMEOUT'].includes(state.failure?.code)), 'STATE_INVALID', `Run is not recoverable from ${state.status}`);

    const changed = await worktreeChanged(paths, state, env);
    const target = recoveryTarget(state.status, changed, state.interruption);
    const reason = changed ? 'worktree-changed' : 'no-worktree-change';
    const updated = await updateRun(paths, options.id, (current) => recoverTransition(current, target, {
      recovery: {
        recoveredAt: new Date().toISOString(),
        from: current.status,
        status: target,
        reason,
        nextCommand: target === 'prepared' ? `run --id ${options.id}` : target === 'verifying' ? `verify --id ${options.id}` : `review/revise --id ${options.id}`,
      },
    }, `recovered ${reason}`));
    return {
      runId: options.id,
      status: updated.state.status,
      recovered: true,
      reason,
      nextCommand: updated.state.recovery.nextCommand,
    };
  });
}
