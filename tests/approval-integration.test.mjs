import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runNode, runProcess } from './helpers.mjs';
import { cli, createReviewedFixture, readState } from './workflow-fixture.mjs';

async function approve(item) {
  return runNode(cli, ['approve', '--id', item.runId, '--review', item.reviewFile, '--message', 'feat: add verified answer module'], { env: item.env });
}

test('clean source receives exactly one reviewed cherry-pick and no push', async () => {
  const item = await createReviewedFixture();
  const approved = await approve(item);
  assert.equal(approved.code, 0, approved.stderr);
  const implementationCommit = JSON.parse(approved.stdout).implementationCommit;
  const integrated = await runNode(cli, ['integrate', '--id', item.runId], { env: item.env });
  assert.equal(integrated.code, 0, integrated.stderr);
  const payload = JSON.parse(integrated.stdout);
  assert.equal(payload.status, 'integrated');
  const sourceCount = (await runProcess('git', ['rev-list', '--count', `${item.sourceHead}..HEAD`], { cwd: item.repositoryRoot })).stdout.trim();
  assert.equal(sourceCount, '1');
  assert.equal((await readState(item)).implementationCommit, implementationCommit);
  assert.match((await runProcess('git', ['log', '-1', '--format=%B'], { cwd: item.repositoryRoot })).stdout, new RegExp(`Pi-Worker-Run: ${item.runId}`));
  assert.equal((await runProcess('git', ['remote'], { cwd: item.repositoryRoot })).stdout.trim(), '');
});

test('dirty source keeps snapshot and implementation on worker branch only', async () => {
  const item = await createReviewedFixture({ dirty: true });
  const beforeStatus = (await runProcess('git', ['status', '--porcelain=v1', '-z'], { cwd: item.repositoryRoot })).stdout;
  const approved = await approve(item);
  assert.equal(approved.code, 0, approved.stderr);
  const integrated = await runNode(cli, ['integrate', '--id', item.runId], { env: item.env });
  assert.equal(integrated.code, 0, integrated.stderr);
  assert.equal(JSON.parse(integrated.stdout).status, 'blocked');
  assert.equal((await runProcess('git', ['rev-parse', 'HEAD'], { cwd: item.repositoryRoot })).stdout.trim(), item.sourceHead);
  assert.equal((await runProcess('git', ['status', '--porcelain=v1', '-z'], { cwd: item.repositoryRoot })).stdout, beforeStatus);
  assert.equal((await runProcess('git', ['rev-list', '--count', item.sourceHead + '..HEAD'], { cwd: item.worktree })).stdout.trim(), '2');
});

test('a post-verification worker edit invalidates approval evidence', async () => {
  const item = await createReviewedFixture();
  await writeFile(path.join(item.worktree, 'src', 'answer.js'), 'export const answer = 42; // changed after verification\n');
  const result = await approve(item);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'DIFF_CHANGED');
  assert.equal((await readState(item)).status, 'reviewing');
});

test('a source edit after approval blocks integration without cherry-picking', async () => {
  const item = await createReviewedFixture();
  const approved = await approve(item);
  assert.equal(approved.code, 0, approved.stderr);
  await writeFile(path.join(item.repositoryRoot, 'local-note.txt'), 'new user work\n');
  const integrated = await runNode(cli, ['integrate', '--id', item.runId], { env: item.env });
  assert.equal(integrated.code, 0, integrated.stderr);
  assert.equal(JSON.parse(integrated.stdout).status, 'blocked');
  assert.equal((await runProcess('git', ['rev-parse', 'HEAD'], { cwd: item.repositoryRoot })).stdout.trim(), item.sourceHead);
});

test('approve and integrate retries are idempotent', async () => {
  const item = await createReviewedFixture();
  const firstApprove = JSON.parse((await approve(item)).stdout);
  const secondApprove = JSON.parse((await approve(item)).stdout);
  assert.equal(secondApprove.implementationCommit, firstApprove.implementationCommit);
  const firstIntegrate = JSON.parse((await runNode(cli, ['integrate', '--id', item.runId], { env: item.env })).stdout);
  const secondIntegrate = JSON.parse((await runNode(cli, ['integrate', '--id', item.runId], { env: item.env })).stdout);
  assert.equal(secondIntegrate.integratedCommit, firstIntegrate.integratedCommit);
  assert.equal((await runProcess('git', ['rev-list', '--count', `${item.sourceHead}..HEAD`], { cwd: item.repositoryRoot })).stdout.trim(), '1');
});
