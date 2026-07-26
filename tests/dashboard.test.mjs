/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { resolveWorkerPaths } from '../lib/config.mjs';
import {
  buildConnectionsList,
  buildProviderModelAggregation,
  computeRelevantProfileNames,
  dashboardCommand,
  inspectCommand,
  listCommand,
  renderConnectionsPanelHtml,
  renderDashboardHtml,
  summarizeState,
} from '../lib/dashboard.mjs';
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
  assert.match(html, /Pi Worker Dashboard/);
  assert.match(html, /dash-trae/);
  assert.match(html, /dash-codex/);
  assert.match(html, /trae/);
  assert.match(html, /codex/);
  assert.match(html, /<table/);
  assert.match(html, /Total Runs/);
  assert.match(html, /call source/);
  assert.match(html, /mean saving rate/);
});

test('dashboard handles empty state with a helpful message', async () => {
  const home = await makeTempDir('dashboard-empty-');
  const paths = resolveWorkerPaths({}, home);
  const outputFile = path.join(home, 'empty.html');
  const result = await dashboardCommand({ output: outputFile }, { env: {}, paths });
  assert.equal(result.runCount, 0);
  const html = await readFile(outputFile, 'utf8');
  assert.match(html, /No runs yet/);
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
  // simulate concurrent write mid-state:write truncated JSON
  const dir = path.join(paths.stateRoot, 'runs', 'mid-write-run');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'state.json'), '{"runId":"mid-write-r'); // truncated
  const result = await listCommand({}, { env: {}, paths });
  // truncated run skipped,good-run still returns normally
  assert.equal(result.count, 1);
  assert.equal(result.runs[0].runId, 'good-run');
});

// === dashboard-conn-tab-20260726: provider+model aggregation ===

test('buildProviderModelAggregation groups runs by provider+model deterministically', () => {
  // minimal row structure,only covers buildProviderModelAggregation fields of concern
  const rows = [
  { runId: 'a', caller: 'trae', provider: 'volcengine-plan', model: 'ark-latest', createdAt: '2026-07-20T00:00:00.000Z', piRequests: 1, piInput: 100, piOutput: 50, piDuration: 2000, equivalentCredits: 0.1, savingRate: 0.4 },
  { runId: 'b', caller: 'codex', provider: 'volcengine-plan', model: 'ark-latest', createdAt: '2026-07-22T00:00:00.000Z', piRequests: 2, piInput: 200, piOutput: 100, piDuration: 3000, equivalentCredits: 0.2, savingRate: 0.6 },
  { runId: 'c', caller: 'trae', provider: 'kimi', model: 'kimi-for-coding', createdAt: '2026-07-23T00:00:00.000Z', piRequests: 0, piInput: 0, piOutput: 0, piDuration: 0, equivalentCredits: 0, savingRate: null },
  ];
  const groups = buildProviderModelAggregation(rows);
  assert.equal(groups.length, 2, 'should by provider+model split into two groups');
  const volcengine = groups.find((g) => g.provider === 'volcengine-plan' && g.model === 'ark-latest');
  const kimi = groups.find((g) => g.provider === 'kimi' && g.model === 'kimi-for-coding');
  assert.ok(volcengine, 'must exist volcengine-plan/ark-latest group');
  assert.ok(kimi, 'must exist kimi/kimi-for-coding group');
  assert.equal(volcengine.runCount, 2);
  assert.equal(volcengine.totalPiRequests, 3);
  assert.equal(volcengine.totalPiInput, 300);
  assert.equal(volcengine.totalPiOutput, 150);
  assert.equal(volcengine.totalPiDuration, 5000);
  assert.ok(Math.abs(volcengine.totalEquivalentCredits - 0.3) < 1e-9);
  assert.ok(Math.abs(volcengine.meanSavingRate - 0.5) < 1e-9);
  assert.equal(volcengine.lastUsed, '2026-07-22T00:00:00.000Z');
  assert.equal(kimi.runCount, 1);
  assert.equal(kimi.totalPiRequests, 0);
  assert.equal(kimi.meanSavingRate, null);
});

test('buildProviderModelAggregation returns empty array for empty rows', () => {
  const groups = buildProviderModelAggregation([]);
  assert.deepEqual(groups, []);
});

test('buildProviderModelAggregation sorts by runCount desc then lastUsed desc', () => {
  const mk = (runId, provider, model, createdAt) => ({ runId, caller: 'trae', provider, model, createdAt, piRequests: 0, piInput: 0, piOutput: 0, piDuration: 0, equivalentCredits: 0, savingRate: null });
  const rows = [
  mk('a', 'p1', 'm1', '2026-07-02T00:00:00.000Z'),
  mk('b', 'p1', 'm1', '2026-07-03T00:00:00.000Z'),
  mk('c', 'p2', 'm2', '2026-07-04T00:00:00.000Z'),
  ];
  const groups = buildProviderModelAggregation(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].runCount, 2);
  assert.equal(groups[1].runCount, 1);
});

