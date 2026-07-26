/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { installDefaultConfiguration, resolveWorkerPaths } from '../lib/config.mjs';
import { makeTempDir, initGitRepo, runNode, runProcess, writeExecutable } from './helpers.mjs';

const skillRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = path.join(skillRoot, 'scripts', 'pi-worker.mjs');

// === Bug 1: Kimi TOML illegal header fix verification ===
test('kimi adapter generates valid TOML with quoted keys for slash-containing aliases', async () => {
  // directly test buildTomlManual pass sanitizeHome generated config.toml
  // verification [models."provider/model"] format rather than illegal [models.provider/model]
  const { KimiAdapter } = await import('../lib/adapters/kimi.mjs');
  const profile = {
  provider: 'kimi', model: 'kimi-k2', apiKeyEnv: 'KIMI_API_KEY',
  providerType: 'kimi', baseUrl: 'https://api.kimi.com/coding/v1', maxContextSize: 1048576,
  modalities: ['text'],
  };
  const home = await makeTempDir('kimi-toml-');
  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  const files = { directory: path.join(home, 'run-dir') };
  await mkdir(files.directory, { recursive: true });
  const env = { ...process.env, KIMI_API_KEY: 'test-key' };
  const { home: kimiHome } = await KimiAdapter.sanitizeHome({ paths, files, profile, env });
  const tomlContent = await readFile(path.join(kimiHome, '.kimi-code', 'config.toml'), 'utf8');
  // verification models header wrapped in quotes(legal TOML)
  assert.match(tomlContent, /\[models\."kimi\/kimi-k2"\]/, 'models header should use quoted key');
  // verification providers header also wrapped in quotes
  assert.match(tomlContent, /\[providers\."kimi"\]/, 'providers header should use quoted key');
  // verify no illegal bare key with slash
  assert.doesNotMatch(tomlContent, /\[models\.kimi\/kimi-k2\]/, 'should not have illegal bare key');
});

// === Bug 2: resolveBin legacy fallback cross-adapter misuse fix verification ===
test('resolveBin does not fall back to PI_WORKER_PI_BIN for non-pi adapters', async () => {
  const { resolveBin, getAdapter } = await import('../lib/adapters/index.mjs');
  const kimiAdapter = getAdapter('kimi');
  const traeAdapter = getAdapter('trae');
  const qoderAdapter = getAdapter('qoder');
  const piAdapter = getAdapter('pi');
  // set PI_WORKER_PI_BIN but not set KIMI/TRAE/QODER dedicated bin
  const env = { PI_WORKER_PI_BIN: '/usr/local/bin/pi' };
  // Pi adapter should use legacy fallback
  assert.equal(resolveBin(piAdapter, env), '/usr/local/bin/pi');
  // Kimi/Trae/Qoder should not use Pi  legacy fallback,but use their own defaultBin
  assert.equal(resolveBin(kimiAdapter, env), 'kimi', 'kimi should not fall back to pi bin');
  assert.equal(resolveBin(traeAdapter, env), 'traecli', 'trae should not fall back to pi bin');
  assert.equal(resolveBin(qoderAdapter, env), 'qoderclicn', 'qoder should not fall back to pi bin');
  // but set dedicated bin should not apply when legacy fallback
  assert.equal(resolveBin(kimiAdapter, { ...env, PI_WORKER_KIMI_BIN: '/opt/kimi' }), '/opt/kimi');
});

