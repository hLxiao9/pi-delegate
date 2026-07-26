/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { access } from 'node:fs/promises';
import { loadConfig, resolveWorkerPaths } from './config.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { currentBranch, getHead, git, sourceUnchanged } from './git-worker.mjs';
import { loadRun, transition, updateRun, withRunLock } from './state.mjs';
import { executeVerification } from './verification.mjs';

async function recoveredIntegration(paths, state, env) {
  const branch = await currentBranch(paths, state.sourceRoot, env);
  if (branch !== state.sourceBranch) return null;
  const status = await git(paths, state.sourceRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { env });
  if (status.stdout !== '') return null;
  const head = await getHead(paths, state.sourceRoot, env);
  if (head === state.sourceHead) return null;
  const parent = (await git(paths, state.sourceRoot, ['rev-parse', `${head}^`], { env, allowFailure: true })).stdout.trim();
  const body = (await git(paths, state.sourceRoot, ['show', '-s', '--format=%B', head], { env, allowFailure: true })).stdout;
  return parent === state.sourceHead && body.includes(`Pi-Worker-Run: ${state.runId}`) ? head : null;
}

export async function integrateCommand(options = {}, runtime = {}) {
  invariant(options.id, 'CLI_USAGE', 'integrate requires --id', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  return withRunLock(paths, options.id, async () => {
  let loaded = await loadRun(paths, options.id);
  if (loaded.state.status === 'integrated') return { runId: options.id, status: 'integrated', integratedCommit: loaded.state.integratedCommit, pushed: false };
  invariant(loaded.state.status === 'committed', 'STATE_INVALID', `integrate requires committed state, found ${loaded.state.status}`);
  const config = await loadConfig(paths);
  if (loaded.state.sourceDirty || !config.autoIntegrateCleanSource) {
  const updated = await updateRun(paths, options.id, (state) => transition(state, 'blocked', { blockedReason: loaded.state.sourceDirty ? 'source was dirty at task start; keep snapshot and implementation on worker branch' : 'automatic integration disabled' }));
  return { runId: options.id, status: updated.state.status, reason: updated.state.blockedReason, workerBranch: updated.state.workerBranch, pushed: false };
  }
  const recovered = await recoveredIntegration(paths, loaded.state, env);
  let integratedCommit = recovered;
  if (!integratedCommit) {
  if (!(await sourceUnchanged(paths, loaded.state, env))) {
  const updated = await updateRun(paths, options.id, (state) => transition(state, 'blocked', { blockedReason: 'source changed while worker was running' }));
  return { runId: options.id, status: updated.state.status, reason: updated.state.blockedReason, workerBranch: updated.state.workerBranch, pushed: false };
  }
  const branch = await currentBranch(paths, loaded.state.sourceRoot, env);
  if (branch !== loaded.state.sourceBranch) {
  const updated = await updateRun(paths, options.id, (state) => transition(state, 'blocked', { blockedReason: 'source branch changed while worker was running' }));
  return { runId: options.id, status: updated.state.status, reason: updated.state.blockedReason, workerBranch: updated.state.workerBranch, pushed: false };
  }
  try {
  await git(paths, loaded.state.sourceRoot, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'cherry-pick', loaded.state.implementationCommit], { env });
  integratedCommit = await getHead(paths, loaded.state.sourceRoot, env);
  } catch (error) {
  await git(paths, loaded.state.sourceRoot, ['cherry-pick', '--abort'], { env, allowFailure: true });
  if (!(await sourceUnchanged(paths, loaded.state, env))) {
  throw new WorkerError('INTEGRATION_RECOVERY_FAILED', 'Cherry-pick failed and source could not be restored exactly', { cause: error.message });
  }
  const updated = await updateRun(paths, options.id, (state) => transition(state, 'blocked', {
  blockedReason: 'reviewed commit could not be cherry-picked cleanly; source was restored',
  }, 'integration conflict'));
  return { runId: options.id, status: updated.state.status, reason: updated.state.blockedReason, workerBranch: updated.state.workerBranch, pushed: false };
  }
  }
  const commands = await executeVerification({ specifications: loaded.task.verification, cwd: loaded.state.sourceRoot, env, config });
  const passed = commands.every((command) => command.passed);
  if (!passed) {
  await updateRun(paths, options.id, (state) => transition(state, 'blocked', { integratedCommit, postIntegrationVerification: { passed, commands } }, 'post-integration verification failed'));
  throw new WorkerError('POST_INTEGRATE_VERIFY_FAILED', 'Post-integration verification failed; reviewed commit remains in source history', { integratedCommit });
  }
  const updated = await updateRun(paths, options.id, (state) => transition(state, 'integrated', { integratedCommit, postIntegrationVerification: { passed, commands } }));
  return { runId: options.id, status: updated.state.status, integratedCommit, pushed: false };
  });
}

export async function cleanupCommand(options = {}, runtime = {}) {
  invariant(options.id, 'CLI_USAGE', 'cleanup requires --id', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  return withRunLock(paths, options.id, async () => {
  const loaded = await loadRun(paths, options.id);
  // cleanup allows integrated(normal flow)and failed/blocked(abnormal terminal state)status.
  // failed/blocked run also needs to clean up worktree and worker branch,otherwise permanently leaks disk and git refs.
  const isTerminal = ['integrated', 'failed', 'blocked'].includes(loaded.state.status);
  invariant(isTerminal, 'STATE_INVALID', `cleanup requires a terminal status (integrated/failed/blocked), found ${loaded.state.status}`);
  // report check only enforced for integrated status;failed/blocked may not have chance to generate report
  if (loaded.state.status === 'integrated') {
  await access(loaded.files.report);
  }
  try {
  // use --force to delete worktree,because may have untracked files(.gitignore matching cache/log)
  await git(paths, loaded.state.sourceRoot, ['worktree', 'remove', '--force', loaded.state.worktreePath], { env });
  } catch (error) {
  if (error.code !== 'GIT_FAILED') throw error;
  const present = await access(loaded.state.worktreePath).then(() => true).catch(() => false);
  if (present) throw error;
  }
  // use -D (force delete) rather than -d.cherry-pick worker branch commit is not ancestor of source HEAD,
  // git branch -d will refuse to delete"unmerged"branch.work integrated via cherry-pick,worker branch no longer needed.
  await git(paths, loaded.state.sourceRoot, ['branch', '-D', loaded.state.workerBranch], { env, allowFailure: true });
  const cleanedAt = new Date().toISOString();
  await updateRun(paths, options.id, (state) => ({ ...state, cleanedAt, updatedAt: cleanedAt }));
  return { runId: options.id, status: loaded.state.status, cleaned: true, retainedRunDirectory: loaded.files.directory };
  });
}
