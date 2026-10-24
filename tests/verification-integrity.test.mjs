/*
 * spotworkers - Delegate bounded coding tasks to cheap agent workers
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installDefaultConfiguration, resolveWorkerPaths } from '../lib/config.mjs';
import { transition, updateRun } from '../lib/state.mjs';
import { makeTempDir, initGitRepo, runNode, runProcess, writeExecutable } from './helpers.mjs';

const skillRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = path.join(skillRoot, 'scripts', 'spot.mjs');

// Minimal repo with a real `package.json` and an acceptance test, so the
// verification-integrity guard has something to protect.
async function fixture({ lockedPaths = [], seedPackageJson = {} } = {}) {
  const home = await makeTempDir('pi-integrity-');
  const repositoryRoot = await initGitRepo(path.join(home, 'source'));
  await mkdir(path.join(repositoryRoot, 'src'), { recursive: true });
  await mkdir(path.join(repositoryRoot, 'tests'), { recursive: true });
  await writeFile(path.join(repositoryRoot, 'src', 'app.js'), 'export const answer = 1;\n');
  await writeFile(path.join(repositoryRoot, 'tests', 'acceptance.test.mjs'), "import assert from 'node:assert/strict';\nassert.equal(1, 1);\n");
  const pkg = { name: 'fixture', version: '1.0.0', private: true, scripts: { test: 'node tests/acceptance.test.mjs' }, ...seedPackageJson };
  await writeFile(path.join(repositoryRoot, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  await runProcess('git', ['add', '-A'], { cwd: repositoryRoot });
  await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-m', 'test: fixture'], { cwd: repositoryRoot });

  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  const cfg = JSON.parse(await readFile(paths.configFile, 'utf8'));
  cfg.selfReview = { enabled: false };
  await writeFile(paths.configFile, JSON.stringify(cfg));

  const pi = path.join(home, 'bin', 'pi');
  await writeExecutable(pi, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.80.10'); process.exit(0); }
if (args.includes('--list-models')) { console.log('volcengine-plan/ark-code-latest'); process.exit(0); }
mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
writeFileSync(path.join(process.cwd(), 'src', 'app.js'), 'export const answer = 2;\\n');
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'volcengine-plan', model: 'ark-code-latest', stopReason: 'stop', content: [], usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { total: 0 } } } }));
`);

  const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const runId = `integrity-${Math.random().toString(16).slice(2)}`;
  const taskFile = path.join(home, 'task.json');
  await writeFile(taskFile, JSON.stringify({
    schemaVersion: 1, runId, repositoryRoot, baseRevision: head,
    goal: 'Change src/app.js so the exported answer is 2',
    allowedPaths: ['src/**', 'tests/**', 'package.json'],
    forbiddenPaths: ['.env*', '.git/**'],
    lockedPaths,
    constraints: [],
    acceptanceCriteria: ['src/app.js exports answer=2'],
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
  const payload = JSON.parse(prepared.stdout);
  await updateRun(paths, runId, (state) => transition(transition(state, 'running'), 'verifying'));
  return { home, repositoryRoot, paths, env, runId, worktree: payload.worktreePath };
}

async function verify(item) {
  const result = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
  const evidence = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'verification.json'), 'utf8'));
  const state = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'state.json'), 'utf8'));
  return { result, evidence, state, issues: evidence.security?.issues ?? [] };
}

test('a worker edit to a contract lockedPath blocks verification', async () => {
  const item = await fixture({ lockedPaths: ['tests/**'] });
  // The worker "fixes" the acceptance test instead of the implementation.
  await writeFile(path.join(item.worktree, 'tests', 'acceptance.test.mjs'), "import assert from 'node:assert/strict';\nassert.equal(2, 2);\n");
  const { result, evidence, state, issues } = await verify(item);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'SECURITY_BLOCKED');
  assert.ok(issues.some((issue) => issue.code === 'LOCKED_PATH_CHANGED' && issue.path === 'tests/acceptance.test.mjs'), JSON.stringify(issues));
  assert.equal(evidence.passed, false);
  assert.equal(state.status, 'blocked');
});

test('rewriting the package.json test script blocks verification', async () => {
  const item = await fixture();
  const manifest = JSON.parse(await readFile(path.join(item.worktree, 'package.json'), 'utf8'));
  manifest.scripts.test = 'node -e "process.exit(0)"';
  await writeFile(path.join(item.worktree, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const { result, issues } = await verify(item);
  assert.equal(result.code, 1);
  assert.ok(issues.some((issue) => issue.code === 'VERIFICATION_SCRIPT_CHANGED' && issue.changedKeys.includes('scripts')), JSON.stringify(issues));
});

test('adding a dependency without touching scripts stays delegable', async () => {
  const item = await fixture();
  const manifest = JSON.parse(await readFile(path.join(item.worktree, 'package.json'), 'utf8'));
  manifest.dependencies = { 'left-pad': '^1.3.0' };
  await writeFile(path.join(item.worktree, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const { result, evidence } = await verify(item);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(evidence.passed, true, JSON.stringify(evidence.security?.issues));
});

test('editing a test-runner config is blocked by the default locked paths', async () => {
  const item = await fixture();
  // vitest.config.mjs is not in the base tree, so creating it is a new file the
  // default config still refuses (the lock is about behaviour, not history).
  await writeFile(path.join(item.worktree, 'vitest.config.mjs'), 'export default { test: { include: [] } };\n');
  const { result, issues } = await verify(item);
  assert.equal(result.code, 1);
  assert.ok(issues.some((issue) => issue.code === 'LOCKED_PATH_CHANGED' && issue.path === 'vitest.config.mjs'), JSON.stringify(issues));
});
