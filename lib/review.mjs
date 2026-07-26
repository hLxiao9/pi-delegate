/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './atomic-json.mjs';
import { loadConfig, resolveWorkerPaths } from './config.mjs';
import { validateReviewResult } from './contracts.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { getHead, git, sourceUnchanged } from './git-worker.mjs';
import { scanCommitDelta, scanWorkerDelta } from './security.mjs';
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
  invariant(['selfReviewing', 'reviewing', 'approved'].includes(loaded.state.status), 'STATE_INVALID', `approve requires selfReviewing, reviewing, or recoverable approved state, found ${loaded.state.status}`);
  const config = await loadConfig(paths);
  const review = validateReviewResult(JSON.parse(await readFile(path.resolve(options.review), 'utf8')));
  invariant(review.verdict === 'approve', 'REVIEW_INVALID', 'approve requires verdict=approve');
  const verification = await readJson(loaded.files.verification);
  invariant(verification.passed && verification.security?.passed, 'REVIEW_GATE', 'Latest independent verification or security scan did not pass');
  invariant(await sourceUnchanged(paths, loaded.state, env), 'SOURCE_CHANGED', 'Source changed after verification');
  const security = await scanWorkerDelta({ paths, state: loaded.state, task: loaded.task, config, env });
  invariant(security.passed, 'SECURITY_BLOCKED', 'Worker diff failed re-scan', { issues: security.issues });
  if (review.diffSha256 !== verification.security.diffSha256 || review.diffSha256 !== security.diffSha256) {
  throw new WorkerError('DIFF_CHANGED', 'Parent review does not match the independently verified worker diff', {
  expected: verification.security.diffSha256,
  actual: security.diffSha256,
  });
  }
  await writeJsonAtomic(loaded.files.review, review);
  // selfReviewing state approve = parent skips self-review directly review;first transition to reviewing then go through approve flow.
  if (loaded.state.status === 'selfReviewing') {
  await updateRun(paths, options.id, (state) => transition(state, 'reviewing', { selfReviewSkipped: true, selfReviewSkipReason: 'parent-skipped' }));
  loaded = await loadRun(paths, options.id);
  }
  if (loaded.state.status === 'reviewing') {
  await updateRun(paths, options.id, (state) => transition(state, 'approved', { reviewSummary: review.summary }));
  loaded = await loadRun(paths, options.id);
  }
  const recovered = await recoverApprovedCommit(paths, loaded, env);
  if (recovered) {
  // Re-scan the recovered commit diff to close the TOCTOU window between
  // scanWorkerDelta (which scans worktree state) and recoverApprovedCommit
  // (which reads HEAD). Ensures the committed content matches what was
  // reviewed (issue #1 P1-2).
  const commitScan = await scanCommitDelta({ paths, state: loaded.state, task: loaded.task, config, headCommit: recovered, env });
  invariant(commitScan.passed, 'SECURITY_BLOCKED', 'Recovered commit failed security re-scan', { issues: commitScan.issues });
  if (commitScan.diffSha256 !== security.diffSha256) {
  throw new WorkerError('DIFF_CHANGED', 'Recovered commit diff does not match the independently verified worker diff', {
  expected: security.diffSha256,
  actual: commitScan.diffSha256,
  });
  }
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
  // commit stays on failure approved status(retryable),rather than transition to failed(unrecoverable).
  // recoverCommand only accepts PI_INTERRUPTED/PI_TIMEOUT  failed,COMMIT_FAILED will permanently bricked.
  // commit failure usually is hooks/lock/I/O temporary issue,keep approved lets user retry approve.
  await updateRun(paths, options.id, (state) => ({
  ...state,
  commitFailure: { code: error.code ?? 'COMMIT_FAILED', message: error.message, at: new Date().toISOString() },
  updatedAt: new Date().toISOString(),
  }));
  throw error;
  }
  });
}
