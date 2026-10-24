/*
 * spotworkers - Delegate bounded coding tasks to cheap agent workers
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { inferDifficulty } from '../lib/difficulty.mjs';
import { validateTaskContract, validateSelfReviewResult } from '../lib/contracts.mjs';
import { buildMetrics, estimateParentSavings } from '../lib/metrics.mjs';
import { stripUnknownFields } from '../lib/self-review.mjs';

function task(overrides = {}) {
  return {
  schemaVersion: 1,
  runId: 'hardening-run',
  repositoryRoot: '/tmp/repo',
  baseRevision: 'a'.repeat(40),
  goal: 'Add a helper that formats the acceptance summary line',
  allowedPaths: ['src/**'],
  forbiddenPaths: [],
  constraints: [],
  acceptanceCriteria: ['helper returns a string'],
  verification: [{ argv: ['npm', 'test'], timeoutSeconds: 60, env: {} }],
  requiredCapabilities: ['text', 'code'],
  risk: 'low',
  ...overrides,
  };
}

test('contract accepts lockedPaths and explicit difficulty', () => {
  const contract = validateTaskContract(task({ lockedPaths: ['tests/**'], difficulty: 'medium' }));
  assert.deepEqual(contract.lockedPaths, ['tests/**']);
  assert.equal(contract.difficulty, 'medium');
});

test('contract defaults lockedPaths to an empty list', () => {
  assert.deepEqual(validateTaskContract(task()).lockedPaths, []);
});

test('contract rejects unknown difficulty and duplicate lockedPaths', () => {
  assert.throws(() => validateTaskContract(task({ difficulty: 'extreme' })), /difficulty must be/);
  assert.throws(() => validateTaskContract(task({ lockedPaths: ['tests/**', 'tests/**'] })), /must not contain duplicates/);
});

test('explicit difficulty wins over prose signals', () => {
  const result = inferDifficulty(task({
  difficulty: 'low',
  goal: 'x'.repeat(1200),
  acceptanceCriteria: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
  constraints: ['a', 'b', 'c', 'd', 'e'],
  }));
  assert.equal(result.difficulty, 'low');
  assert.equal(result.source, 'explicit');
  assert.equal(result.score, null);
});

test('a carefully written contract no longer inflates into the premium tier', () => {
  // Detailed acceptance criteria and several commands, but low risk and a docs
  // domain: the old size-based scorer pushed this to `high` and premium pricing.
  const detailed = task({
  domain: 'docs',
  goal: 'Document the acceptance summary helper in the module README',
  acceptanceCriteria: ['1', '2', '3', '4', '5', '6', '7', '8'],
  constraints: ['a', 'b', 'c', 'd', 'e'],
  verification: [
  { argv: ['npm', 'test'], timeoutSeconds: 60, env: {} },
  { argv: ['npm', 'run', 'lint'], timeoutSeconds: 60, env: {} },
  { argv: ['npm', 'run', 'docs'], timeoutSeconds: 60, env: {} },
  ],
  });
  assert.notEqual(inferDifficulty(detailed).difficulty, 'high');
});

test('a short vague contract does not fall into the cheapest tier by default', () => {
  const vague = task({ risk: 'medium', goal: 'fix the thing' });
  const result = inferDifficulty(vague);
  assert.equal(result.difficulty, 'medium');
  assert.equal(result.source, 'inferred');
});

test('risk and domain carry the decision', () => {
  assert.equal(inferDifficulty(task({ risk: 'medium', domain: 'systems' })).difficulty, 'medium');
  assert.equal(inferDifficulty(task({ risk: 'low', domain: 'refactor' })).difficulty, 'low');
  // Extra harness surface is what tips a systems task into the premium tier.
  const heavy = task({
    risk: 'medium',
    domain: 'systems',
    verification: [
      { argv: ['npm', 'test'], timeoutSeconds: 60, env: {} },
      { argv: ['npm', 'run', 'lint'], timeoutSeconds: 60, env: {} },
      { argv: ['npm', 'run', 'e2e'], timeoutSeconds: 60, env: {} },
    ],
  });
  assert.equal(inferDifficulty(heavy).difficulty, 'high');
});

test('a self-review with an extra confirmation field is normalized instead of discarded', () => {
  const raw = {
  schemaVersion: 1,
  runId: 'run-1',
  diffSha256: 'a'.repeat(64),
  acceptanceEvidence: [{
  criterion: 'helper returns a string',
  status: 'met',
  evidence: [{ file: 'src/a.js', line: 3, note: 'returns a template literal', verified: true }],
  confidence: 0.9,
  }],
  findings: [],
  uncertainCriteria: [],
  summary: 'Looks correct.',
  diffSha256_confirmed: true,
  };
  const { value, dropped } = stripUnknownFields(raw);
  assert.deepEqual(dropped.sort(), ['acceptanceEvidence[0].confidence', 'acceptanceEvidence[0].evidence[0].verified', 'diffSha256_confirmed']);
  const validated = validateSelfReviewResult(value);
  assert.equal(validated.acceptanceEvidence[0].status, 'met');
});

test('a self-review missing a required field still fails validation', () => {
  const { value } = stripUnknownFields({ schemaVersion: 1, runId: 'run-1', diffSha256: 'a'.repeat(64), acceptanceEvidence: [], findings: [], uncertainCriteria: [], summary: 'x' });
  assert.throws(() => validateSelfReviewResult(value), /acceptanceEvidence/);
});

test('parent savings count the code the main model no longer writes', () => {
  // Numbers from a real run: 75 lines added inside a 9 KB file.
  const verification = { security: { diffBytes: 2500, addedLines: 75, changedFiles: ['src/formatters.js'] } };
  const savings = estimateParentSavings({ verification, selfReviewBytes: 4000, changedFileBytes: 9000 });
  assert.equal(savings.delegated.mode, 'self-review');
  assert.equal(savings.delegated.deliveredBytes, 4000);
  assert.equal(savings.counterfactual.readBytes, Math.round((2500 + 9000) * 1.5));
  assert.equal(savings.counterfactual.writeBytes, Math.round(75 * 45 * 1.5));
  assert.ok(savings.estimatedTokensAvoided > 0);
  // Token ratio and price-weighted ratio differ on purpose: output is dearer.
  assert.ok(savings.estimatedCostWeightedSavingRatio > savings.estimatedSavingRatio);
});

test('a report can cost more than the review surface it replaces', () => {
  // 24 lines across three small files: the report (3.4 KB) was bigger than the
  // diff plus changed files (2.1 KB), so the phase loses on its own terms even
  // though the delegation as a whole is still net positive (it removes the
  // write side). This is the shape the minSurfaceBytes gate skips.
  const verification = { security: { diffBytes: 900, addedLines: 24, changedFiles: ['a.js'] } };
  const withReport = estimateParentSavings({ verification, selfReviewBytes: 3400, changedFileBytes: 1200 });
  const withoutReport = estimateParentSavings({ verification, selfReviewBytes: null, changedFileBytes: 1200 });
  assert.equal(withReport.delegated.reviewSurfaceBytes, 2100);
  assert.ok(withReport.delegated.deliveredBytes > withoutReport.delegated.deliveredBytes);
  assert.ok(withReport.estimatedTokensAvoided > 0, 'delegation still avoids the write');
  assert.ok(withReport.estimatedTokensAvoided < withoutReport.estimatedTokensAvoided, 'the report ate part of the saving');
});

test('without self-review the parent still avoids the write side', () => {
  const verification = { security: { diffBytes: 900, addedLines: 24, changedFiles: ['a.js'] } };
  const savings = estimateParentSavings({ verification, selfReviewBytes: null, changedFileBytes: 1200 });
  assert.equal(savings.delegated.mode, 'full-diff');
  assert.ok(savings.counterfactual.outputTokens > 0);
  assert.ok(savings.estimatedSavingRatio > 0);
});

function metricsConfig(overrides = {}) {
  return {
  profiles: { volcengine: { provider: 'volcengine-plan', model: 'ark-code-latest', monthlyPlan: { currency: 'CNY', amount: 40 } } },
  parentRateCard: {
  backend: 'codex', shape: 'cumulative', model: 'gpt-5.6-sol', effectiveDate: '2026-07-23', source: 'test',
  creditsPerMillion: { nonCachedInput: 100, cachedInput: 10, output: 1000 },
  },
  parentSubscription: { plan: 'plus', monthlyUsd: 20 },
  ...overrides,
  };
}

const state = { runId: 'run-1', profile: 'volcengine', provider: 'volcengine-plan', model: 'ark-code-latest', revisionRound: 0 };

test('a backend without its own rate card reports unavailable instead of borrowing the Codex card', () => {
  const metrics = buildMetrics({
  state,
  verification: { passed: true, security: { passed: true } },
  review: { findings: [] },
  config: metricsConfig(),
  parentDelta: { available: true, backend: 'claude-code', inputTokens: 1000, cachedInputTokens: 900_000, cacheWriteInputTokens: 0, outputTokens: 500, totalTokens: 1500 },
  piUsage: { inputTokens: 100, outputTokens: 50, requests: 1, durationMs: 10 },
  successfulTasksThisMonth: 1,
  });
  assert.equal(metrics.parent.actualCredits, null);
  assert.equal(metrics.parent.actualCreditsUnavailable, 'no-rate-card-for-backend');
  assert.equal(metrics.counterfactual.estimatedCreditSavingRate, null);
  assert.equal(metrics.counterfactual.estimatedDisplacedParentCredits, null);
});

test('a separate-shape card prices cache reads on their own line', () => {
  const config = metricsConfig({
  parentRateCards: {
  'claude-code': {
  backend: 'claude-code', shape: 'separate', model: 'opus-x', effectiveDate: '2026-10-01', source: 'test',
  creditsPerMillion: { nonCachedInput: 100, cachedInput: 1, output: 1000 },
  },
  },
  });
  const metrics = buildMetrics({
  state,
  verification: { passed: true, security: { passed: true } },
  review: { findings: [] },
  config,
  // Anthropic semantics: input_tokens excludes cache reads, cache writes are input.
  parentDelta: { available: true, backend: 'claude-code', inputTokens: 1000, cacheWriteInputTokens: 4000, cachedInputTokens: 995_000, outputTokens: 500, totalTokens: 5500 },
  piUsage: { inputTokens: 1000, outputTokens: 200, requests: 1, durationMs: 10 },
  successfulTasksThisMonth: 1,
  });
  // (1000 + 4000) * 100 + 995000 * 1 + 500 * 1000 = 0.5 + 0.995 + 0.5 = 1.995
  assert.ok(Math.abs(metrics.parent.actualCredits - 1.995) < 1e-9, String(metrics.parent.actualCredits));
  assert.equal(metrics.parent.rateCardResolvedFrom, 'parentRateCards.claude-code');
  const share = metrics.parent.cachedInputShare;
  assert.ok(share > 0.99, String(share));
});
