/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import assert from 'node:assert/strict';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installDefaultConfiguration, resolveWorkerPaths } from '../lib/config.mjs';
import { transition, updateRun } from '../lib/state.mjs';
import { makeTempDir, initGitRepo, runNode, runProcess, writeExecutable } from './helpers.mjs';

const skillRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = path.join(skillRoot, 'scripts', 'pi-worker.mjs');

async function fixture({ piMode = 'always-correct' } = {}) {
  const home = await makeTempDir('pi-verify-home-');
  const repositoryRoot = await initGitRepo(path.join(home, 'source'));
  await mkdir(path.join(repositoryRoot, 'src'), { recursive: true });
  await writeFile(path.join(repositoryRoot, 'src', 'old.js'), 'export const old = true;\n');
  await runProcess('git', ['add', 'src/old.js'], { cwd: repositoryRoot });
  await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-m', 'test: add allowed source'], { cwd: repositoryRoot });
  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  // These tests focus on verify/revise/approve mechanics; disable selfReview so verify -> reviewing directly.
  const cfg = JSON.parse(await readFile(paths.configFile, 'utf8'));
  cfg.selfReview = { enabled: false };
  await writeFile(paths.configFile, JSON.stringify(cfg));
  const pi = path.join(home, 'bin', 'pi');
  await writeExecutable(pi, `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.80.10'); process.exit(0); }
if (args.includes('--list-models')) { console.log('volcengine-plan/ark-code-latest'); process.exit(0); }
const counterFile = path.join(process.env.HOME, 'revision-counter');
let count = 0;
try { count = Number(readFileSync(counterFile, 'utf8')); } catch {}
writeFileSync(counterFile, String(count + 1));
const piMode = ${JSON.stringify(piMode)};
const value = piMode === 'repair-on-second' && count === 0 ? 7 : 42;
mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
writeFileSync(path.join(process.cwd(), 'src', 'result.js'), 'export const value = ' + value + ';\\n');
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'volcengine-plan', model: 'ark-code-latest', stopReason: 'stop', content: [], usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
`);
  const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const runId = `verify-${Math.random().toString(16).slice(2)}`;
  const taskFile = path.join(home, 'task.json');
  await writeFile(taskFile, JSON.stringify({
    schemaVersion: 1, runId, repositoryRoot, baseRevision: head,
    goal: 'Create src/result.js with the verified numeric export',
    allowedPaths: ['src/**', 'tests/**'], forbiddenPaths: ['.env*', '.git/**'],
    constraints: ['Do not alter README.md'], acceptanceCriteria: ['src/result.js exports value=42'],
    verification: [{ argv: [process.execPath, '-e', "import('./src/result.js').then(m=>process.exit(m.value===42?0:1))"], timeoutSeconds: 10, env: { CI: '1' } }],
    requiredCapabilities: ['text', 'code', 'tool-use'], risk: 'medium',
  }));
  const env = { ...process.env, HOME: home, PI_WORKER_CONFIG: paths.configFile, PI_WORKER_MODELS_FILE: paths.modelsFile, PI_WORKER_STATE_DIR: paths.stateRoot, PI_WORKER_CACHE_DIR: paths.cacheRoot, PI_WORKER_PI_BIN: pi, VOLCENGINE_API_KEY: 'test-key-not-real' };
  const prepared = await runNode(cli, ['prepare', '--task', taskFile], { env });
  assert.equal(prepared.code, 0, prepared.stderr);
  const payload = JSON.parse(prepared.stdout);
  return { home, repositoryRoot, paths, pi, env, runId, worktree: payload.worktreePath };
}

async function forceVerifying(item) {
  await updateRun(item.paths, item.runId, (state) => transition(transition(state, 'running'), 'verifying'));
}

test('safe diff runs verification outside Pi and advances to review', async () => {
  const item = await fixture();
  await forceVerifying(item);
  await writeFile(path.join(item.worktree, 'src', 'result.js'), 'export const value = 42;\n');
  const result = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'reviewing');
  assert.equal(payload.passed, true);
  const evidence = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'verification.json'), 'utf8'));
  assert.equal(evidence.commands[0].argv[0], process.execPath);
  assert.equal(evidence.commands[0].code, 0);
});

test('verification failure is reviewable rather than silently approved', async () => {
  const item = await fixture();
  await forceVerifying(item);
  await writeFile(path.join(item.worktree, 'src', 'result.js'), 'export const value = 7;\n');
  const result = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).passed, false);
  const state = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'state.json'), 'utf8'));
  assert.equal(state.status, 'reviewing');
});

