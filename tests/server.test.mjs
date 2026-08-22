/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { resolveWorkerPaths } from '../lib/config.mjs';
import { buildConnectionsPayload, renderDashboardFragment, renderDashboardHtml } from '../lib/dashboard.mjs';
import { buildRunsPayload, createRequestHandler, readMetricsList } from '../lib/server.mjs';
import { makeTempDir } from './helpers.mjs';

async function seedRun(paths, overrides = {}) {
  const runId = overrides.runId ?? 'run-' + Math.random().toString(16).slice(2);
  const dir = path.join(paths.stateRoot, 'runs', runId);
  await mkdir(dir, { recursive: true });
  const now = overrides.createdAt ?? new Date().toISOString();
  const state = {
  schemaVersion: 1,
  runId,
  status: overrides.status ?? 'integrated',
  createdAt: now,
  updatedAt: now,
  caller: overrides.caller,
  provider: overrides.provider ?? 'volcengine-plan',
  model: overrides.model ?? 'ark-code-latest',
  profile: 'volcengine-plan',
  revisionRound: 0,
  fallbackUsed: false,
  implementationCommit: overrides.implementationCommit ?? 'abc123def456789012345678901234567890abcd',
  integratedCommit: null,
  sourceBranch: 'main',
  workerBranch: 'pi-worker/' + runId,
  transitions: [],
  };
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  if (overrides.withMetrics !== false) {
  const metrics = {
  schemaVersion: 1, runId, generatedAt: now, elapsedMs: 5000,
  quality: { finalVerificationPassed: true, securityPassed: true, unresolvedBlockingFindings: 0, revisionRounds: 0, fallbackUsed: false, committed: true, integrated: true },
  codex: { model: 'gpt-5.6-sol', usage: { available: true, inputTokens: 2000, outputTokens: 200, totalTokens: 2200 }, actualCredits: 0.24 },
  pi: { provider: state.provider, model: state.model, usage: { inputTokens: 120, outputTokens: 30, totalTokens: 170, requests: 1, durationMs: 1500 } },
  counterfactual: { estimatedCreditSavingRate: 0.5 },
  };
  await writeFile(path.join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
  }
  return state;
}

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return { server, url: 'http://localhost:' + port };
}

async function fetchJson(url) {
  const res = await fetch(url);
  return { status: res.status, json: await res.json() };
}

async function fetchText(url) {
  const res = await fetch(url);
  return { status: res.status, text: await res.text() };
}

