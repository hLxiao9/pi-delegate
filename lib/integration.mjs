import { access } from 'node:fs/promises';
import { loadConfig, resolveWorkerPaths } from './config.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { currentBranch, getHead, git, sourceUnchanged } from './git-worker.mjs';
import { loadRun, transition, updateRun, withRunLock } from './state.mjs';
import { executeVerification } from './verification.mjs';

async function recoveredIntegration(paths, state, env) {
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
    invariant(loaded.state.status === 'integrated', 'STATE_INVALID', 'cleanup only removes worktrees for integrated runs');
    await access(loaded.files.report);
    try {
      await git(paths, loaded.state.sourceRoot, ['worktree', 'remove', loaded.state.worktreePath], { env });
    } catch (error) {
      if (error.code !== 'GIT_FAILED') throw error;
      const present = await access(loaded.state.worktreePath).then(() => true).catch(() => false);
      if (present) throw error;
    }
    await git(paths, loaded.state.sourceRoot, ['branch', '-d', loaded.state.workerBranch], { env, allowFailure: true });
    const cleanedAt = new Date().toISOString();
    await updateRun(paths, options.id, (state) => ({ ...state, cleanedAt, updatedAt: cleanedAt }));
    return { runId: options.id, status: 'integrated', cleaned: true, retainedRunDirectory: loaded.files.directory };
  });
}