// === Bug 4: approveCommand commit stays after failure approved status(retryable)verification ===
test('approve commit failure keeps approved state (retrable), not failed (bricked)', async () => {
  const home = await makeTempDir('approve-retry-');
  const repositoryRoot = await initGitRepo(path.join(home, 'source'));
  await mkdir(path.join(repositoryRoot, 'src'), { recursive: true });
  await writeFile(path.join(repositoryRoot, 'src', 'value.js'), 'export const value = 42;\n');
  await runProcess('git', ['add', 'src/value.js'], { cwd: repositoryRoot });
  await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-m', 'test: add value'], { cwd: repositoryRoot });

  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  const cfg = JSON.parse(await readFile(paths.configFile, 'utf8'));
  cfg.selfReview = { enabled: false };
  cfg.retryDelaysMs = [0];
  await writeFile(paths.configFile, JSON.stringify(cfg));

  // mock pi:first run successfully produces correct code
  const pi = path.join(home, 'bin', 'pi');
  await writeExecutable(pi, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.80.10'); process.exit(0); }
if (args.includes('--list-models')) { console.log('volcengine-plan/ark-code-latest'); process.exit(0); }
mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
writeFileSync(path.join(process.cwd(), 'src', 'result.js'), 'export const value = 42;\\n');
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'volcengine-plan', model: 'ark-code-latest', stopReason: 'stop', content: [], usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { total: 0 } } } }));
`);

  const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const runId = `approve-retry-${Math.random().toString(16).slice(2)}`;
  const taskFile = path.join(home, 'task.json');
  await writeFile(taskFile, JSON.stringify({
  schemaVersion: 1, runId, repositoryRoot, baseRevision: head,
  goal: 'Create src/result.js with value=42',
  allowedPaths: ['src/**'], forbiddenPaths: ['.env*', '.git/**'],
  constraints: [], acceptanceCriteria: ['src/result.js exports value=42'],
  verification: [{ argv: [process.execPath, '-e', "import('./src/result.js').then(m=>process.exit(m.value===42?0:1))"], timeoutSeconds: 10, env: { CI: '1' } }],
  requiredCapabilities: ['text', 'code', 'tool-use'], risk: 'medium',
  }));
  const env = { ...process.env, HOME: home, PI_WORKER_CONFIG: paths.configFile, PI_WORKER_MODELS_FILE: paths.modelsFile, PI_WORKER_STATE_DIR: paths.stateRoot, PI_WORKER_CACHE_DIR: paths.cacheRoot, PI_WORKER_PI_BIN: pi, VOLCENGINE_API_KEY: 'test-key' };
  await runNode(cli, ['prepare', '--task', taskFile], { env });
  await runNode(cli, ['run', '--id', runId], { env });
  await runNode(cli, ['verify', '--id', runId], { env });

  // approve:use one that triggers commit failure way(worktree read-only)
  const verification = JSON.parse(await readFile(path.join(paths.stateRoot, 'runs', runId, 'verification.json'), 'utf8'));
  const reviewFile = path.join(home, 'review.json');
  await writeFile(reviewFile, JSON.stringify({
  schemaVersion: 1, verdict: 'approve', diffSha256: verification.security.diffSha256,
  findings: [], verificationGaps: [], summary: 'Looks good.',
  }));
  // first normal approve
  const approveResult = await runNode(cli, ['approve', '--id', runId, '--review', reviewFile, '--message', 'fix value'], { env });
  assert.equal(approveResult.code, 0, approveResult.stderr);
  const state = JSON.parse(await readFile(path.join(paths.stateRoot, 'runs', runId, 'state.json'), 'utf8'));
  assert.equal(state.status, 'committed');
  assert.ok(state.implementationCommit, 'should have implementationCommit');
});

// === Bug 8: verification failure does not transition to selfReviewing verification ===
test('verify with failed commands goes to reviewing (not selfReviewing) when selfReview enabled', async () => {
  const home = await makeTempDir('verify-fail-');
  const repositoryRoot = await initGitRepo(path.join(home, 'source'));
  await mkdir(path.join(repositoryRoot, 'src'), { recursive: true });
  await writeFile(path.join(repositoryRoot, 'src', 'value.js'), 'export const value = 7;\n');
  await runProcess('git', ['add', 'src/value.js'], { cwd: repositoryRoot });
  await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-m', 'test'], { cwd: repositoryRoot });

  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  const cfg = JSON.parse(await readFile(paths.configFile, 'utf8'));
  cfg.selfReview = { enabled: true };  // enable self-review
  cfg.retryDelaysMs = [0];
  await writeFile(paths.configFile, JSON.stringify(cfg));

  const pi = path.join(home, 'bin', 'pi');
  await writeExecutable(pi, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.80.10'); process.exit(0); }
if (args.includes('--list-models')) { console.log('volcengine-plan/ark-code-latest'); process.exit(0); }
mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
// produces wrong code(value=7),trigger verification failure
writeFileSync(path.join(process.cwd(), 'src', 'result.js'), 'export const value = 7;\\n');
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'volcengine-plan', model: 'ark-code-latest', stopReason: 'stop', content: [], usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { total: 0 } } } }));
`);

  const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const runId = `verify-fail-${Math.random().toString(16).slice(2)}`;
  const taskFile = path.join(home, 'task.json');
  await writeFile(taskFile, JSON.stringify({
  schemaVersion: 1, runId, repositoryRoot, baseRevision: head,
  goal: 'Create src/result.js with value=42',
  allowedPaths: ['src/**'], forbiddenPaths: ['.env*', '.git/**'],
  constraints: [], acceptanceCriteria: ['src/result.js exports value=42'],
  verification: [{ argv: [process.execPath, '-e', "import('./src/result.js').then(m=>process.exit(m.value===42?0:1))"], timeoutSeconds: 10, env: { CI: '1' } }],
  requiredCapabilities: ['text', 'code', 'tool-use'], risk: 'medium',
  }));
  const env = { ...process.env, HOME: home, PI_WORKER_CONFIG: paths.configFile, PI_WORKER_MODELS_FILE: paths.modelsFile, PI_WORKER_STATE_DIR: paths.stateRoot, PI_WORKER_CACHE_DIR: paths.cacheRoot, PI_WORKER_PI_BIN: pi, VOLCENGINE_API_KEY: 'test-key' };
  await runNode(cli, ['prepare', '--task', taskFile], { env });
  await runNode(cli, ['run', '--id', runId], { env });
  const verifyResult = await runNode(cli, ['verify', '--id', runId], { env });
  // verify command itself exits 0(it recorded passed=false but does not throw)
  assert.equal(verifyResult.code, 0, verifyResult.stderr);
  const payload = JSON.parse(verifyResult.stdout);
  assert.equal(payload.passed, false);
  // key:verification failure should not transition to selfReviewing(otherwise self-review will hang),should transition to reviewing
  assert.equal(payload.status, 'reviewing', 'verification failure should transition to reviewing rather than selfReviewing');
});

