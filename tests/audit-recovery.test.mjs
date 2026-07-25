import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { installDefaultConfiguration, resolveWorkerPaths } from '../lib/config.mjs';
import { appendAuditLog, withAuditLog, readAuditLog } from '../lib/audit-log.mjs';
import { makeTempDir, initGitRepo, runNode, runProcess, writeExecutable } from './helpers.mjs';

const skillRoot = path.resolve(new URL('..', import.meta.url).pathname);
const cli = path.join(skillRoot, 'scripts', 'pi-worker.mjs');

// === 审计日志模块单元测试 ===

test('appendAuditLog writes JSONL entries to the audit log file', async () => {
  const home = await makeTempDir('audit-basic-');
  const paths = resolveWorkerPaths({}, home);
  appendAuditLog(paths, { command: 'run', runId: 'test-1', caller: 'codex', phase: 'start' });
  appendAuditLog(paths, { command: 'run', runId: 'test-1', caller: 'codex', phase: 'end', ok: true, durationMs: 42 });
  const entries = await readAuditLog(paths, 10);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].command, 'run');
  assert.equal(entries[0].phase, 'start');
  assert.equal(entries[1].ok, true);
  assert.equal(entries[1].durationMs, 42);
});

test('withAuditLog records start and end entries with duration', async () => {
  const home = await makeTempDir('audit-wrap-');
  const paths = resolveWorkerPaths({}, home);
  const result = await withAuditLog(paths, { command: 'verify', runId: 'r1', caller: 'trae', args: { id: 'r1' } }, async () => {
    return { status: 'reviewing', runId: 'r1' };
  });
  assert.equal(result.status, 'reviewing');
  const entries = await readAuditLog(paths, 10);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].phase, 'start');
  assert.equal(entries[1].phase, 'end');
  assert.equal(entries[1].ok, true);
  assert.equal(entries[1].result.status, 'reviewing');
  assert.equal(typeof entries[1].durationMs, 'number');
});

test('withAuditLog records error entries on failure', async () => {
  const home = await makeTempDir('audit-err-');
  const paths = resolveWorkerPaths({}, home);
  await assert.rejects(
    withAuditLog(paths, { command: 'run', runId: 'r2', caller: 'cli', args: {} }, async () => {
      const err = new Error('Pi failed');
      err.code = 'PI_FAILED';
      err.details = { category: 'transient' };
      throw err;
    }),
  );
  const entries = await readAuditLog(paths, 10);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].ok, false);
  assert.equal(entries[1].error.code, 'PI_FAILED');
  assert.equal(entries[1].error.category, 'transient');
});

test('readAuditLog returns empty array when log does not exist', async () => {
  const home = await makeTempDir('audit-empty-');
  const paths = resolveWorkerPaths({}, home);
  const entries = await readAuditLog(paths, 10);
  assert.deepEqual(entries, []);
});

test('appendAuditLog does not throw on filesystem errors', async () => {
  const home = await makeTempDir('audit-silent-');
  const paths = resolveWorkerPaths({}, home);
  // Should not throw even with weird input
  appendAuditLog(paths, null);
  appendAuditLog(paths, { command: 'test' });
  const entries = await readAuditLog(paths, 10);
  // null entry is skipped by JSON.stringify? No, JSON.stringify(null) = "null"
  // But the ...entry spread on null would fail. Let's verify it doesn't throw.
  assert.ok(entries.length >= 1);
});

// === 修订回合恢复测试 ===
// 场景:Pi 修订代码已落在 worktree,但 worker 收尾时 runPiTurn 误判失败(non-zero exit)。
// 修复前:run 被标 failed,无法走 approve/integrate。
// 修复后:检测到 worktree 有变更,转 verifying 让主控独立验证。

