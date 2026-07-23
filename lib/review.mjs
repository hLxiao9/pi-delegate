import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './atomic-json.mjs';
import { loadConfig, resolveWorkerPaths } from './config.mjs';
import { validateReviewResult } from './contracts.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { getHead, git, sourceUnchanged } from './git-worker.mjs';
import { scanWorkerDelta } from './security.mjs';
import { loadRun, transition, updateRun, withRunLock } from './state.mjs';

async function recoverApprovedCommit(paths, loaded, env) {
  const head = await getHead(paths, loaded.state.worktreePath, env);
  if (head === loaded.state.workerBaseRevision) return null;
  const count = (await git(paths, loaded.state.worktreePath, ['rev-list', '--count', `${loaded.state.workerBaseRevision}..${head}`], { env })).stdout.trim();
  const body = (await git(paths, loaded.state.worktreePath, ['show', '-s', '--format=%B', head], { env })).stdout;
  return count === '1' && body.includes(`Pi-Worker-Run: ${loaded.state.runId}`) ? head : null;
}

export async function approveCommand(options = {}, runtime = {}) {
  invariant(options.id && options.review && options.message, 'CLI_USAGE', 'approve requires --id, --review, and --message', {}, 2);
  invariant(options.message.length <= 200 && !/[\r\n]/.test(options.message), 'CLI_USAGE', 'Commit message must be one line and at most 200 characters', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  return withRunLock(paths, options.id, async () => {
    let loaded = await loadRun(paths, options.id);
    if (loaded.state.status === 'committed' || loaded.state.status === 'integrated') {
      return { runId: options.id, status: loaded.state.status, implementationCommit: loaded.state.implementationCommit };
    }
    invariant(['reviewing', 'approved'].includes(loaded.state.status), 'STATE_INVALID', `approve requires reviewing or recoverable approved state, found ${loaded.state.status}`);
    const config = await loadConfig(paths);
    const review = validateReviewResult(JSON.parse(await readFile(path.resolve(options.review), 'utf8')));
    invariant(review.verdict === 'approve', 'REVIEW_INVALID', 'approve requires verdict=approve');
    const verification = await readJson(loaded.files.verification);
    invariant(verification.passed && verification.security?.passed, 'REVIEW_GATE', 'Latest independent verification or security scan did not pass');
    invariant(await sourceUnchanged(paths, loaded.state, env), 'SOURCE_CHANGED', 'Source changed after verification');
    const security = await scanWorkerDelta({ paths, state: loaded.state, task: loaded.task, config, env });
    invariant(security.passed, 'SECURITY_BLOCKED', 'Worker diff failed re-scan', { issues: security.issues });
    if (security.diffSha256 !== verification.security.diffSha256) {
      throw new WorkerError('DIFF_CHANGED', 'Worker diff changed after independent verification', { expected: verification.security.diffSha256, actual: security.diffSha256 });
    }
    await writeJsonAtomic(loaded.files.review, review);
    if (loaded.state.status === 'reviewing') {
      await updateRun(paths, options.id, (state) => transition(state, 'approved', { reviewSummary: review.summary }));
      loaded = await loadRun(paths, options.id);
    }
    const recovered = await recoverApprovedCommit(paths, loaded, env);
    if (recovered) {
      const updated = await updateRun(paths, options.id, (state) => transition(state, 'committed', { implementationCommit: recovered }, 'recovered existing implementation commit'));
      return { runId: options.id, status: updated.state.status, implementationCommit: recovered };
    }
    try {
      await git(paths, loaded.state.worktreePath, ['add', '-A'], { env });
      const staged = await git(paths, loaded.state.worktreePath, ['diff', '--cached', '--quiet'], { env, allowFailure: true });
      invariant(staged.code === 1, 'REVIEW_GATE', 'No staged implementation change exists');
      const message = `${options.message}\n\nPi-Worker-Run: ${options.id}\nPi-Worker-Model: ${loaded.state.provider}/${loaded.state.model}\nPi-Worker-Verification: passed`;
      await git(paths, loaded.state.worktreePath, ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-m', message], { env });
      const implementationCommit = await getHead(paths, loaded.state.worktreePath, env);
      const updated = await updateRun(paths, options.id, (state) => transition(state, 'committed', { implementationCommit }));
      return { runId: options.id, status: updated.state.status, implementationCommit };
    } catch (error) {
      await updateRun(paths, options.id, (state) => transition(state, 'failed', { failure: { code: error.code ?? 'COMMIT_FAILED', message: error.message } }, 'commit failed'));
      throw error;
    }
  });
}
