/*
 * spotworkers - Delegate bounded coding tasks to cheap agent workers
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { readJson } from './atomic-json.mjs';

export function priceAtRateCard(usage, rates, shape) {
  const nonCachedInputTokens = shape === 'pi-separated'
    ? (usage.inputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0)
    : Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0));
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const credits = (
    nonCachedInputTokens * rates.nonCachedInput
    + cachedInputTokens * rates.cachedInput
    + outputTokens * rates.output
  ) / 1_000_000;
  return { nonCachedInputTokens, cachedInputTokens, outputTokens, credits };
}

export const priceAtSolRate = priceAtRateCard;

export async function readPiUsage(eventsFile) {
  // totalCredits: provider-native billing unit for CLI backends that do not
  // report token counts (Qoder CN reports usage.*_tokens as 0 and only fills
  // total_credits). Kept separate from providerReportedCostUsd so a credit is
  // never silently presented as a dollar amount.
  const totals = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, providerReportedCostUsd: 0, totalCredits: 0, requests: 0, durationMs: 0 };
  try {
    const lines = readline.createInterface({ input: createReadStream(eventsFile, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'worker_attempt') { totals.requests += 1; continue; }
        if (event.type === 'worker_attempt_end') { totals.durationMs += event.durationMs ?? 0; continue; }
        if (event.type !== 'message_end' || event.message?.role !== 'assistant' || !event.message.usage) continue;
        const usage = event.message.usage;
        totals.inputTokens += usage.input ?? 0;
        totals.cachedInputTokens += usage.cacheRead ?? 0;
        totals.cacheWriteInputTokens += usage.cacheWrite ?? 0;
        totals.outputTokens += usage.output ?? 0;
        totals.reasoningOutputTokens += usage.reasoning ?? 0;
        totals.totalTokens += usage.totalTokens ?? 0;
        totals.providerReportedCostUsd += usage.cost?.total ?? 0;
        totals.totalCredits += usage.credits ?? 0;
      } catch {}
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return totals;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export async function countSuccessfulTasksThisMonth(paths, now = new Date()) {
  const runsRoot = path.join(paths.stateRoot, 'runs');
  let entries = [];
  try { entries = await readdir(runsRoot, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const state = await readJson(path.join(runsRoot, entry.name, 'state.json'));
      const created = new Date(state.createdAt);
      if (state.implementationCommit && created.getFullYear() === now.getFullYear() && created.getMonth() === now.getMonth()) count += 1;
    } catch {}
  }
  return Math.max(1, count);
}

function resolveRateCard(config) {
  return config.parentRateCard ?? config.codexRateCard;
}

function resolveSubscription(config) {
  return config.parentSubscription ?? config.codexSubscription;
}

// Rate cards are per parent backend. `parentRateCard` historically shipped an
// OpenAI Codex card, so reusing it for a Claude Code session produced a number
// that looked precise and was meaningless. When no card exists for the active
// backend, report "unavailable" instead of borrowing a foreign price list.
function resolveRateCardForBackend(config, backend) {
  const cards = config.parentRateCards ?? {};
  if (backend && cards[backend]) return { card: cards[backend], source: `parentRateCards.${backend}` };
  const fallback = resolveRateCard(config);
  if (!fallback) return { card: null, source: null };
  const declared = fallback.backend ?? 'codex';
  if (backend && backend !== declared) return { card: null, source: null, mismatch: { backend, cardBackend: declared } };
  return { card: fallback, source: 'parentRateCard' };
}

// Claude Code reports input_tokens exclusive of cache reads, so non-cached
// input is input + cache-write and cache reads are priced separately. Codex
// rollout usage reports input inclusive of cache reads, so they are subtracted.
function usageShape(card, backend) {
  if (card.shape === 'separate') return 'pi-separated';
  if (card.shape === 'cumulative') return 'codex-cumulative';
  return backend === 'claude-code' ? 'pi-separated' : 'codex-cumulative';
}

// The metric that matters is what the *main* model avoided spending, because
// the worker side is either free, discounted, or an order of magnitude cheaper
// per token. Everything here is derived from run artifacts so it can be
// re-checked later:
//
//   delegated      what the parent actually had to ingest — the self-review
//                  report when one exists, otherwise the full review surface.
//   counterfactual what the parent would have read and written to do the task
//                  itself, including one verification/fix cycle.
//
// The counterfactual is an estimate, not an A/B measurement, and it is
// deliberately conservative: it excludes the contract-writing context the
// parent already paid for, and it does not count the tool-call round trips a
// parent makes while editing (each of which re-sends the conversation).
const CHARS_PER_TOKEN = 3.6;
const BYTES_PER_CODE_LINE = 45;
const DIRECT_WORK_CYCLES = 1.5;
// Output tokens cost roughly 4-5x input tokens on every frontier model, and
// writing the change is what delegation removes entirely. Pricing the write
// side at the same rate as reading would understate the saving by the only
// factor that actually matters.
const OUTPUT_TOKEN_WEIGHT = 4;

export function estimateParentSavings({
  verification,
  selfReviewBytes = null,
  changedFileBytes = 0,
}) {
  const diffBytes = verification?.security?.diffBytes ?? 0;
  const addedLines = verification?.security?.addedLines ?? 0;
  const reviewSurfaceBytes = diffBytes + changedFileBytes;
  const deliveredBytes = selfReviewBytes !== null ? selfReviewBytes : reviewSurfaceBytes;
  const writeBytes = Math.round(addedLines * BYTES_PER_CODE_LINE);
  const directReadBytes = Math.round(reviewSurfaceBytes * DIRECT_WORK_CYCLES);
  const directWriteBytes = Math.round(writeBytes * DIRECT_WORK_CYCLES);

  const delegatedTokens = Math.round(deliveredBytes / CHARS_PER_TOKEN);
  const directInputTokens = Math.round(directReadBytes / CHARS_PER_TOKEN);
  const directOutputTokens = Math.round(directWriteBytes / CHARS_PER_TOKEN);
  const directTokens = directInputTokens + directOutputTokens;
  const avoidedTokens = Math.max(0, directTokens - delegatedTokens);
  const savingRatio = directTokens > 0 ? avoidedTokens / directTokens : null;
  // Output tokens are priced ~4x input on frontier models, so the token count
  // and the money equivalent are not the same number. Both are reported rather
  // than silently mixing them.
  const directWeightedTokens = directInputTokens + directOutputTokens * OUTPUT_TOKEN_WEIGHT;
  const avoidedWeightedTokens = Math.max(0, directWeightedTokens - delegatedTokens);
  const costWeightedSavingRatio = directWeightedTokens > 0 ? avoidedWeightedTokens / directWeightedTokens : null;

  return {
    basis: 'estimate-from-artifacts',
    // What the parent reads in delegation mode. verification.json is excluded:
    // the parent would read equivalent test output either way.
    delegated: {
      mode: selfReviewBytes !== null ? 'self-review' : 'full-diff',
      reviewSurfaceBytes,
      deliveredBytes,
      estimatedTokens: delegatedTokens,
    },
    // What the parent would spend doing the same change itself.
    counterfactual: {
      readBytes: directReadBytes,
      writeBytes: directWriteBytes,
      cycles: DIRECT_WORK_CYCLES,
      bytesPerCodeLine: BYTES_PER_CODE_LINE,
      outputTokenWeight: OUTPUT_TOKEN_WEIGHT,
      inputTokens: directInputTokens,
      outputTokens: directOutputTokens,
      estimatedTokens: directTokens,
      estimatedCostWeightedTokens: directWeightedTokens,
      excludes: ['contract-authoring context', 'tool-call round trips', 'reasoning tokens'],
    },
    estimatedTokensAvoided: avoidedTokens,
    estimatedSavingRatio: savingRatio,
    estimatedCostWeightedSavingRatio: costWeightedSavingRatio,
  };
}

export function buildMetrics({ state, verification, review, config, parentDelta, piUsage, successfulTasksThisMonth, piBalance = null, reviewSurface = {} }) {
  const subscription = resolveSubscription(config);
  const delta = parentDelta;
  const backend = delta?.backend ?? null;
  const { card: rateCard, source: rateCardSource, mismatch } = resolveRateCardForBackend(config, backend);
  const rates = rateCard?.creditsPerMillion ?? null;
  const actual = delta?.available && rates ? priceAtRateCard(delta, rates, usageShape(rateCard, backend)) : null;
  // The displaced side is always priced in the worker's own token shape.
  const displaced = rates ? priceAtRateCard(piUsage, rates, 'pi-separated') : null;
  const estimatedNoDelegationCredits = actual && displaced ? actual.credits + displaced.credits : null;
  const estimatedCreditSavingRate = estimatedNoDelegationCredits && estimatedNoDelegationCredits > 0 ? displaced.credits / estimatedNoDelegationCredits : null;
  const profile = config.profiles[state.profile] ?? { monthlyPlan: { currency: 'USD', amount: 0 } };
  const generatedAt = new Date().toISOString();
  const usageStart = state.parentUsageStart ?? state.codexUsageStart;
  const elapsedMs = usageStart?.at ? Math.max(0, new Date(generatedAt).getTime() - new Date(usageStart.at).getTime()) : null;
  const measurementStartSource = state.parentUsageStartSource ?? state.codexUsageStartSource;
  const parentSavings = estimateParentSavings({
  verification,
  selfReviewBytes: reviewSurface.selfReviewBytes ?? null,
  changedFileBytes: reviewSurface.changedFileBytes ?? 0,
  });
  return {
    schemaVersion: 1, runId: state.runId, generatedAt, elapsedMs,
    quality: { finalVerificationPassed: verification?.passed ?? false, securityPassed: verification?.security?.passed ?? false, unresolvedBlockingFindings: (review?.findings ?? []).filter((finding) => ['P0', 'P1', 'P2'].includes(finding.priority)).length, revisionRounds: state.revisionRound, fallbackUsed: state.fallbackUsed, committed: Boolean(state.implementationCommit), integrated: Boolean(state.integratedCommit) },
    // Primary metric: main-model tokens the delegation avoided.
    parentSavings,
    parent: {
      model: rateCard?.model ?? null,
      backend: backend ?? rateCard?.backend ?? null,
      rateCardEffectiveDate: rateCard?.effectiveDate ?? null,
      rateCardSource: rateCard?.source ?? null,
      rateCardResolvedFrom: rateCardSource,
      rateCardMismatch: mismatch ?? null,
      measurementStartSource,
      usage: delta,
      actualCredits: actual?.credits ?? null,
      actualCreditsUnavailable: actual ? null : (delta?.available ? 'no-rate-card-for-backend' : (delta?.reason ?? 'parent usage unavailable')),
      cachedInputShare: delta?.available && (delta.inputTokens ?? 0) + (delta.cachedInputTokens ?? 0) > 0
        ? (delta.cachedInputTokens ?? 0) / ((delta.inputTokens ?? 0) + (delta.cachedInputTokens ?? 0))
        : null,
      includedPlanUsageNotCash: true,
    },
    pi: { provider: state.provider, model: state.model, usage: piUsage, balance: piBalance },
    visual: { route: 'chatgpt-web', generations: state.chatgptImageGenerations ?? 0, delegatedToPi: false, excludedFromCodeSavings: true },
    counterfactual: {
      label: 'estimate-not-ab-test',
      estimatedDisplacedParentCredits: displaced?.credits ?? null,
      estimatedDisplacedSolCredits: displaced?.credits ?? null,
      estimatedNoDelegationCredits,
      estimatedCreditSavingRate,
      estimatedEquivalentCredits: displaced?.credits ?? null,
      subscriptionAllowance: subscription.weeklyAllowanceCredits ? 'weekly' : null,
      subscriptionAllowanceCredits: subscription.weeklyAllowanceCredits ?? null,
      subscriptionAllowanceSource: subscription.weeklyAllowanceSource ?? null,
      estimatedSubscriptionPortion: subscription.weeklyAllowanceCredits && subscription.weeklyAllowanceCredits > 0 && displaced
        ? displaced.credits / subscription.weeklyAllowanceCredits
        : null,
    },
    cash: { parentPlusMonthlyUsd: subscription.monthlyUsd, codexPlusMonthlyUsd: subscription.monthlyUsd, providerPlan: profile.monthlyPlan, successfulTasksThisMonth, providerCostPerSuccessfulTask: profile.monthlyPlan.amount / successfulTasksThisMonth, cashSavingsAmount: 0, note: 'Within included parent-agent plan usage, delegation does not reduce cash spend; the provider plan is additional cost unless it avoids purchased credits or a higher subscription.' },
  };
}

export async function buildCohort(paths) {
  const runsRoot = path.join(paths.stateRoot, 'runs');
  let entries = [];
  try { entries = await readdir(runsRoot, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const metrics = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try { metrics.push(await readJson(path.join(runsRoot, entry.name, 'metrics.json'))); } catch {}
  }
  metrics.sort((left, right) => left.generatedAt.localeCompare(right.generatedAt));
  const recent = metrics.slice(-10);
  // Token savings are measurable on every run; the credit-based rate is only
  // available when the parent backend has a rate card, which made the cohort
  // useless for most callers.
  const savings = recent.map((item) => item.parentSavings?.estimatedSavingRatio ?? item.counterfactual?.estimatedCreditSavingRate).filter((v) => v !== null && Number.isFinite(v));
  const revisions = recent.map((item) => item.quality?.revisionRounds).filter((v) => v !== null && Number.isFinite(v));
  const medianSavingRate = median(savings);
  const committedCount = recent.filter((item) => item.quality?.committed).length;
  const committedVerificationPassRate = committedCount === 0 ? null : recent.filter((item) => item.quality?.committed && item.quality?.finalVerificationPassed).length / committedCount;
  const unresolvedBlockingFindings = recent.reduce((sum, item) => sum + (item.quality?.unresolvedBlockingFindings ?? 0), 0);
  const tokensAvoided = recent.reduce((sum, item) => sum + (item.parentSavings?.estimatedTokensAvoided ?? 0), 0);
  const hasUsageData = savings.length > 0;
  const recommendation = recent.length < 10 ? 'collect-more-data' : !hasUsageData ? 'no-usage-data-available' : medianSavingRate === null ? 'collect-more-data' : medianSavingRate < 0.3 ? 'disable-implicit-delegation' : medianSavingRate >= 0.5 ? 'target-met' : 'keep-explicit-and-tune';
  return { sampleSize: recent.length, committedVerificationPassRate, unresolvedBlockingFindings, medianSavingRate, medianRevisionRounds: median(revisions), estimatedTokensAvoided: tokensAvoided, recommendation };
}