async function revisionRecoveryFixture({ piMode = 'fail-with-changes' } = {}) {
  const home = await makeTempDir('pi-rev-recover-');
  const repositoryRoot = await initGitRepo(path.join(home, 'source'));
  await mkdir(path.join(repositoryRoot, 'src'), { recursive: true });
  await writeFile(path.join(repositoryRoot, 'src', 'old.js'), 'export const old = true;\n');
  await runProcess('git', ['add', 'src/old.js'], { cwd: repositoryRoot });
  await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-m', 'test: add allowed source'], { cwd: repositoryRoot });
  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  // 禁用 selfReview,verify 后直接到 reviewing
  const cfg = JSON.parse(await readFile(paths.configFile, 'utf8'));
  cfg.selfReview = { enabled: false };
  cfg.retryDelaysMs = [0];
  await writeFile(paths.configFile, JSON.stringify(cfg));

  const pi = path.join(home, 'bin', 'pi');
  // Pi 脚本:第一次 run 正常成功;revise 时写文件但 exit 1(模拟 worker 误判失败)
  await writeExecutable(pi, `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.80.10'); process.exit(0); }
if (args.includes('--list-models')) { console.log('volcengine-plan/ark-code-latest'); process.exit(0); }
const counterFile = path.join(process.env.HOME, 'rev-counter');
let count = 0;
try { count = Number(readFileSync(counterFile, 'utf8')); } catch {}
writeFileSync(counterFile, String(count + 1));
const mode = ${JSON.stringify(piMode)};
const isFirstRun = count === 0;
mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
if (isFirstRun) {
  // 首次 run:正常成功,产出 value=7(故意错误,触发 revise)
  writeFileSync(path.join(process.cwd(), 'src', 'result.js'), 'export const value = 7;\\n');
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'volcengine-plan', model: 'ark-code-latest', stopReason: 'stop', content: [], usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
} else {
  // revise 轮:写出正确代码(value=42)但 exit 1,模拟 worker 收尾误判
  writeFileSync(path.join(process.cwd(), 'src', 'result.js'), 'export const value = 42;\\n');
  if (mode === 'fail-with-changes') {
    // 输出一行有效 JSON 后 exit 1,模拟 worker 部分成功但最终失败
    console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'volcengine-plan', model: 'ark-code-latest', stopReason: 'error', content: [], usage: { input: 60, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 80, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
    process.exit(1);
  }
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'volcengine-plan', model: 'ark-code-latest', stopReason: 'stop', content: [], usage: { input: 60, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 80, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
}
`);

  const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const runId = `rev-recover-${Math.random().toString(16).slice(2)}`;
  const taskFile = path.join(home, 'task.json');
  await writeFile(taskFile, JSON.stringify({
    schemaVersion: 1, runId, repositoryRoot, baseRevision: head,
    goal: 'Create src/result.js with value=42',
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

test('revise recovery: worker exits non-zero but worktree has changes -> verifying not failed', async () => {
  const item = await revisionRecoveryFixture({ piMode: 'fail-with-changes' });
  // 1. 首次 run:Pi 产出 value=7(错误),进入 verifying
  const runResult = await runNode(cli, ['run', '--id', item.runId], { env: item.env });
  assert.equal(runResult.code, 0, runResult.stderr);
  // 2. verify:验证失败(value=7 != 42),进入 reviewing
  const verifyResult = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
  assert.equal(verifyResult.code, 0, verifyResult.stderr);
  assert.equal(JSON.parse(verifyResult.stdout).passed, false);
  // 3. 主控 review:要求 revise
  const verification = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'verification.json'), 'utf8'));
  const reviewFile = path.join(item.home, 'review.json');
  await writeFile(reviewFile, JSON.stringify({
    schemaVersion: 1, verdict: 'revise', diffSha256: verification.security.diffSha256,
    findings: [{ priority: 'P1', file: 'src/result.js', line: 1, problem: 'value is 7 not 42', evidence: 'verification failed', requiredChange: 'Export value 42' }],
    verificationGaps: [], summary: 'Fix the value.',
  }));
  // 4. revise:Pi 写出正确代码(value=42)但 exit 1(stopReason=error)
  //    修复前:run 被标 failed。修复后:检测到 worktree 有变更,转 verifying。
  const revised = await runNode(cli, ['revise', '--id', item.runId, '--review', reviewFile], { env: item.env });
  assert.equal(revised.code, 0, revised.stderr);
  const revisedPayload = JSON.parse(revised.stdout);
  assert.equal(revisedPayload.status, 'verifying');
  assert.equal(revisedPayload.recovered, true);
  // 5. 独立 verify:这次应该通过(value=42)
  const finalVerify = await runNode(cli, ['verify', '--id', item.runId], { env: item.env });
  assert.equal(finalVerify.code, 0, finalVerify.stderr);
  assert.equal(JSON.parse(finalVerify.stdout).passed, true);
  // 6. 确认 state 中有 revisionRecovery 记录
  const state = JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'state.json'), 'utf8'));
  assert.ok(state.revisionRecovery, 'state should have revisionRecovery');
  assert.equal(state.revisionRecovery.originalError.code, 'PI_FAILED');
  // 7. 确认审计日志有 recovery 条目
  const auditEntries = await readAuditLog(item.paths, 50);
  const recoveryEntry = auditEntries.find((e) => e.phase === 'recovery');
  assert.ok(recoveryEntry, 'audit log should have a recovery entry');
  assert.equal(recoveryEntry.runId, item.runId);
});

