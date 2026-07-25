import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { resolveWorkerPaths } from '../lib/config.mjs';
import { renderDashboardFragment, renderDashboardHtml } from '../lib/dashboard.mjs';
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
    assert.match(text, /Pi Worker 监控台/);
    assert.match(text, /html-run/);
    assert.match(text, /id="refresh-btn"/);
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
    assert.match(text, /还没有任何 run/);
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
  assert.match(html, /id="refresh-btn"/);
  assert.match(html, /id="dashboard-body"/);
  assert.match(html, /\/api\/fragment/);
});

test('renderDashboardHtml without live option has no refresh button', () => {
  const state = { runId: 'static-run', status: 'integrated', caller: 'trae', provider: 'p', model: 'm', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revisionRound: 0, fallbackUsed: false, implementationCommit: null, integratedCommit: null, sourceBranch: null, workerBranch: null, transitions: [] };
  const html = renderDashboardHtml([state], [null], new Date().toISOString());
  assert.ok(!html.includes('id="refresh-btn"'));
  assert.ok(!html.includes('id="dashboard-body"'));
});
