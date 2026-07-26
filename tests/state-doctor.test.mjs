/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import assert from 'node:assert/strict';
import { access, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installDefaultConfiguration, resolveWorkerPaths } from '../lib/config.mjs';
import { abortActiveProcesses, runProcess } from '../lib/process.mjs';
import { createRun, loadRun, transition, updateRun, withRunLock } from '../lib/state.mjs';
import { makeTempDir, runNode, writeExecutable } from './helpers.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = path.join(root, 'scripts', 'pi-worker.mjs');

async function fixture() {
  const home = await makeTempDir('pi-doctor-');
  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  const pi = path.join(home, 'bin', 'pi');
  await writeExecutable(pi, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('0.80.10');
else if (args.includes('--list-models')) console.log('volcengine-plan/ark-code-latest');
else process.exitCode = 2;
`);
  const env = {
    ...process.env,
    HOME: home,
    PI_WORKER_CONFIG: paths.configFile,
    PI_WORKER_MODELS_FILE: paths.modelsFile,
    PI_WORKER_STATE_DIR: paths.stateRoot,
    PI_WORKER_CACHE_DIR: paths.cacheRoot,
    PI_WORKER_PI_BIN: pi,
    VOLCENGINE_API_KEY: 'test-key-not-real',
  };
  return { home, paths, pi, env };
}

test('state transitions are persisted and illegal skips are rejected', async () => {
  const { paths } = await fixture();
  const initial = { schemaVersion: 1, runId: 'state-test', status: 'prepared', revisionRound: 0, transitions: [] };
  await createRun(paths, initial, { schemaVersion: 1, runId: 'state-test' });
  await updateRun(paths, 'state-test', (state) => transition(state, 'running'));
  assert.equal((await loadRun(paths, 'state-test')).state.status, 'running');
  assert.throws(() => transition({ ...initial }, 'approved'), (error) => error.code === 'STATE_INVALID');
});

test('process runner times out and reports a terminated process', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test('aborting active processes terminates the worker and records an interruption', async () => {
  const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(abortActiveProcesses('SIGTERM'), 1);
  const result = await running;
  assert.equal(result.interrupted, true);
  assert.notEqual(result.code, 0);
});

test('timeout terminates descendants in the spawned process group', async () => {
  const home = await makeTempDir('pi-process-tree-');
  const heartbeat = path.join(home, 'heartbeat');
  const childSource = "const fs=require('node:fs'); const file=process.argv[1]; setInterval(()=>fs.appendFileSync(file,'x'),20)";
  const parentSource = "const fs=require('node:fs'); const {spawn}=require('node:child_process'); fs.writeFileSync(process.argv[2],'ready'); spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'ignore'}); setInterval(()=>{},1000)";
  const result = await runProcess(process.execPath, ['-e', parentSource, childSource, heartbeat], { timeoutMs: 150 });
  assert.equal(result.timedOut, true);
  const firstSize = (await stat(heartbeat)).size;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await stat(heartbeat)).size, firstSize);
});

test('withRunLock reclaims a lock whose owner process is gone', async () => {
  const { paths } = await fixture();
  const runId = 'stale-lock-test';
  const initial = { schemaVersion: 1, runId, status: 'prepared', revisionRound: 0, transitions: [] };
  const files = await createRun(paths, initial, { schemaVersion: 1, runId });
  await writeFile(files.lock, `${JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString() })}\n`);
  const result = await withRunLock(paths, runId, async () => 'recovered');
  assert.equal(result, 'recovered');
  await assert.rejects(access(files.lock), { code: 'ENOENT' });
});

test('doctor validates Pi, model, key, and config without creating a run', async () => {
  const { paths, env } = await fixture();
  const result = await runNode(cli, ['doctor'], { env });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'ready');
  await assert.rejects(access(path.join(paths.stateRoot, 'runs')), { code: 'ENOENT' });
});

test('doctor stops on missing credentials before any run or worktree', async () => {
  const { paths, env } = await fixture();
  delete env.VOLCENGINE_API_KEY;
  const result = await runNode(cli, ['doctor'], { env });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'DOCTOR_FAILED');
  await assert.rejects(access(path.join(paths.cacheRoot, 'worktrees')), { code: 'ENOENT' });
});

test('doctor rejects literal provider secrets in models.json', async () => {
  const { paths, env } = await fixture();
  const models = JSON.parse(await readFile(paths.modelsFile, 'utf8'));
  models.providers['volcengine-plan'].apiKey = 'literal-secret';
  await writeFile(paths.modelsFile, JSON.stringify(models));
  const result = await runNode(cli, ['doctor'], { env });
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stderr).error.message, /environment variable reference/);
});

test('doctor reports a missing Pi executable as a preflight failure', async () => {
  const { paths, env } = await fixture();
  env.PI_WORKER_PI_BIN = path.join(paths.stateRoot, 'missing-pi');
  const result = await runNode(cli, ['doctor'], { env });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'DOCTOR_FAILED');
  await assert.rejects(access(path.join(paths.stateRoot, 'runs')), { code: 'ENOENT' });
});

test('doctor rejects an unsupported Pi version', async () => {
  const { paths, pi, env } = await fixture();
  await writeExecutable(pi, `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('0.79.9');
