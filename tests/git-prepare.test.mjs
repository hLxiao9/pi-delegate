import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { installDefaultConfiguration, resolveWorkerPaths } from '../lib/config.mjs';
import { makeTempDir, initGitRepo, runNode, runProcess, writeExecutable } from './helpers.mjs';

const skillRoot = path.resolve(new URL('..', import.meta.url).pathname);
const cli = path.join(skillRoot, 'scripts', 'pi-worker.mjs');

async function setup({ dirty = false } = {}) {
  const home = await makeTempDir('pi-prepare-home-');
  const repositoryRoot = await initGitRepo(path.join(home, 'source'));
  if (dirty) {
    await writeFile(path.join(repositoryRoot, 'README.md'), '# user draft\n');
    await writeFile(path.join(repositoryRoot, 'notes.txt'), 'untracked user context\n');
  }
  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  const pi = path.join(home, 'bin', 'pi');
  await writeExecutable(pi, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('0.80.10');
else if (args.includes('--list-models')) console.log('volcengine-plan/ark-code-latest');
else process.exitCode = 2;
`);
  const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const runId = dirty ? 'dirty-prepare' : 'clean-prepare';
  const taskFile = path.join(home, `${runId}.json`);
  await writeFile(taskFile, JSON.stringify({
    schemaVersion: 1,
    runId,
    repositoryRoot,
    baseRevision: head,
    goal: 'Add a deterministic fixture implementation',
    allowedPaths: ['src/**', 'tests/**'],
    forbiddenPaths: ['.env*', '.git/**'],
    constraints: ['Do not alter README.md'],
    acceptanceCriteria: ['Fixture test passes'],
    verification: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutSeconds: 10, env: {} }],
    requiredCapabilities: ['text', 'code', 'tool-use'],
    risk: 'medium',
  }));
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
  return { home, repositoryRoot, paths, head, runId, taskFile, env };
}

test('prepare creates a clean isolated worktree from the exact task HEAD', async () => {
  const fixture = await setup();
  const result = await runNode(cli, ['prepare', '--task', fixture.taskFile], { env: fixture.env });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sourceDirty, false);
  assert.equal(payload.status, 'prepared');
  assert.equal((await runProcess('git', ['status', '--porcelain'], { cwd: fixture.repositoryRoot })).stdout, '');
  assert.equal((await runProcess('git', ['rev-parse', 'HEAD'], { cwd: payload.worktreePath })).stdout.trim(), fixture.head);
});

test('dirty prepare copies a snapshot but leaves source bytes and status unchanged', async () => {
  const fixture = await setup({ dirty: true });
  const beforeStatus = (await runProcess('git', ['status', '--porcelain=v1', '-z'], { cwd: fixture.repositoryRoot })).stdout;
  const result = await runNode(cli, ['prepare', '--task', fixture.taskFile], { env: fixture.env });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sourceDirty, true);
  assert.match(await readFile(path.join(payload.worktreePath, 'README.md'), 'utf8'), /user draft/);
  assert.equal(await readFile(path.join(payload.worktreePath, 'notes.txt'), 'utf8'), 'untracked user context\n');
  const afterStatus = (await runProcess('git', ['status', '--porcelain=v1', '-z'], { cwd: fixture.repositoryRoot })).stdout;
  assert.equal(afterStatus, beforeStatus);
  const workerLog = (await runProcess('git', ['log', '--format=%s', '-1'], { cwd: payload.worktreePath })).stdout;
  assert.match(workerLog, /snapshot source dirty-prepare/);
});

test('prepare rejects a stale base revision before creating a branch', async () => {
  const fixture = await setup();
  const task = JSON.parse(await readFile(fixture.taskFile, 'utf8'));
  task.baseRevision = 'b'.repeat(40);
  await writeFile(fixture.taskFile, JSON.stringify(task));
  const result = await runNode(cli, ['prepare', '--task', fixture.taskFile], { env: fixture.env });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'BASE_REVISION_MISMATCH');
  const branches = (await runProcess('git', ['branch', '--list', 'pi-worker/*'], { cwd: fixture.repositoryRoot })).stdout;
  assert.equal(branches.trim(), '');
});
