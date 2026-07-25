import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { installDefaultConfiguration, resolveWorkerPaths } from '../lib/config.mjs';
import { createRun, loadRun } from '../lib/state.mjs';
import { recoverCommand } from '../lib/recovery.mjs';
import { makeTempDir, initGitRepo, runNode, runProcess, writeExecutable } from './helpers.mjs';

const skillRoot = path.resolve(new URL('..', import.meta.url).pathname);
const cli = path.join(skillRoot, 'scripts', 'pi-worker.mjs');

async function recoveryFixture(status = 'running', changed = false, failureCode = 'PI_INTERRUPTED') {
  const home = await makeTempDir('pi-recovery-');
  const repositoryRoot = await initGitRepo(path.join(home, 'source'));
  if (changed) await writeFile(path.join(repositoryRoot, 'partial.js'), 'export const partial = true;\n');
  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const runId = `recover-${status}-${changed ? 'changed' : 'clean'}`;
  await createRun(paths, {
    schemaVersion: 1,
    runId,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceRoot: repositoryRoot,
    sourceHead: head,
    sourceBranch: 'main',
    sourceFingerprint: { head, dirty: false, digest: 'fixture' },
    sourceDirty: false,
    worktreePath: repositoryRoot,
    workerBranch: `pi-worker/${runId}`,
    workerBaseRevision: head,
    revisionRound: status === 'revising' ? 1 : 0,
    transitions: [],
    failure: status === 'failed' ? { code: failureCode, message: failureCode === 'PI_TIMEOUT' ? 'timed out' : 'interrupted' } : undefined,
    interruption: status === 'failed' ? { recoverableFrom: 'running', reason: failureCode === 'PI_TIMEOUT' ? 'timeout' : 'interrupted', signal: 'SIGTERM' } : undefined,
  }, { schemaVersion: 1, runId });
  return { paths, runId };
}

test('recover moves an interrupted clean run back to prepared', async () => {
  const item = await recoveryFixture('failed', false);
  const result = await recoverCommand({ id: item.runId }, { paths: item.paths, env: {} });
  assert.equal(result.status, 'prepared');
  assert.equal((await loadRun(item.paths, item.runId)).state.recovery.status, 'prepared');
});

test('recover also accepts a timed-out worker run', async () => {
  const item = await recoveryFixture('failed', false, 'PI_TIMEOUT');
  const result = await recoverCommand({ id: item.runId }, { paths: item.paths, env: {} });
  assert.equal(result.status, 'prepared');
});

test('recover moves a run with partial worker output to verification', async () => {
  const item = await recoveryFixture('running', true);
  const result = await recoverCommand({ id: item.runId }, { paths: item.paths, env: {} });
  assert.equal(result.status, 'verifying');
  const state = (await loadRun(item.paths, item.runId)).state;
  assert.equal(state.recovery.reason, 'worktree-changed');
});

test('recover returns a reviewing revision to the parent without rerunning Pi', async () => {
  const item = await recoveryFixture('revising', false);
  const result = await recoverCommand({ id: item.runId }, { paths: item.paths, env: {} });
  assert.equal(result.status, 'reviewing');
  assert.equal((await loadRun(item.paths, item.runId)).state.recovery.reason, 'no-worktree-change');
});

test('SIGTERM during a Pi turn persists a recoverable state and releases the lock', async () => {
  const home = await makeTempDir('pi-signal-');
  const repositoryRoot = await initGitRepo(path.join(home, 'source'));
  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  const pi = path.join(home, 'bin', 'pi');
  await writeExecutable(pi, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('0.80.10'); process.exit(0); }
if (process.argv.includes('--list-models')) { console.log('volcengine-plan/ark-code-latest'); process.exit(0); }
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const runId = 'signal-recovery-test';
  const taskFile = path.join(home, 'task.json');
  await writeFile(taskFile, JSON.stringify({
    schemaVersion: 1, runId, repositoryRoot, baseRevision: head,
    goal: 'Create a module', allowedPaths: ['src/**'], forbiddenPaths: ['.git/**'],
    constraints: [], acceptanceCriteria: ['module exists'],
    verification: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutSeconds: 10, env: {} }],
    requiredCapabilities: ['text', 'code', 'tool-use'], risk: 'medium',
  }));
  const env = {
    ...process.env, HOME: home, PI_WORKER_CONFIG: paths.configFile, PI_WORKER_MODELS_FILE: paths.modelsFile,
    PI_WORKER_STATE_DIR: paths.stateRoot, PI_WORKER_CACHE_DIR: paths.cacheRoot, PI_WORKER_PI_BIN: pi,
    VOLCENGINE_API_KEY: 'test-key-not-real',
  };
  const prepared = await runNode(cli, ['prepare', '--task', taskFile], { env });
  assert.equal(prepared.code, 0, prepared.stderr);
  const child = spawn(process.execPath, [cli, 'run', '--id', runId], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const stateFile = path.join(paths.stateRoot, 'runs', runId, 'state.json');
  for (let i = 0; i < 100; i += 1) {
    try {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      if (state.status === 'running') break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill('SIGTERM');
  const exitCode = await new Promise((resolve) => child.once('close', (code) => resolve(code)));
  assert.notEqual(exitCode, 0, `${stdout}\n${stderr}`);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.status, 'failed');
  assert.equal(state.failure.code, 'PI_INTERRUPTED');
  await assert.rejects(access(path.join(paths.stateRoot, 'runs', runId, '.lock')), { code: 'ENOENT' });
  const recovered = await runNode(cli, ['recover', '--id', runId], { env });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).status, 'prepared');
});