test('buildRunsPayload returns states, metricsList, and generatedAt', async () => {
  const home = await makeTempDir('server-payload-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'payload-run' });
  const payload = await buildRunsPayload(paths);
  assert.equal(payload.states.length, 1);
  assert.equal(payload.states[0].runId, 'payload-run');
  assert.equal(payload.metricsList.length, 1);
  assert.equal(payload.metricsList[0].runId, 'payload-run');
  assert.ok(payload.generatedAt);
});

test('readMetricsList returns null for runs without metrics', async () => {
  const home = await makeTempDir('server-no-metrics-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'no-metrics-run', withMetrics: false });
  const states = [{ runId: 'no-metrics-run' }];
  const metricsList = await readMetricsList(paths, states);
  assert.equal(metricsList.length, 1);
  assert.equal(metricsList[0], null);
});

test('GET / returns live HTML with refresh button and dashboard-body', async () => {
  const home = await makeTempDir('server-html-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'html-run' });
  const { server, url } = await startServer(createRequestHandler(paths, { port: 0 }));
  try {
  const { status, text } = await fetchText(url + '/');
  assert.equal(status, 200);
  assert.match(text, /Pi Worker Dashboard/);
  assert.match(text, /html-run/);
  assert.match(text, /class="panel-refresh-btn"/);
  assert.match(text, /id="dashboard-body"/);
  assert.match(text, /\/api\/fragment/);
  } finally {
  server.close();
  }
});

test('GET /api/fragment returns bodyHtml with run data', async () => {
  const home = await makeTempDir('server-fragment-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'frag-run' });
  const { server, url } = await startServer(createRequestHandler(paths, { port: 0 }));
  try {
  const { status, json } = await fetchJson(url + '/api/fragment');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.match(json.bodyHtml, /frag-run/);
  assert.ok(json.generatedAt);
  } finally {
  server.close();
  }
});

test('GET /api/runs returns states and metricsList', async () => {
  const home = await makeTempDir('server-runs-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'runs-run' });
  const { server, url } = await startServer(createRequestHandler(paths, { port: 0 }));
  try {
  const { status, json } = await fetchJson(url + '/api/runs');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.states.length, 1);
  assert.equal(json.metricsList.length, 1);
  assert.equal(json.states[0].runId, 'runs-run');
  } finally {
  server.close();
  }
});

test('GET /health returns ok', async () => {
  const home = await makeTempDir('server-health-');
  const paths = resolveWorkerPaths({}, home);
  const { server, url } = await startServer(createRequestHandler(paths, { port: 0 }));
  try {
  const { status, json } = await fetchJson(url + '/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  } finally {
  server.close();
  }
});

test('unknown route returns 404 with NOT_FOUND', async () => {
  const home = await makeTempDir('server-404-');
  const paths = resolveWorkerPaths({}, home);
  const { server, url } = await startServer(createRequestHandler(paths, { port: 0 }));
  try {
  const { status, json } = await fetchJson(url + '/unknown');
  assert.equal(status, 404);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'NOT_FOUND');
  } finally {
  server.close();
  }
});

test('GET / handles empty runs gracefully', async () => {
  const home = await makeTempDir('server-empty-');
  const paths = resolveWorkerPaths({}, home);
  const { server, url } = await startServer(createRequestHandler(paths, { port: 0 }));
  try {
  const { status, text } = await fetchText(url + '/');
  assert.equal(status, 200);
  assert.match(text, /No runs yet/);
  } finally {
  server.close();
  }
});

test('renderDashboardFragment escapes HTML in runId', () => {
  const malicious = {
  runId: '<script>x</script>',
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
  const fragment = renderDashboardFragment([malicious], [null], new Date().toISOString());
  assert.ok(!fragment.bodyHtml.includes('<script>x</script>'));
});

test('renderDashboardHtml with live option includes refresh button', () => {
  const state = { runId: 'live-run', status: 'integrated', caller: 'trae', provider: 'p', model: 'm', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revisionRound: 0, fallbackUsed: false, implementationCommit: null, integratedCommit: null, sourceBranch: null, workerBranch: null, transitions: [] };
  const html = renderDashboardHtml([state], [null], new Date().toISOString(), { live: true });
  assert.match(html, /class="panel-refresh-btn"/);
  assert.match(html, /id="dashboard-body"/);
  assert.match(html, /\/api\/fragment/);
});

test('renderDashboardHtml without live option has no refresh button', () => {
  const state = { runId: 'static-run', status: 'integrated', caller: 'trae', provider: 'p', model: 'm', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revisionRound: 0, fallbackUsed: false, implementationCommit: null, integratedCommit: null, sourceBranch: null, workerBranch: null, transitions: [] };
  const html = renderDashboardHtml([state], [null], new Date().toISOString());
  assert.ok(!html.includes('id="refresh-btn"'));
  assert.ok(!html.includes('id="dashboard-body"'));
});

// === dashboard-conn-tab-20260726: /api/connections ===

async function seedConnectionsConfig(paths, env) {
  const minimalConfig = {
  schemaVersion: 1,
  minimumPiVersion: '0.80.10',
  defaultProfile: 'volcengine',
  maxRevisionRounds: 2,
  autoIntegrateCleanSource: true,
  retryDelaysMs: [1000],
  limits: {
  piTimeoutSeconds: 1800,
  maxChangedFiles: 80,
  maxDeletedLineRatio: 0.35,
  maxCapturedCharsPerStream: 12000,
  maxDiffBytes: 2000000,
  },
  verificationEnvAllowlist: ['CI'],
  alwaysForbiddenPaths: ['.git/**'],
  parentRateCard: { model: 'x', effectiveDate: '2026-01-01', source: 's', creditsPerMillion: { nonCachedInput: 1, cachedInput: 1, output: 1 } },
  parentSubscription: { plan: 'plus', monthlyUsd: 20 },
  profiles: {
  volcengine: { provider: 'volcengine-plan', model: 'ark-latest', apiKeyEnv: 'VOLCENGINE_API_KEY', adapter: 'pi', capabilities: ['text', 'code'], fallbackProfiles: ['kimi', 'trae-cli'], monthlyPlan: { currency: 'CNY', amount: 0 } },
  kimi: { provider: 'kimi-coding', model: 'kimi-for-coding', apiKeyEnv: 'KIMI_API_KEY', adapter: 'kimi', capabilities: ['text', 'code'], fallbackProfiles: [], monthlyPlan: { currency: 'CNY', amount: 0 } },
  'trae-cli': { provider: 'trae', model: 'trae-default', apiKeyEnv: 'TRAE_CLI_TOKEN', adapter: 'trae', capabilities: ['text', 'code'], fallbackProfiles: [], monthlyPlan: { currency: 'CNY', amount: 0 } },
  },
  };
  await mkdir(path.dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, JSON.stringify(minimalConfig, null, 2) + '\n');
}

test('buildConnectionsPayload returns adapters[] and profiles[] with required fields', async () => {
  const home = await makeTempDir('server-conn-payload-');
  const paths = resolveWorkerPaths({}, home);
  await seedConnectionsConfig(paths);
  const env = { ...process.env, PATH: '' };
  const payload = await buildConnectionsPayload({ env, paths });
  assert.ok(Array.isArray(payload.adapters));
  assert.ok(Array.isArray(payload.profiles));
  // each adapter all at least have name / available / version / stderr / bin
  for (const a of payload.adapters) {
  assert.equal(typeof a.name, 'string');
  assert.equal(typeof a.available, 'boolean');
  assert.ok(Object.prototype.hasOwnProperty.call(a, 'version'));
  assert.ok(Object.prototype.hasOwnProperty.call(a, 'stderr'));
  assert.ok(Object.prototype.hasOwnProperty.call(a, 'bin'));
  }
  // profile fields: name / provider / model / adapter / apiKeyEnv / credentialAvailable / hint / hintType
  for (const p of payload.profiles) {
  assert.equal(typeof p.name, 'string');
  assert.equal(typeof p.provider, 'string');
  assert.equal(typeof p.model, 'string');
  assert.equal(typeof p.adapter, 'string');
  assert.equal(typeof p.apiKeyEnv, 'string');
  assert.equal(typeof p.credentialAvailable, 'boolean');
  assert.ok(['env', 'oauth', 'none'].includes(p.hintType));
  }
});

test('buildConnectionsPayload marks profiles with credentialAvailable=false when env keys missing', async () => {
  const home = await makeTempDir('server-conn-partial-');
  const paths = resolveWorkerPaths({}, home);
  await seedConnectionsConfig(paths);
  // only set one of them key,the rest considered not configured
  // HOME must point at the temp dir so loadShellProfileEnv cannot read the real ~/.zshrc
  const env = { PATH: '', HOME: home };
  const payload = await buildConnectionsPayload({ env, paths });
  const volcengine = payload.profiles.find((p) => p.name === 'volcengine');
  const kimi = payload.profiles.find((p) => p.name === 'kimi');
  const trae = payload.profiles.find((p) => p.name === 'trae-cli');
  assert.equal(volcengine.credentialAvailable, false);
  assert.equal(volcengine.hintType, 'env');
  assert.match(volcengine.hint, /export VOLCENGINE_API_KEY=/);
  assert.equal(kimi.hintType, 'env');
  assert.match(kimi.hint, /export KIMI_API_KEY=/);
  assert.equal(trae.hintType, 'oauth');
  assert.match(trae.hint, /traecli/);
});

test('buildConnectionsPayload marks profile credentialAvailable=true when env key present', async () => {
  const home = await makeTempDir('server-conn-set-');
  const paths = resolveWorkerPaths({}, home);
  await seedConnectionsConfig(paths);
  const env = { PATH: '', VOLCENGINE_API_KEY: 'redacted-value', KIMI_API_KEY: 'also-redacted', TRAE_CLI_TOKEN: 'third-redacted' };
  const payload = await buildConnectionsPayload({ env, paths });
  for (const p of payload.profiles) {
  assert.equal(p.credentialAvailable, true, p.name + ' should be configured');
  assert.equal(p.hintType, 'none');
  assert.equal(p.hint, null);
  }
  // strictly forbid real env value leaks to hint
  const json = JSON.stringify(payload);
  assert.ok(!json.includes('redacted-value'));
  assert.ok(!json.includes('also-redacted'));
  assert.ok(!json.includes('third-redacted'));
});


test('buildConnectionsPayload falls back to shell profile env when process.env lacks key', async () => {
  // simulate server from GUI/non-interactive shell start:process env no API key,
  // but user ~/.zshrc in export .dashboard should be recognized as configured.
  const home = await makeTempDir('server-conn-shellprofile-');
  const paths = resolveWorkerPaths({}, home);
  await seedConnectionsConfig(paths);
  // in temporary home write .zshrc,includes VOLCENGINE_API_KEY  export statement
  const zshrcContent = [
  '# conda init block (simulated)',
  'export PATH=/usr/local/bin:$PATH',
  "export VOLCENGINE_API_KEY='shell-profile-key'",
  'export KIMI_API_KEY="another-key"',
  '# placeholder export SHOULD_NOT_LEAK=YOUR_KEY_HERE',
  ].join('\n') + '\n';
  await writeFile(path.join(home, '.zshrc'), zshrcContent);
  // env does not contain any API key,but HOME points to temporary directory(has .zshrc)
  const env = { PATH: '', HOME: home };
  const payload = await buildConnectionsPayload({ env, paths });
  const volcengine = payload.profiles.find((p) => p.name === 'volcengine');
  const kimi = payload.profiles.find((p) => p.name === 'kimi');
  const trae = payload.profiles.find((p) => p.name === 'trae-cli');
  assert.equal(volcengine.credentialAvailable, true, 'volcengine should from .zshrc fallback recognized as configured');
  assert.equal(volcengine.hintType, 'none');
  assert.equal(kimi.credentialAvailable, true, 'kimi should from .zshrc fallback recognized as configured');
  assert.equal(trae.credentialAvailable, false, 'trae use OAuth,.zshrc not having in does not affect');
  // strictly forbid key value leaks to payload
  const json = JSON.stringify(payload);
  assert.ok(!json.includes('shell-profile-key'), 'key value must not leak to payload');
  assert.ok(!json.includes('another-key'), 'key value must not leak to payload');
  assert.ok(!json.includes('YOUR_KEY_HERE'), 'placeholders should not be treated as real credentials');
});

test('buildConnectionsPayload prefers process.env over shell profile', async () => {
  // process.env value in takes precedence over shell profile value in
  const home = await makeTempDir('server-conn-env-priority-');
  const paths = resolveWorkerPaths({}, home);
  await seedConnectionsConfig(paths);
  await writeFile(path.join(home, '.zshrc'), "export VOLCENGINE_API_KEY='from-profile'\n");
  // process.env has value in,should prefer this(although both are judged as configured)
  const env = { PATH: '', HOME: home, VOLCENGINE_API_KEY: 'from-process-env' };
  const payload = await buildConnectionsPayload({ env, paths });
  const volcengine = payload.profiles.find((p) => p.name === 'volcengine');
  assert.equal(volcengine.credentialAvailable, true);
  // neither value should leak
  const json = JSON.stringify(payload);
  assert.ok(!json.includes('from-profile'));
  assert.ok(!json.includes('from-process-env'));
});

test('GET /api/connections returns ok:true with adapters[] and profiles[]', async () => {
  const home = await makeTempDir('server-conn-route-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'conn-run' });
  await seedConnectionsConfig(paths);
  const prevPath = process.env.PATH;
  process.env.PATH = '';
  const { server, url } = await startServer(createRequestHandler(paths, { port: 0 }));
  try {
  const { status, json } = await fetchJson(url + '/api/connections');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(typeof json.generatedAt === 'string' && json.generatedAt.length > 0);
  assert.ok(Array.isArray(json.adapters));
  assert.ok(Array.isArray(json.profiles));
  // should at least contain known adapters (pi/kimi/trae/qoder/opencode)
  assert.ok(json.adapters.length >= 5, `expected >=5 adapters, got ${json.adapters.length}`);
  const adapterNames = json.adapters.map((a) => a.name).sort();
  assert.deepEqual(adapterNames, ['kimi', 'opencode', 'pi', 'qoder', 'trae']);
  // profile must contain seed the three written
  const profileNames = json.profiles.map((p) => p.name).sort();
  assert.deepEqual(profileNames, ['kimi', 'trae-cli', 'volcengine']);
  } finally {
  if (prevPath === undefined) delete process.env.PATH;
  else process.env.PATH = prevPath;
  server.close();
  }
});

test('GET /api/connections never throws when env has no PATH and adapters fail to probe', async () => {
  const home = await makeTempDir('server-conn-empty-env-');
  const paths = resolveWorkerPaths({}, home);
  const prevPath = process.env.PATH;
  process.env.PATH = '';
  const { server, url } = await startServer(createRequestHandler(paths, { port: 0 }));
  try {
  const { status, json } = await fetchJson(url + '/api/connections');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  // With PATH empty, adapters without a resolvable bin stay unavailable.
  // Adapters that declare candidateBins pointing at an existing file (e.g.
  // OpenCode at ~/.opencode/bin/opencode) become available via the fallback.
  for (const a of json.adapters) {
    if (a.name === 'opencode') assert.equal(a.available, true);
    else assert.equal(a.available, false);
  }
  // no config.json when profiles is an empty array
  assert.deepEqual(json.profiles, []);
  } finally {
  if (prevPath === undefined) delete process.env.PATH;
  else process.env.PATH = prevPath;
  server.close();
  }
});

test('GET / returns the connections panel HTML alongside the existing dashboard content', async () => {
  const home = await makeTempDir('server-html-conn-');
  const paths = resolveWorkerPaths({}, home);
  await seedRun(paths, { runId: 'dashboard-html-conn' });
  const prevPath = process.env.PATH;
  process.env.PATH = '';
  const { server, url } = await startServer(createRequestHandler(paths, { port: 0 }));
  try {
  const { status, text } = await fetchText(url + '/');
  assert.equal(status, 200);
  // existing live elements retained
  assert.match(text, /class="panel-refresh-btn"/);
  assert.match(text, /id="dashboard-body"/);
  // newly added dual tab + side panels
  assert.match(text, /id="tab-btn-dashboard"/);
  assert.match(text, /id="tab-btn-connections"/);
  assert.match(text, /id="connections-body"/);
  assert.match(text, /CLI \/ model usage statistics/);
  } finally {
  if (prevPath === undefined) delete process.env.PATH;
  else process.env.PATH = prevPath;
  server.close();
  }
});
