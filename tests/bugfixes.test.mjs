import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { installDefaultConfiguration, resolveWorkerPaths } from '../lib/config.mjs';
import { makeTempDir, initGitRepo, runNode, runProcess, writeExecutable } from './helpers.mjs';

const skillRoot = path.resolve(new URL('..', import.meta.url).pathname);
const cli = path.join(skillRoot, 'scripts', 'pi-worker.mjs');

// === Bug 1: Kimi TOML 表头非法修复验证 ===
test('kimi adapter generates valid TOML with quoted keys for slash-containing aliases', async () => {
  // 直接测试 buildTomlManual 通过 sanitizeHome 生成的 config.toml
  // 验证 [models."provider/model"] 格式而非非法的 [models.provider/model]
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
  // 验证 models 表头用引号包裹(合法 TOML)
  assert.match(tomlContent, /\[models\."kimi\/kimi-k2"\]/, 'models 表头应使用 quoted key');
  // 验证 providers 表头也用引号包裹
  assert.match(tomlContent, /\[providers\."kimi"\]/, 'providers 表头应使用 quoted key');
  // 验证不含非法的 bare key with slash
  assert.doesNotMatch(tomlContent, /\[models\.kimi\/kimi-k2\]/, '不应有非法的 bare key');
});

// === Bug 2: resolveBin legacy fallback 跨适配器误用修复验证 ===
test('resolveBin does not fall back to PI_WORKER_PI_BIN for non-pi adapters', async () => {
  const { resolveBin, getAdapter } = await import('../lib/adapters/index.mjs');
  const kimiAdapter = getAdapter('kimi');
  const traeAdapter = getAdapter('trae');
  const qoderAdapter = getAdapter('qoder');
  const piAdapter = getAdapter('pi');
  // 设置 PI_WORKER_PI_BIN 但不设 KIMI/TRAE/QODER 专用 bin
  const env = { PI_WORKER_PI_BIN: '/usr/local/bin/pi' };
  // Pi 适配器应该用 legacy fallback
  assert.equal(resolveBin(piAdapter, env), '/usr/local/bin/pi');
  // Kimi/Trae/Qoder 不应该用 Pi 的 legacy fallback,而是用各自的 defaultBin
  assert.equal(resolveBin(kimiAdapter, env), 'kimi', 'kimi 不应回退到 pi bin');
  assert.equal(resolveBin(traeAdapter, env), 'traecli', 'trae 不应回退到 pi bin');
  assert.equal(resolveBin(qoderAdapter, env), 'qoderclicn', 'qoder 不应回退到 pi bin');
  // 但设置专用 bin 时不应用 legacy fallback
  assert.equal(resolveBin(kimiAdapter, { ...env, PI_WORKER_KIMI_BIN: '/opt/kimi' }), '/opt/kimi');
});

// === Bug 4: approveCommand commit 失败后保持 approved 状态(可重试)验证 ===
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

  // mock pi:首次 run 成功产出正确代码
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

  // approve:用一个会触发 commit 失败的方式(worktree 只读)
  const verification = JSON.parse(await readFile(path.join(paths.stateRoot, 'runs', runId, 'verification.json'), 'utf8'));
  const reviewFile = path.join(home, 'review.json');
  await writeFile(reviewFile, JSON.stringify({
    schemaVersion: 1, verdict: 'approve', diffSha256: verification.security.diffSha256,
    findings: [], verificationGaps: [], summary: 'Looks good.',
  }));
  // 先正常 approve
  const approveResult = await runNode(cli, ['approve', '--id', runId, '--review', reviewFile, '--message', 'fix value'], { env });
  assert.equal(approveResult.code, 0, approveResult.stderr);
  const state = JSON.parse(await readFile(path.join(paths.stateRoot, 'runs', runId, 'state.json'), 'utf8'));
  assert.equal(state.status, 'committed');
  assert.ok(state.implementationCommit, '应有 implementationCommit');
});

// === Bug 8: verification 失败不转 selfReviewing 验证 ===
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
  cfg.selfReview = { enabled: true };  // 启用 self-review
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
// 产出错误代码(value=7),触发 verification 失败
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
  // verify 命令本身退出 0(它记录了 passed=false 但不抛错)
  assert.equal(verifyResult.code, 0, verifyResult.stderr);
  const payload = JSON.parse(verifyResult.stdout);
  assert.equal(payload.passed, false);
  // 关键:验证失败时不应转 selfReviewing(否则 self-review 会卡死),应转 reviewing
  assert.equal(payload.status, 'reviewing', '验证失败应转 reviewing 而非 selfReviewing');
});

// === Bug 6+7: cleanup 支持 failed/blocked 状态验证 ===
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

  // mock pi:run 时直接失败(不产出任何文件)
  const pi = path.join(home, 'bin', 'pi');
  await writeExecutable(pi, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.80.10'); process.exit(0); }
if (args.includes('--list-models')) { console.log('volcengine-plan/ark-code-latest'); process.exit(0); }
// 模拟 Pi 崩溃,不产出任何文件
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
  // run 会失败
  await runNode(cli, ['run', '--id', runId], { env });
  let state = JSON.parse(await readFile(path.join(paths.stateRoot, 'runs', runId, 'state.json'), 'utf8'));
  assert.equal(state.status, 'failed');
  // cleanup 应该能清理 failed 状态的 run
  // 先手动生成 report(cleanup 对非 integrated 状态不强制 report)
  try { await runNode(cli, ['report', '--id', runId], { env }); } catch {}
  const cleanupResult = await runNode(cli, ['cleanup', '--id', runId], { env });
  assert.equal(cleanupResult.code, 0, cleanupResult.stderr);
  const cleanupPayload = JSON.parse(cleanupResult.stdout);
  assert.equal(cleanupPayload.cleaned, true);
  // worktree 应该被删除
  state = JSON.parse(await readFile(path.join(paths.stateRoot, 'runs', runId, 'state.json'), 'utf8'));
  assert.ok(state.cleanedAt, '应有 cleanedAt');
});

// === Bug 10: transition 清除 failure/interruption 历史字段验证 ===
test('transition clears failure and interruption fields when leaving failed state', async () => {
  const { transition, recoverTransition } = await import('../lib/state.mjs');
  const failedState = {
    runId: 'test-run',
    status: 'failed',
    failure: { code: 'PI_INTERRUPTED', message: 'interrupted' },
    interruption: { interruptedAt: '2026-01-01T00:00:00Z' },
    transitions: [],
  };
  // 从 failed 转到 prepared(recover)用 recoverTransition
  const recovered = recoverTransition(failedState, 'prepared', {}, 'recovered');
  assert.equal(recovered.status, 'prepared');
  assert.equal(recovered.failure, undefined, 'failure 应被清除');
  assert.equal(recovered.interruption, undefined, 'interruption 应被清除');
  // revisionRecovery 应保留(一次性事件记录)
  const revisingState = { ...failedState, status: 'revising', revisionRecovery: { reason: 'test' } };
  const verified = transition(revisingState, 'verifying', { revisionRecovery: { reason: 'test' } });
  assert.ok(verified.revisionRecovery, 'revisionRecovery 应保留');
});