// === dashboard-conn-tab-20260726: connections list & panel ===

test('buildConnectionsList computes credentialAvailable from env keys', () => {
  const rawConfig = {
  profiles: {
  volcengine: { provider: 'volcengine-plan', model: 'ark-latest', apiKeyEnv: 'VOLCENGINE_API_KEY', adapter: 'pi' },
  kimi: { provider: 'kimi-coding', model: 'kimi-for-coding', apiKeyEnv: 'KIMI_API_KEY', adapter: 'kimi' },
  trae: { provider: 'trae', model: 'trae-default', apiKeyEnv: 'TRAE_CLI_TOKEN', adapter: 'trae' },
  },
  };
  const env = { VOLCENGINE_API_KEY: 'redacted-value', TRAE_CLI_TOKEN: '' };
  const profiles = buildConnectionsList(env, rawConfig);
  const volcengine = profiles.find((p) => p.name === 'volcengine');
  const kimi = profiles.find((p) => p.name === 'kimi');
  const trae = profiles.find((p) => p.name === 'trae');
  assert.ok(volcengine.credentialAvailable, 'volcengine should be considered configured');
  assert.equal(volcengine.hintType, 'none');
  assert.equal(volcengine.hint, null);
  assert.ok(!kimi.credentialAvailable, 'kimi not configured');
  assert.equal(kimi.hintType, 'env');
  assert.ok(kimi.hint.includes('export KIMI_API_KEY='));
  assert.ok(kimi.hint.includes('YOUR_KEY_HERE'));
  // strictly forbid exposing real env value to hint
  assert.ok(!JSON.stringify(kimi).includes('redacted-value'));
  // trae even if token string is empty,credential considered not configured;hintType is oauth
  assert.ok(!trae.credentialAvailable);
  assert.equal(trae.hintType, 'oauth');
  assert.ok(trae.hint.includes('traecli'));
});

test('buildConnectionsList returns empty array when config missing', () => {
  assert.deepEqual(buildConnectionsList({}, null), []);
  assert.deepEqual(buildConnectionsList({}, {}), []);
  assert.deepEqual(buildConnectionsList({}, { profiles: 'not-an-object' }), []);
});

test('computeRelevantProfileNames filters out unused unconfigured profiles', async () => {
  const rawConfig = {
  defaultProfile: 'm3',
  profiles: {
  m3: { provider: 'm3-corp', model: 'm3-model', apiKeyEnv: 'MINIMAX_CN_API_KEY', adapter: 'pi', fallbackProfiles: ['kimi'] },
  kimi: { provider: 'kimi', model: 'kimi-for-coding', apiKeyEnv: 'KIMI_API_KEY', adapter: 'kimi' },
  volcengine: { provider: 'volcengine-plan', model: 'ark-latest', apiKeyEnv: 'VOLCENGINE_API_KEY', adapter: 'pi' },
  },
  };
  // env only provide the first key;the other two considered not configured
  const env = { MINIMAX_CN_API_KEY: 'redacted-value' };
  // isolation points.stateRoot to a non-existent directory,exclude from history run influence
  const paths = { stateRoot: path.join('/tmp', 'pi-worker-no-runs-' + Math.random().toString(16).slice(2)) };
  const relevant = await computeRelevantProfileNames(paths, rawConfig, env);
  // m3 has credential + is default → related
  assert.ok(relevant.has('m3'), 'm3 should be marked as related(credential + default)');
  // kimi is m3  fallback → related
  assert.ok(relevant.has('kimi'), 'kimi should be marked as related(m3  fallback chain)');
  // volcengine unrelated:no credential, non-default, non-history, non-any-related profile  fallback
  assert.ok(!relevant.has('volcengine'), 'volcengine should not be marked as related(unused and not configured)');
  // verification filter linkage render:ensure not related profile  hint will not leak to HTML
  const allProfiles = buildConnectionsList(env, rawConfig);
  assert.equal(allProfiles.length, 3, 'buildConnectionsList still returns 3 items(no filtering)');
  const filtered = allProfiles.filter((p) => relevant.has(p.name));
  assert.deepEqual(filtered.map((p) => p.name).sort(), ['kimi', 'm3']);
  const html = renderConnectionsPanelHtml([], filtered);
  assert.ok(!html.includes('VOLCENGINE_API_KEY=YOUR_KEY_HERE'), 'not related profile  export hint should not render');
  assert.ok(!html.match(/<code>volcengine<\/code>/), 'not related profile should not appear in the table');
  assert.match(html, /<code>m3<\/code>/, 'related profile m3 should appear');
  assert.match(html, /<code>kimi<\/code>/, 'related profile kimi should appear');
});

