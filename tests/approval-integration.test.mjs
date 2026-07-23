import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runNode, runProcess } from './helpers.mjs';
import { cli, createReviewedFixture, readState } from './workflow-fixture.mjs';

async function approve(item) {
  return runNode(cli, ['approve', '--id', item.runId, '--review', item.reviewFile, '--message', 'feat: add verified answer module'], { env: item.env });
}

async function verificationDiffSha256(item) {
  const verification = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'verification.json'), 'utf8'));
  return verification.security.diffSha256;
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

test('an approval review from before a revision cannot approve the new verified diff', async () => {
  const item = await createReviewedFixture();
  const oldReview = JSON.parse(await readFile(item.reviewFile, 'utf8'));
  oldReview.diffSha256 = await verificationDiffSha256(item);
  await writeFile(item.reviewFile, JSON.stringify(oldReview));
  const reviseFile = path.join(item.home, 'revise-review.json');
  await writeFile(reviseFile, JSON.stringify({
    schemaVersion: 1,
    verdict: 'revise',
    diffSha256: oldReview.diffSha256,
    findings: [{ priority: 'P1', file: 'src/answer.js', line: 1, problem: 'Add a scoped companion module', evidence: 'The reviewed implementation lacks the companion module', requiredChange: 'Create src/companion.js' }],
    verificationGaps: [],
    summary: 'One scoped implementation change is required.',
  }));
  const revised = await runNode(cli, ['revise', '--id', item.runId, '--review', reviseFile], { env: item.env });
  assert.equal(revised.code, 0, revised.stderr);
  await writeFile(path.join(item.worktree, 'src', 'companion.js'), 'export const companion = true;\n');
  const verified = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
  assert.equal(verified.code, 0, verified.stderr);
  assert.notEqual(await verificationDiffSha256(item), oldReview.diffSha256);
  const result = await approve(item);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'DIFF_CHANGED');
  assert.equal((await readState(item)).implementationCommit, null);
});

test('crash recovery blocks when user changes the source after a cherry-pick', async () => {
  const item = await createReviewedFixture();
  const approved = await approve(item);
  assert.equal(approved.code, 0, approved.stderr);
  const implementationCommit = JSON.parse(approved.stdout).implementationCommit;
  await runProcess('git', ['cherry-pick', implementationCommit], { cwd: item.repositoryRoot });
  const integratedHead = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: item.repositoryRoot })).stdout.trim();
  await writeFile(path.join(item.repositoryRoot, 'local-note.txt'), 'user changed source after crash\n');
  const beforeStatus = (await runProcess('git', ['status', '--porcelain=v1', '-z'], { cwd: item.repositoryRoot })).stdout;
  const result = await runNode(cli, ['integrate', '--id', item.runId], { env: item.env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'blocked');
  assert.equal((await readState(item)).status, 'blocked');
  assert.equal((await runProcess('git', ['rev-parse', 'HEAD'], { cwd: item.repositoryRoot })).stdout.trim(), integratedHead);
  assert.equal((await runProcess('git', ['status', '--porcelain=v1', '-z'], { cwd: item.repositoryRoot })).stdout, beforeStatus);
});