else console.log('volcengine-plan/ark-code-latest');
`);
  const result = await runNode(cli, ['doctor'], { env });
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stderr).error.message, /0\.80\.10\+/);
  await assert.rejects(access(path.join(paths.cacheRoot, 'worktrees')), { code: 'ENOENT' });
});

test('doctor rejects a configured model missing from Pi', async () => {
  const { paths, pi, env } = await fixture();
  await writeExecutable(pi, `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('0.80.10');
else if (process.argv.includes('--list-models')) console.log('volcengine-plan/different-model');
`);
  const result = await runNode(cli, ['doctor'], { env });
  assert.equal(result.code, 1);
  assert.match(JSON.parse(result.stderr).error.message, /Model is not available/);
  await assert.rejects(access(path.join(paths.stateRoot, 'runs')), { code: 'ENOENT' });
});

async function assertPreflightFailure(paths, result) {
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'DOCTOR_FAILED');
  await assert.rejects(access(path.join(paths.stateRoot, 'runs')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(paths.cacheRoot, 'worktrees')), { code: 'ENOENT' });
}

test('doctor redacts Pi diagnostics from structured failures', async () => {
  const { paths, pi, env } = await fixture();
  const sentinel = 'review-secret-should-not-appear';
  await writeExecutable(pi, `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('0.80.10');
else if (process.argv.includes('--list-models')) { console.error('${sentinel}'); process.exitCode = 2; }
`);
  const result = await runNode(cli, ['doctor'], { env });
  await assertPreflightFailure(paths, result);
  assert.doesNotMatch(result.stdout, new RegExp(sentinel));
  assert.doesNotMatch(result.stderr, new RegExp(sentinel));
  assert.doesNotMatch(JSON.stringify(JSON.parse(result.stderr).error.details), new RegExp(sentinel));
});

test('doctor normalizes invalid config to a sanitized preflight failure', async () => {
  const { paths, env } = await fixture();
  await writeFile(paths.configFile, '{}');
  const result = await runNode(cli, ['doctor'], { env });
  await assertPreflightFailure(paths, result);
});

test('doctor normalizes corrupt or missing models data to a preflight failure', async () => {
  const { paths, env } = await fixture();
  await writeFile(paths.modelsFile, '{invalid json');
  await assertPreflightFailure(paths, await runNode(cli, ['doctor'], { env }));
  await unlink(paths.modelsFile);
  await assertPreflightFailure(paths, await runNode(cli, ['doctor'], { env }));
  await writeFile(paths.modelsFile, JSON.stringify({ providers: {} }));
  await assertPreflightFailure(paths, await runNode(cli, ['doctor'], { env }));
});

test('doctor normalizes invalid task contract to a preflight failure', async () => {
  const { home, paths, env } = await fixture();
  const task = path.join(home, 'invalid-task.json');
  await writeFile(task, '{}');
  await assertPreflightFailure(paths, await runNode(cli, ['doctor', '--task', task], { env }));
});