test('renderConnectionsPanelHtml renders adapters and profiles with required columns', () => {
  const adapters = [
  { name: 'pi', available: true, version: '1.2.3', stderr: '', bin: '/usr/bin/pi', reason: null },
  { name: 'trae', available: false, version: null, stderr: 'not logged in', bin: '/usr/bin/traecli', reason: 'exit 1' },
  ];
  const profiles = [
  { name: 'volcengine', provider: 'volcengine-plan', model: 'ark-latest', adapter: 'pi', apiKeyEnv: 'VOLCENGINE_API_KEY', credentialAvailable: true, hint: null, hintType: 'none' },
  { name: 'kimi', provider: 'kimi', model: 'kimi-for-coding', adapter: 'kimi', apiKeyEnv: 'KIMI_API_KEY', credentialAvailable: false, hint: 'export KIMI_API_KEY=YOUR_KEY_HERE', hintType: 'env' },
  { name: 'trae-cli', provider: 'trae', model: 'trae-default', adapter: 'trae', apiKeyEnv: 'TRAE_CLI_TOKEN', credentialAvailable: false, hint: 'Run `traecli` once interactively to complete enterprise login.', hintType: 'oauth' },
  ];
  const html = renderConnectionsPanelHtml(adapters, profiles);
  assert.match(html, /CLI adapter connection status/);
  assert.match(html, /Profile credential status/);
  // adapter columns
  assert.match(html, /<th>name<\/th>/);
  assert.match(html, /<th>status<\/th>/);
  assert.match(html, /<th>version<\/th>/);
  assert.match(html, /<th>note<\/th>/);
  // profile columns
  assert.match(html, /<th>Profile<\/th>/);
  assert.match(html, /<th>Provider<\/th>/);
  assert.match(html, /<th>Model<\/th>/);
  assert.match(html, /<th>Adapter<\/th>/);
  assert.match(html, /<th>credential<\/th>/);
  assert.match(html, /<th>action<\/th>/);
  // status badges
  assert.match(html, /connected/);
  assert.match(html, /not connected/);
  // credential states
  assert.match(html, /configured/);
  assert.match(html, /not configured/);
  // copy button + env hint
  assert.match(html, /copy-btn/);
  assert.match(html, /export KIMI_API_KEY=YOUR_KEY_HERE/);
  // oauth hint for trae
  assert.match(html, /Run `traecli` once interactively to complete enterprise login\./);
});

test('renderConnectionsPanelHtml sanitizes raw values to prevent XSS', () => {
  const adapters = [{ name: '<img src=x>', available: true, version: '0.0.1', stderr: '', bin: 'a', reason: null }];
  const profiles = [{ name: 'safe', provider: '<b>p</b>', model: '<b>m</b>', adapter: 'pi', apiKeyEnv: '<KEY>', credentialAvailable: false, hint: '<bad>', hintType: 'env' }];
  const html = renderConnectionsPanelHtml(adapters, profiles);
  assert.ok(!html.includes('<img src=x>'));
  assert.ok(html.includes('&lt;img src=x&gt;'));
  assert.ok(!html.includes('<bad>'));
});

test('renderConnectionsPanelHtml tolerates empty arrays and missing fields', () => {
  const html = renderConnectionsPanelHtml([], []);
  assert.match(html, /No CLI adapters registered/);
  assert.match(html, /No profiles found/);
  const html2 = renderConnectionsPanelHtml(undefined, undefined);
  assert.match(html2, /No CLI adapters registered/);
});

// === dashboard-conn-tab-20260726: two-tab HTML & localStorage ===