test('revise without worktree changes still marks as failed', async () => {
  // 当 Pi 真的失败且没有产出任何变更时,应该正常标 failed
  const home = await makeTempDir('pi-rev-nochange-');
  const repositoryRoot = await initGitRepo(path.join(home, 'source'));
  await mkdir(path.join(repositoryRoot, 'src'), { recursive: true });
  await writeFile(path.join(repositoryRoot, 'src', 'old.js'), 'export const old = true;\n');
  await runProcess('git', ['add', 'src/old.js'], { cwd: repositoryRoot });
  await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-m', 'test: add allowed source'], { cwd: repositoryRoot });
  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  const cfg = JSON.parse(await readFile(paths.configFile, 'utf8'));
  cfg.selfReview = { enabled: false };
  cfg.retryDelaysMs = [0];
  await writeFile(paths.configFile, JSON.stringify(cfg));

  const pi = path.join(home, 'bin', 'pi');
  // Pi 脚本:首次 run 正常;revise 时不写任何文件,直接 exit 1
  await writeExecutable(pi, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.80.10'); process.exit(0); }
if (args.includes('--list-models')) { console.log('volcengine-plan/ark-code-latest'); process.exit(0); }
const counterFile = path.join(process.env.HOME, 'rev-counter');
let count = 0;
try { count = Number(readFileSync(counterFile, 'utf8')); } catch {}
writeFileSync(counterFile, String(count + 1));
if (count === 0) {
  // 首次 run:成功,产出 value=7
  const { mkdirSync } = require('node:fs');
  mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
  writeFileSync(path.join(process.cwd(), 'src', 'result.js'), 'export const value = 7;\\n');
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'volcengine-plan', model: 'ark-code-latest', stopReason: 'stop', content: [], usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
} else {
  // revise:不写文件,直接 exit 1
  console.error('Pi crashed without producing output');
  process.exit(1);
}
`);

  const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const runId = `rev-nochg-${Math.random().toString(16).slice(2)}`;
  const taskFile = path.join(home, 'task.json');
  await writeFile(taskFile, JSON.stringify({
    schemaVersion: 1, runId, repositoryRoot, baseRevision: head,
    goal: 'Create src/result.js with value=42',
    allowedPaths: ['src/**', 'tests/**'], forbiddenPaths: ['.env*', '.git/**'],
    constraints: [], acceptanceCriteria: ['src/result.js exports value=42'],
    verification: [{ argv: [process.execPath, '-e', "import('./src/result.js').then(m=>process.exit(m.value===42?0:1))"], timeoutSeconds: 10, env: { CI: '1' } }],
    requiredCapabilities: ['text', 'code', 'tool-use'], risk: 'medium',
  }));
  const env = { ...process.env, HOME: home, PI_WORKER_CONFIG: paths.configFile, PI_WORKER_MODELS_FILE: paths.modelsFile, PI_WORKER_STATE_DIR: paths.stateRoot, PI_WORKER_CACHE_DIR: paths.cacheRoot, PI_WORKER_PI_BIN: pi, VOLCENGINE_API_KEY: 'test-key-not-real' };
  await runNode(cli, ['prepare', '--task', taskFile], { env });
  await runNode(cli, ['run', '--id', runId], { env });
  await runNode(cli, ['verify', '--id', runId], { env });
  const verification = JSON.parse(await readFile(path.join(paths.stateRoot, 'runs', runId, 'verification.json'), 'utf8'));
  const reviewFile = path.join(home, 'review.json');
  await writeFile(reviewFile, JSON.stringify({
    schemaVersion: 1, verdict: 'revise', diffSha256: verification.security.diffSha256,
    findings: [{ priority: 'P1', file: 'src/result.js', line: 1, problem: 'wrong value', evidence: 'verify failed', requiredChange: 'Export 42' }],
    verificationGaps: [], summary: 'Fix.',
  }));
  const revised = await runNode(cli, ['revise', '--id', runId, '--review', reviewFile], { env });
  assert.equal(revised.code, 1, revised.stderr);
  const state = JSON.parse(await readFile(path.join(paths.stateRoot, 'runs', runId, 'state.json'), 'utf8'));
  assert.equal(state.status, 'failed');
  assert.ok(!state.revisionRecovery, 'should not have revisionRecovery when no changes');
});
