import assert from 'node:assert/strict';
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { snapshotCodexUsage, usageDelta } from '../lib/codex-usage.mjs';
import { priceAtSolRate } from '../lib/metrics.mjs';
import { transition, updateRun } from '../lib/state.mjs';
import { runNode } from './helpers.mjs';
import { cli, createReviewedFixture } from './workflow-fixture.mjs';

const skillRoot = path.resolve(new URL('..', import.meta.url).pathname);
const meter = path.join(skillRoot, 'scripts', 'codex-meter.mjs');

function tokenEvent(input, cached, output) {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          cache_write_input_tokens: 0,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: input + output,
        },
      },
    },
  });
}

test('Codex session parser reads the last cumulative token event and computes a delta', async () => {
  const home = await import('./helpers.mjs').then(({ makeTempDir }) => makeTempDir('codex-usage-'));
  const threadId = '019f8c7b-e659-7463-9f1e-6ef0bd02437a';
  const directory = path.join(home, '.codex', 'sessions', '2026', '07', '23');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-test-${threadId}.jsonl`);
  await writeFile(file, `${tokenEvent(1000, 800, 100)}\n${tokenEvent(3000, 2200, 300)}\n`);
  const end = await snapshotCodexUsage({ home, threadId });
  assert.equal(end.available, true);
  assert.equal(end.inputTokens, 3000);
  const delta = usageDelta({ available: true, inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100 }, end);
  assert.deepEqual({ input: delta.inputTokens, cached: delta.cachedInputTokens, output: delta.outputTokens }, { input: 2000, cached: 1400, output: 200 });
  const output = path.join(home, 'start.json');
  const metered = await runNode(meter, ['--output', output], { env: { ...process.env, HOME: home, CODEX_THREAD_ID: threadId } });
  assert.equal(metered.code, 0, metered.stderr);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).inputTokens, 3000);
});

test('Sol rate-card arithmetic separates cached and non-cached input', () => {
  const rates = { nonCachedInput: 125, cachedInput: 12.5, output: 750 };
  const actual = priceAtSolRate({ inputTokens: 2000, cachedInputTokens: 1400, outputTokens: 200 }, rates, 'codex-cumulative');
  const displaced = priceAtSolRate({ inputTokens: 1000, cachedInputTokens: 500, cacheWriteInputTokens: 100, outputTokens: 200 }, rates, 'pi-separated');
  assert.equal(actual.credits, 0.2425);
  assert.equal(displaced.credits, 0.29375);
});

test('report distinguishes Plus fixed cost, external plan amortization, and estimated credits', async () => {
  const item = await createReviewedFixture();
  const approved = await runNode(cli, ['approve', '--id', item.runId, '--review', item.reviewFile, '--message', 'feat: add verified answer module'], { env: item.env });
  assert.equal(approved.code, 0, approved.stderr);
  const integrated = await runNode(cli, ['integrate', '--id', item.runId], { env: item.env });
  assert.equal(integrated.code, 0, integrated.stderr);
  await appendFile(item.codexSessionFile, `${tokenEvent(3000, 2200, 300)}\n`);
  const reported = await runNode(cli, ['report', '--id', item.runId, '--chatgpt-image-generations', '0'], { env: item.env });
  assert.equal(reported.code, 0, reported.stderr);
  const payload = JSON.parse(reported.stdout);
  const metrics = JSON.parse(await readFile(payload.metricsFile, 'utf8'));
  assert.equal(metrics.parent.actualCredits, 0.2425);
  assert.equal(metrics.parent.measurementStartSource, 'prepare-fallback');
  assert.equal(metrics.pi.usage.inputTokens, 120);
  assert.equal(metrics.pi.usage.requests, 1);
  assert.ok(metrics.pi.usage.durationMs > 0);
  assert.ok(metrics.elapsedMs >= metrics.pi.usage.durationMs);
  assert.equal(metrics.cash.codexPlusMonthlyUsd, 20);
  assert.equal(metrics.cash.providerPlan.currency, 'CNY');
  assert.equal(metrics.cash.cashSavingsAmount, 0);
  assert.deepEqual(metrics.visual, { route: 'chatgpt-web', generations: 0, delegatedToPi: false, excludedFromCodeSavings: true });
  assert.match(await readFile(payload.reportFile, 'utf8'), /反事实估算/);
  assert.match(await readFile(payload.reportFile, 'utf8'), /未推送远端/);

  const cleaned = await runNode(cli, ['cleanup', '--id', item.runId], { env: item.env });
  assert.equal(cleaned.code, 0, cleaned.stderr);
  await assert.rejects(access(item.worktree), { code: 'ENOENT' });
  await access(path.join(item.paths.stateRoot, 'runs', item.runId, 'state.json'));
});

test('report explains blocked security guardrails without exposing secret values', async () => {
  const item = await createReviewedFixture();
  await updateRun(item.paths, item.runId, (state) => transition(state, 'blocked', {
    security: { passed: false, issues: [{ code: 'SECRET_DETECTED', message: 'Added lines contain a probable credential' }] },
  }, 'security guardrail'));
  const reported = await runNode(cli, ['report', '--id', item.runId], { env: item.env });
  assert.equal(reported.code, 0, reported.stderr);
  const payload = JSON.parse(reported.stdout);
  const report = await readFile(payload.reportFile, 'utf8');
  assert.match(report, /阻断原因：security guardrail/);
  assert.match(report, /安全问题：SECRET_DETECTED/);
  assert.doesNotMatch(report, /probable credential/);
});