test('renderDashboardHtml (live) renders two tab buttons with required labels', () => {
  const state = { runId: 'live', status: 'integrated', caller: 'trae', provider: 'p', model: 'm', createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z', revisionRound: 0, fallbackUsed: false, implementationCommit: null, integratedCommit: null, sourceBranch: null, workerBranch: null, transitions: [] };
  const html = renderDashboardHtml([state], [null], '2026-07-25T00:00:00.000Z', {
  live: true,
  connections: { adapters: [], profiles: [] },
  });
  assert.match(html, /<button[^>]*id="tab-btn-dashboard"[^>]*>Dashboard<\/button>/);
  assert.match(html, /<button[^>]*id="tab-btn-connections"[^>]*>Connections<\/button>/);
  assert.match(html, /<div[^>]*id="tab-dashboard"[^>]*class="tab-panel active"/);
  assert.match(html, /<div[^>]*id="tab-connections"[^>]*class="tab-panel"/);
  assert.match(html, /id="dashboard-body"/);
  assert.match(html, /id="connections-body"/);
  assert.match(html, /CLI \/ model usage statistics/);
});

test('renderDashboardHtml (live) renders a menubar with tab buttons and theme button', () => {
  const html = renderDashboardHtml([], [], new Date().toISOString(), { live: true, connections: { adapters: [], profiles: [] } });
  assert.match(html, /<nav class="menubar"/);
  assert.match(html, /id="tab-btn-dashboard"/);
  assert.match(html, /id="tab-btn-connections"/);
  assert.match(html, /id="theme-btn"/);
});

test('renderDashboardHtml (live) renders per-panel refresh buttons', () => {
  const html = renderDashboardHtml([], [], new Date().toISOString(), { live: true, connections: { adapters: [], profiles: [] } });
  assert.equal((html.match(/class="panel-refresh-btn"/g) || []).length, 2);
  assert.ok(!html.includes('id="refresh-btn"'));
});

test('bindDashboardEvents null-check present in inline script', () => {
  const html = renderDashboardHtml([], [], new Date().toISOString(), { live: true, connections: { adapters: [], profiles: [] } });
  assert.match(html, /text && caller && status/);
});

test('renderDashboardHtml (live) localStorage persistence logic present in inline script', () => {
  const html = renderDashboardHtml([], [], new Date().toISOString(), { live: true, connections: { adapters: [], profiles: [] } });
  assert.match(html, /pi-worker-active-tab/);
  assert.match(html, /localStorage\.setItem\("pi-worker-active-tab"/);
  assert.match(html, /localStorage\.getItem\("pi-worker-active-tab"/);
  // Tab click handler trigger selectTab
  assert.match(html, /addEventListener\("click"/);
});

test('renderDashboardHtml includes the CLI/model usage statistics section in live bodyHtml', () => {
  const stateA = { runId: 'g1a', status: 'integrated', caller: 'trae', provider: 'p1', model: 'm1', createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z', revisionRound: 0, fallbackUsed: false, implementationCommit: null, integratedCommit: null, sourceBranch: null, workerBranch: null, transitions: [] };
  const stateB = { runId: 'g1b', status: 'integrated', caller: 'trae', provider: 'p1', model: 'm1', createdAt: '2026-07-25T01:00:00.000Z', updatedAt: '2026-07-25T01:00:00.000Z', revisionRound: 0, fallbackUsed: false, implementationCommit: null, integratedCommit: null, sourceBranch: null, workerBranch: null, transitions: [] };
  const html = renderDashboardHtml([stateA, stateB], [null, null], '2026-07-25T01:00:00.000Z', { live: true, connections: { adapters: [], profiles: [] } });
  assert.match(html, /CLI \/ model usage statistics/);
  // the section contains provider/model appears at least once
  assert.match(html, /p1/);
  assert.match(html, /m1/);
});

test('renderDashboardHtml refresh handler fetches both /api/fragment and /api/connections', () => {
  const state = { runId: 'live', status: 'integrated', caller: 'trae', provider: 'p', model: 'm', createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z', revisionRound: 0, fallbackUsed: false, implementationCommit: null, integratedCommit: null, sourceBranch: null, workerBranch: null, transitions: [] };
  const html = renderDashboardHtml([state], [null], '2026-07-25T00:00:00.000Z', { live: true, connections: { adapters: [], profiles: [] } });
  assert.match(html, /"\/api\/fragment"/);
  assert.match(html, /"\/api\/connections"/);
  // refresh handler has connections-body replace
  assert.match(html, /getElementById\("connections-body"\)/);
  assert.match(html, /renderClientConnectionsPanel/);
});

test('renderDashboardHtml (static) keeps existing behavior (no refresh button, no dashboard-body wrapper)', () => {
  const state = { runId: 'st', status: 'integrated', caller: 'trae', provider: 'p', model: 'm', createdAt: '2026-07-25T00:00:00.000Z', updatedAt: '2026-07-25T00:00:00.000Z', revisionRound: 0, fallbackUsed: false, implementationCommit: null, integratedCommit: null, sourceBranch: null, workerBranch: null, transitions: [] };
  const html = renderDashboardHtml([state], [null], new Date().toISOString());
  assert.ok(!html.includes('id="refresh-btn"'), 'static HTML should not have refresh button');
  assert.ok(!html.includes('panel-refresh-btn'), 'static HTML should not have panel refresh button');
  assert.ok(!html.includes('id="dashboard-body"'), 'static HTML should not have dashboard-body wrapper');
  // but should have menubar and tabs
  assert.match(html, /class="menubar"/);
  assert.match(html, /tab-btn-dashboard/);
  assert.match(html, /tab-btn-connections/);
});