test('truncated verification output fails closed and cannot be approved', async () => {
  const item = await fixture();
  await forceVerifying(item);
  await writeFile(path.join(item.worktree, 'src', 'result.js'), 'export const value = 42;\n');
  const taskPath = path.join(item.paths.stateRoot, 'runs', item.runId, 'task.json');
  const task = JSON.parse(await readFile(taskPath, 'utf8'));
  task.verification = [{ argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(65))"], timeoutSeconds: 10, env: { CI: '1' } }];
  await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`);
  const config = JSON.parse(await readFile(item.paths.configFile, 'utf8'));
  config.limits.maxCapturedCharsPerStream = 64;
  await writeFile(item.paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
  const result = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'VERIFICATION_OUTPUT_TRUNCATED');
  const evidence = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'verification.json'), 'utf8'));
  assert.equal(evidence.commands[0].stdoutTruncated, true);
  assert.equal(evidence.commands[0].passed, false);
  const state = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'state.json'), 'utf8'));
  assert.equal(state.status, 'blocked');
});

test('oversized worker diff blocks with persisted DIFF_TOO_LARGE evidence', async () => {
  const item = await fixture();
  await forceVerifying(item);
  const config = JSON.parse(await readFile(item.paths.configFile, 'utf8'));
  config.limits.maxDiffBytes = 64;
  await writeFile(item.paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(path.join(item.worktree, 'src', 'huge.js'), `export const payload = '${'x'.repeat(128)}';\n`);
  const result = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.error.code, 'SECURITY_BLOCKED');
  assert.ok(error.error.details.issues.some((issue) => issue.code === 'DIFF_TOO_LARGE'));
  const evidence = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'verification.json'), 'utf8'));
  assert.equal(evidence.passed, false);
  assert.ok(evidence.security.issues.some((issue) => issue.code === 'DIFF_TOO_LARGE'));
  const state = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'state.json'), 'utf8'));
  assert.equal(state.status, 'blocked');
});

test('a failed first verification can be revised once and then pass', async () => {
  const item = await fixture({ piMode: 'repair-on-second' });
  const run = await runNode(cli, ['run', '--id', item.runId], { env: item.env });
  assert.equal(run.code, 0, run.stderr);
  const failed = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
  assert.equal(failed.code, 0, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).passed, false);
  const firstVerification = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'verification.json'), 'utf8'));
  const reviewFile = path.join(item.home, 'repair-review.json');
  await writeFile(reviewFile, JSON.stringify({ schemaVersion: 1, verdict: 'revise', diffSha256: firstVerification.security.diffSha256, findings: [{ priority: 'P1', file: 'src/result.js', line: 1, problem: 'The exported value is incorrect', evidence: 'Independent verification exits 1 for value 7', requiredChange: 'Export value 42' }], verificationGaps: [], summary: 'Correct the failed acceptance value.' }));
  const revised = await runNode(cli, ['revise', '--id', item.runId, '--review', reviewFile], { env: item.env });
  assert.equal(revised.code, 0, revised.stderr);
  assert.equal(JSON.parse(revised.stdout).revisionRound, 1);
  const passed = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
  assert.equal(passed.code, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).passed, true);
  assert.equal(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'pi-home', 'revision-counter'), 'utf8'), '2');
});

for (const [name, mutate, expectedCode] of [
  ['path escape', async (item) => writeFile(path.join(item.worktree, 'README.md'), '# overwritten\n'), 'PATH_OUT_OF_SCOPE'],
  ['probable secret', async (item) => writeFile(path.join(item.worktree, 'src', 'leak.js'), "export const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz123456';\n"), 'SECRET_DETECTED'],
  ['binary change', async (item) => writeFile(path.join(item.worktree, 'src', 'blob.bin'), Buffer.from([0, 1, 2, 3])), 'BINARY_CHANGE'],
  ['excessive deletion', async (item) => rm(path.join(item.worktree, 'src', 'old.js')), 'EXCESSIVE_DELETION'],
]) {
  test(`${name} blocks before verification`, async () => {
    const item = await fixture();
    await forceVerifying(item);
    await mutate(item);
    const result = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
    assert.equal(result.code, 1);
    const error = JSON.parse(result.stderr);
    assert.equal(error.error.code, 'SECURITY_BLOCKED');
    assert.ok(error.error.details.issues.some((issue) => issue.code === expectedCode));
    const state = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'state.json'), 'utf8'));
    assert.equal(state.status, 'blocked');
  });
}

test('a structured revise turn returns to verifying and is limited to two rounds', async () => {
  const item = await fixture();
  const run = await runNode(cli, ['run', '--id', item.runId], { env: item.env });
  assert.equal(run.code, 0, run.stderr);
  const firstVerify = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
  assert.equal(firstVerify.code, 0, firstVerify.stderr);
  const firstVerification = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'verification.json'), 'utf8'));
  const reviewFile = path.join(item.home, 'review.json');
  await writeFile(reviewFile, JSON.stringify({ schemaVersion: 1, verdict: 'revise', diffSha256: firstVerification.security.diffSha256, findings: [{ priority: 'P2', file: 'src/result.js', line: 1, problem: 'Require an explicit regression comment', evidence: 'Comment is absent', requiredChange: 'Add a concise regression comment without changing value' }], verificationGaps: [], summary: 'One required source clarification remains.' }));
  for (let round = 1; round <= 2; round += 1) {
    const revised = await runNode(cli, ['revise', '--id', item.runId, '--review', reviewFile], { env: item.env });
    assert.equal(revised.code, 0, revised.stderr);
    assert.equal(JSON.parse(revised.stdout).revisionRound, round);
    const verified = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
    assert.equal(verified.code, 0, verified.stderr);
  }
  const third = await runNode(cli, ['revise', '--id', item.runId, '--review', reviewFile], { env: item.env });
  assert.equal(third.code, 1);
  assert.equal(JSON.parse(third.stderr).error.code, 'REVISION_LIMIT');
  const finalState = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'state.json'), 'utf8'));
  assert.equal(finalState.status, 'failed');
  assert.equal(finalState.implementationCommit, null);
  assert.equal((await runProcess('git', ['rev-list', '--count', `${finalState.workerBaseRevision}..HEAD`], { cwd: item.worktree })).stdout.trim(), '0');
});

test('test credential placeholders do not trigger the generic secret guardrail', async () => {
  const item = await fixture();
  await forceVerifying(item);
  await writeFile(path.join(item.worktree, 'src', 'fixtures.js'), [
    "export const fixtures = { apiKey: 'super-secret', token: 'should-not-leak', clientSecret: 'test-key-not-real' };",
  ].join('\n'));
  await writeFile(path.join(item.worktree, 'src', 'result.js'), 'export const value = 42;\n');
  const result = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).passed, true);
});
