import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { resolveWorkerPaths } from '../lib/config.mjs';
import { assertDelegableCapabilities, validateTaskContract } from '../lib/contracts.mjs';
import { selectProfileForTask } from '../lib/difficulty.mjs';
import { buildCohort, buildMetrics } from '../lib/metrics.mjs';
import { makeTempDir } from './helpers.mjs';

function makeTask(overrides = {}) {
  return {
    schemaVersion: 1, runId: 'test-run', repositoryRoot: '/tmp/repo', baseRevision: 'a'.repeat(40),
    goal: 'Add a small helper function.', allowedPaths: ['src/**'], forbiddenPaths: ['.env*'],
    constraints: [], acceptanceCriteria: ['tests pass'], verification: [{ argv: ['npm', 'test'], timeoutSeconds: 120, env: {} }],
    requiredCapabilities: ['text', 'code'], risk: 'low', ...overrides,
  };
}

// M5: high-risk 用独立错误码 HIGH_RISK_BLOCKED
test('assertDelegableCapabilities throws HIGH_RISK_BLOCKED for high-risk tasks', () => {
  const task = makeTask({ risk: 'high' });
  assert.throws(
    () => assertDelegableCapabilities(task, { capabilities: ['text', 'code', 'tool-use'] }),
    (error) => error.code === 'HIGH_RISK_BLOCKED',
  );
});

// M3: 显式 profile 不存在时抛错而非静默回退
test('selectProfileForTask throws on unknown explicit profile', () => {
  const config = { defaultProfile: 'a', profiles: { a: { provider: 'p', model: 'm', apiKeyEnv: 'K', capabilities: ['text', 'code'], fallbackProfiles: [], costTier: 'cheap' } } };
  assert.throws(
    () => selectProfileForTask(config, makeTask(), { profile: 'nonexistent' }),
    /Unknown profile: nonexistent/,
  );
});

// M5: high-risk 任务 selectProfileForTask 直接返回 null
test('selectProfileForTask returns null for high-risk tasks without explicit profile', () => {
  const config = { defaultProfile: 'cheap', profiles: { cheap: { provider: 'p', model: 'm', apiKeyEnv: 'K', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'cheap' } } };
  const result = selectProfileForTask(config, makeTask({ risk: 'high' }));
  assert.equal(result, null);
});

// H5: maxConcurrentRuns 范围校验
test('validateConfig rejects maxConcurrentRuns out of range', async () => {
  const { loadConfig } = await import('../lib/config.mjs');
  const home = await makeTempDir('config-mcr-');
  const paths = resolveWorkerPaths({}, home);
  await mkdir(path.dirname(paths.configFile), { recursive: true });
  for (const bad of [0, 17, -1, 4.5, '4']) {
    await writeFile(paths.configFile, JSON.stringify({ schemaVersion: 1, minimumPiVersion: '1.0.0', defaultProfile: 'a', maxRevisionRounds: 2, autoIntegrateCleanSource: true, retryDelaysMs: [1000], limits: { piTimeoutSeconds: 300, maxChangedFiles: 80, maxDeletedLineRatio: 0.5, maxCapturedCharsPerStream: 100000, maxDiffBytes: 500000 }, verificationEnvAllowlist: ['CI'], alwaysForbiddenPaths: ['.env*'], parentRateCard: { model: 'm', effectiveDate: '2026-01-01', source: 'test', creditsPerMillion: { nonCachedInput: 1, cachedInput: 1, output: 1 } }, parentSubscription: { plan: 'plus', monthlyUsd: 20 }, profiles: { a: { provider: 'p', model: 'm', apiKeyEnv: 'K', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'cheap' } }, maxConcurrentRuns: bad }));
    await assert.rejects(() => loadConfig(paths), (error) => error.code === 'CONFIG_INVALID');
  }
});

// H3: metrics 在 legacy run(缺 parentUsageStart)时不崩
test('buildMetrics handles legacy run without parentUsageStart', async () => {
  const config = { profiles: { volcengine: { provider: 'p', model: 'm', apiKeyEnv: 'K', capabilities: ['text', 'code'], fallbackProfiles: [], monthlyPlan: { currency: 'USD', amount: 0 } } }, parentRateCard: { model: 'm', effectiveDate: '2026-01-01', source: 'test', creditsPerMillion: { nonCachedInput: 1, cachedInput: 1, output: 1 } }, parentSubscription: { plan: 'plus', monthlyUsd: 20 } };
  const state = { runId: 'legacy', profile: 'volcengine', provider: 'p', model: 'm', revisionRound: 0, fallbackUsed: false, implementationCommit: null, integratedCommit: null };
  // 不传 parentUsageStart(legacy)
  const metrics = buildMetrics({ state, verification: { passed: true, security: { passed: true } }, review: { findings: [] }, config, parentDelta: { available: false }, piUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, requests: 1, durationMs: 1000 }, successfulTasksThisMonth: 1 });
  assert.equal(metrics.elapsedMs, null);
  assert.equal(metrics.parent.actualCredits, null);
});

// H4: buildCohort 对畸形 metrics(缺 quality/counterfactual)不崩
test('buildCohort tolerates malformed metrics', async () => {
  const home = await makeTempDir('cohort-malformed-');
  const paths = resolveWorkerPaths({}, home);
  const runsRoot = path.join(paths.stateRoot, 'runs');
  await mkdir(path.join(runsRoot, 'run1'), { recursive: true });
  // 缺 quality 和 counterfactual 字段
  await writeFile(path.join(runsRoot, 'run1', 'metrics.json'), JSON.stringify({ schemaVersion: 1, runId: 'run1', generatedAt: '2026-01-01T00:00:00.000Z' }));
  const cohort = await buildCohort(paths);
  assert.equal(cohort.sampleSize, 1);
  assert.equal(cohort.unresolvedBlockingFindings, 0);
  assert.equal(cohort.medianSavingRate, null);
  assert.equal(cohort.recommendation, 'collect-more-data');
});

// M1: 当所有 run 都没有 saving rate 数据(如使用 Kimi/Trae adapter 无 usage)时,推荐 no-usage-data-available
test('buildCohort recommends no-usage-data-available when all runs lack saving rate', async () => {
  const home = await makeTempDir('cohort-null-');
  const paths = resolveWorkerPaths({}, home);
  const runsRoot = path.join(paths.stateRoot, 'runs');
  for (let i = 0; i < 12; i++) {
    await mkdir(path.join(runsRoot, `run${i}`), { recursive: true });
    // 有 quality 但 counterfactual.estimatedCreditSavingRate 缺失(非流式 adapter 场景)
    await writeFile(path.join(runsRoot, `run${i}`, 'metrics.json'), JSON.stringify({ schemaVersion: 1, runId: `run${i}`, generatedAt: new Date(2026, 0, i + 1).toISOString(), quality: { committed: true, finalVerificationPassed: true, unresolvedBlockingFindings: 0, revisionRounds: 0 } }));
  }
  const cohort = await buildCohort(paths);
  assert.equal(cohort.recommendation, 'no-usage-data-available');
});

// L5: runId 含 .. 或 .lock 被拒
test('validateTaskContract rejects runId with .. or .lock suffix', () => {
  assert.throws(() => validateTaskContract({ ...makeTask(), runId: 'a..b' }), (e) => e.code === 'CONTRACT_INVALID');
  assert.throws(() => validateTaskContract({ ...makeTask(), runId: 'run.lock' }), (e) => e.code === 'CONTRACT_INVALID');
});
