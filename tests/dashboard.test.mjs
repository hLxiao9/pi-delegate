import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { resolveWorkerPaths } from '../lib/config.mjs';
import { dashboardCommand, inspectCommand, listCommand, renderDashboardHtml, summarizeState } from '../lib/dashboard.mjs';
import { makeTempDir } from './helpers.mjs';

async function seedRun(paths, overrides = {}) {
  const runId = overrides.runId ?? `run-${Math.random().toString(16).slice(2)}`;
  const dir = path.join(paths.stateRoot, 'runs', runId);
  await mkdir(dir, { recursive: true });
  const now = overrides.createdAt ?? new Date().toISOString();
  const caller = overrides.caller;
  const state = {
    schemaVersion: 1,
    runId,
    status: overrides.status ?? 'integrated',
    createdAt: now,
    updatedAt: now,
    caller,
    provider: overrides.provider ?? 'volcengine-plan',
    model: overrides.model ?? 'ark-code-latest',
    profile: 'volcengine-plan',
    revisionRound: overrides.revisionRound ?? 0,
    fallbackUsed: Boolean(overrides.fallbackUsed ?? false),
    implementationCommit: overrides.implementationCommit ?? 'abc123def456789012345678901234567890abcd',
    integratedCommit: overrides.integratedCommit ?? null,
    sourceBranch: 'main',
    workerBranch: `pi-worker/${runId}`,
    transitions: overrides.transitions ?? [{ from: 'prepared', to: 'running', at: now, reason: null }],
  };
  await writeFile(path.join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  if (overrides.withTask !== false) {
    await writeFile(path.join(dir, 'task.json'), `${JSON.stringify({
      schemaVersion: 1, runId, repositoryRoot: '/tmp', baseRevision: '0'.repeat(40),
      goal: 'test goal for dashboard', allowedPaths: ['src/**'], forbiddenPaths: ['.env*'],
      constraints: [], acceptanceCriteria: ['it works'], verification: [{ argv: ['true'], timeoutSeconds: 5, env: {} }],
      requiredCapabilities: ['text', 'code'], risk: 'low',
    }, null, 2)}\n`);
  }
  if (overrides.withMetrics !== false) {
    const metrics = {
      schemaVersion: 1, runId, generatedAt: now, elapsedMs: 5000,
      quality: { finalVerificationPassed: true, securityPassed: true, unresolvedBlockingFindings: 0, revisionRounds: overrides.revisionRound ?? 0, fallbackUsed: false, committed: true, integrated: true },
      codex: { model: 'gpt-5.6-sol', rateCardEffectiveDate: '2026-01-01', rateCardSource: 'test', measurementStartSource: 'early-meter', usage: { available: true, inputTokens: 2000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0, totalTokens: 2200, startAt: now, endAt: now }, actualCredits: 0.2425, includedPlanUsageNotCash: true },
      pi: { provider: state.provider, model: state.model, usage: { inputTokens: 120, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0, totalTokens: 170, providerReportedCostUsd: 0, requests: 1, durationMs: 1500 } },
      visual: { route: 'chatgpt-web', generations: 0, delegatedToPi: false, excludedFromCodeSavings: true },
      counterfactual: { label: 'estimate-not-ab-test', estimatedDisplacedSolCredits: 0.29375, estimatedNoDelegationCredits: 0.53625, estimatedCreditSavingRate: 0.548 },
      cash: { codexPlusMonthlyUsd: 20, providerPlan: { currency: 'CNY', amount: 100 }, successfulTasksThisMonth: 1, providerCostPerSuccessfulTask: 100, cashSavingsAmount: 0, note: 'test' },
    };
    await writeFile(path.join(dir, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
  }
  return state;
}

test('list returns all runs sorted by createdAt descending', async () => {
  const home = await makeTempDir('dashboard-list-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'older-run', createdAt: '2026-07-01T00:00:00.000Z' });
  await seedRun(paths, { runId: 'newer-run', createdAt: '2026-07-25T00:00:00.000Z' });
  const result = await listCommand({}, { env: {}, paths });
  assert.equal(result.count, 2);
  assert.equal(result.runs[0].runId, 'newer-run');
  assert.equal(result.runs[1].runId, 'older-run');
});

test('list filters by caller', async () => {
  const home = await makeTempDir('dashboard-caller-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'trae-run', caller: 'trae' });
  await seedRun(paths, { runId: 'codex-run', caller: 'codex' });
  const traeOnly = await listCommand({ caller: 'trae' }, { env: {}, paths });
  assert.equal(traeOnly.count, 1);
  assert.equal(traeOnly.runs[0].runId, 'trae-run');
  assert.equal(traeOnly.runs[0].caller, 'trae');
});

test('list filters by status', async () => {
  const home = await makeTempDir('dashboard-status-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'ok-run', status: 'integrated' });
  await seedRun(paths, { runId: 'bad-run', status: 'failed' });
  const failedOnly = await listCommand({ status: 'failed' }, { env: {}, paths });
  assert.equal(failedOnly.count, 1);
  assert.equal(failedOnly.runs[0].runId, 'bad-run');
});

test('list returns unknown caller for legacy runs without caller field', async () => {
  const home = await makeTempDir('dashboard-legacy-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'legacy-run', caller: undefined });
  const result = await listCommand({}, { env: {}, paths });
  assert.equal(result.count, 1);
  assert.equal(result.runs[0].caller, 'unknown');
});

test('list summarizes state without exposing internal fields', async () => {
  const home = await makeTempDir('dashboard-summary-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'summary-run' });
  const result = await listCommand({}, { env: {}, paths });
  const summary = result.runs[0];
  assert.deepEqual(Object.keys(summary).sort(), ['caller', 'createdAt', 'fallbackUsed', 'implementationCommit', 'integratedCommit', 'model', 'profile', 'provider', 'revisionRound', 'runId', 'sourceBranch', 'status', 'updatedAt', 'workerBranch'].sort());
});

test('inspect returns state, metrics, and pi usage', async () => {
  const home = await makeTempDir('dashboard-inspect-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'inspect-run', caller: 'trae' });
  const result = await inspectCommand({ id: 'inspect-run' }, { env: {}, paths });
  assert.equal(result.state.runId, 'inspect-run');
  assert.equal(result.state.caller, 'trae');
  assert.equal(result.metrics.pi.usage.inputTokens, 120);
  assert.equal(result.piUsage.requests, 0);
  assert.equal(result.task.runId, 'inspect-run');
});

test('inspect requires --id', async () => {
  await assert.rejects(() => inspectCommand({}, { env: {} }), (error) => {
    assert.equal(error.code, 'CLI_USAGE');
    return true;
  });
});

test('inspect rejects unknown run id', async () => {
  const home = await makeTempDir('dashboard-missing-');
  const paths = resolveWorkerPaths({}, home);
  await assert.rejects(() => inspectCommand({ id: 'no-such-run' }, { env: {}, paths }), (error) => {
    assert.equal(error.code, 'RUN_NOT_FOUND');
    return true;
  });
});

test('dashboard generates HTML with run data, caller badges, and summary cards', async () => {
  const home = await makeTempDir('dashboard-html-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'dash-trae', caller: 'trae' });
  await seedRun(paths, { runId: 'dash-codex', caller: 'codex' });
  const outputFile = path.join(home, 'dashboard.html');
  const result = await dashboardCommand({ output: outputFile }, { env: {}, paths });
  assert.equal(result.runCount, 2);
  const html = await readFile(outputFile, 'utf8');
  assert.match(html, /Pi Worker 监控台/);
  assert.match(html, /dash-trae/);
  assert.match(html, /dash-codex/);
  assert.match(html, /trae/);
  assert.match(html, /codex/);
  assert.match(html, /<table/);
  assert.match(html, /总 Runs/);
  assert.match(html, /调用来源/);
  assert.match(html, /平均节省率/);
});

test('dashboard handles empty state with a helpful message', async () => {
  const home = await makeTempDir('dashboard-empty-');
  const paths = resolveWorkerPaths({}, home);
  const outputFile = path.join(home, 'empty.html');
  const result = await dashboardCommand({ output: outputFile }, { env: {}, paths });
  assert.equal(result.runCount, 0);
  const html = await readFile(outputFile, 'utf8');
  assert.match(html, /还没有任何 run/);
});

test('dashboard writes to default location under stateRoot when --output omitted', async () => {
  const home = await makeTempDir('dashboard-default-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'default-run' });
  const result = await dashboardCommand({}, { env: {}, paths });
  const html = await readFile(result.dashboardFile, 'utf8');
  assert.match(html, /default-run/);
  assert.equal(path.dirname(result.dashboardFile), paths.stateRoot);
});

test('renderDashboardHtml escapes HTML in runId to prevent XSS', () => {
  const malicious = {
    runId: '<script>alert(1)</script>',
    status: 'integrated',
    caller: 'trae',
    provider: 'p',
    model: 'm',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revisionRound: 0,
    fallbackUsed: false,
    implementationCommit: null,
    integratedCommit: null,
    sourceBranch: null,
    workerBranch: null,
    transitions: [],
  };
  const html = renderDashboardHtml([malicious], [null], new Date().toISOString());
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must not appear');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('summarizeState preserves caller value from state', () => {
  assert.equal(summarizeState({ runId: 'a', status: 'integrated', caller: 'trae' }).caller, 'trae');
  assert.equal(summarizeState({ runId: 'b', status: 'integrated', caller: 'custom-value' }).caller, 'custom-value');
  assert.equal(summarizeState({ runId: 'c', status: 'integrated' }).caller, 'unknown');
  assert.equal(summarizeState({ runId: 'd', status: 'integrated', caller: '' }).caller, 'unknown');
});

test('list --running filters to active states only', async () => {
  const home = await makeTempDir('dashboard-running-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'active-run', status: 'running' });
  await seedRun(paths, { runId: 'verifying-run', status: 'verifying' });
  await seedRun(paths, { runId: 'done-run', status: 'integrated' });
  await seedRun(paths, { runId: 'failed-run', status: 'failed' });
  const result = await listCommand({ running: true }, { env: {}, paths });
  assert.equal(result.count, 2);
  const ids = result.runs.map((r) => r.runId).sort();
  assert.deepEqual(ids, ['active-run', 'verifying-run']);
});

test('list tolerates concurrent state.json writes (JSON parse errors skipped)', async () => {
  const home = await makeTempDir('dashboard-concurrent-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'good-run' });
  // 模拟并发写入中间态:写入截断的 JSON
  const dir = path.join(paths.stateRoot, 'runs', 'mid-write-run');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'state.json'), '{"runId":"mid-write-r'); // 截断
  const result = await listCommand({}, { env: {}, paths });
  // 截断的 run 被跳过,good-run 仍正常返回
  assert.equal(result.count, 1);
  assert.equal(result.runs[0].runId, 'good-run');
});