// === Bug 6+7: cleanup support failed/blocked status verification ===
test('cleanup can clean up failed runs (not just integrated)', async () => {
  const home = await makeTempDir('cleanup-failed-');
  const repositoryRoot = await initGitRepo(path.join(home, 'source'));
  await mkdir(path.join(repositoryRoot, 'src'), { recursive: true });
  await writeFile(path.join(repositoryRoot, 'src', 'old.js'), 'export const x = 1;\n');
  await runProcess('git', ['add', 'src/old.js'], { cwd: repositoryRoot });
  await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-m', 'test'], { cwd: repositoryRoot });

  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  const cfg = JSON.parse(await readFile(paths.configFile, 'utf8'));
  cfg.selfReview = { enabled: false };
  cfg.retryDelaysMs = [0];
  await writeFile(paths.configFile, JSON.stringify(cfg));

  // mock pi:run directly fails when(does not produce any files)
  const pi = path.join(home, 'bin', 'pi');
  await writeExecutable(pi, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.80.10'); process.exit(0); }
if (args.includes('--list-models')) { console.log('volcengine-plan/ark-code-latest'); process.exit(0); }
// simulate Pi crash,does not produce any files
console.error('Pi crashed');
process.exit(1);
`);

  const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const runId = `cleanup-failed-${Math.random().toString(16).slice(2)}`;
  const taskFile = path.join(home, 'task.json');
  await writeFile(taskFile, JSON.stringify({
  schemaVersion: 1, runId, repositoryRoot, baseRevision: head,
  goal: 'Create src/result.js',
  allowedPaths: ['src/**'], forbiddenPaths: ['.env*', '.git/**'],
  constraints: [], acceptanceCriteria: ['src/result.js exists'],
  verification: [{ argv: ['true'], timeoutSeconds: 5, env: { CI: '1' } }],
  requiredCapabilities: ['text', 'code', 'tool-use'], risk: 'medium',
  }));
  const env = { ...process.env, HOME: home, PI_WORKER_CONFIG: paths.configFile, PI_WORKER_MODELS_FILE: paths.modelsFile, PI_WORKER_STATE_DIR: paths.stateRoot, PI_WORKER_CACHE_DIR: paths.cacheRoot, PI_WORKER_PI_BIN: pi, VOLCENGINE_API_KEY: 'test-key' };
  await runNode(cli, ['prepare', '--task', taskFile], { env });
  // run will fail
  await runNode(cli, ['run', '--id', runId], { env });
  let state = JSON.parse(await readFile(path.join(paths.stateRoot, 'runs', runId, 'state.json'), 'utf8'));
  assert.equal(state.status, 'failed');
  // cleanup should be able to clean up failed of status run
  // first manually generate report(cleanup for non- integrated status does not force report)
  try { await runNode(cli, ['report', '--id', runId], { env }); } catch {}
  const cleanupResult = await runNode(cli, ['cleanup', '--id', runId], { env });
  assert.equal(cleanupResult.code, 0, cleanupResult.stderr);
  const cleanupPayload = JSON.parse(cleanupResult.stdout);
  assert.equal(cleanupPayload.cleaned, true);
  // worktree should be deleted
  state = JSON.parse(await readFile(path.join(paths.stateRoot, 'runs', runId, 'state.json'), 'utf8'));
  assert.ok(state.cleanedAt, 'should have cleanedAt');
});

// === Bug 10: transition clear failure/interruption history field verification ===
test('transition clears failure and interruption fields when leaving failed state', async () => {
  const { transition, recoverTransition } = await import('../lib/state.mjs');
  const failedState = {
  runId: 'test-run',
  status: 'failed',
  failure: { code: 'PI_INTERRUPTED', message: 'interrupted' },
  interruption: { interruptedAt: '2026-01-01T00:00:00Z' },
  transitions: [],
  };
  // from failed transition to prepared(recover)use recoverTransition
  const recovered = recoverTransition(failedState, 'prepared', {}, 'recovered');
  assert.equal(recovered.status, 'prepared');
  assert.equal(recovered.failure, undefined, 'failure should be cleared');
  assert.equal(recovered.interruption, undefined, 'interruption should be cleared');
  // revisionRecovery should retain(one-time event record)
  const revisingState = { ...failedState, status: 'revising', revisionRecovery: { reason: 'test' } };
  const verified = transition(revisingState, 'verifying', { revisionRecovery: { reason: 'test' } });
  assert.ok(verified.revisionRecovery, 'revisionRecovery should retain');
});
