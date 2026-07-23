import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { readJson } from './atomic-json.mjs';

export function priceAtSolRate(usage, rates, shape) {
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

export async function readPiUsage(eventsFile) {
  const totals = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, providerReportedCostUsd: 0, requests: 0, durationMs: 0 };
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

export function buildMetrics({ state, verification, review, config, codexDelta, piUsage, successfulTasksThisMonth }) {
  const rates = config.codexRateCard.creditsPerMillion;
  const actual = codexDelta.available ? priceAtSolRate(codexDelta, rates, 'codex-cumulative') : null;
  const displaced = priceAtSolRate(piUsage, rates, 'pi-separated');
  const estimatedNoDelegationCredits = actual ? actual.credits + displaced.credits : null;
  const estimatedCreditSavingRate = estimatedNoDelegationCredits && estimatedNoDelegationCredits > 0 ? displaced.credits / estimatedNoDelegationCredits : null;
  const profile = config.profiles[state.profile];
  const generatedAt = new Date().toISOString();
  const elapsedMs = Math.max(0, new Date(generatedAt).getTime() - new Date(state.codexUsageStart.at).getTime());
  return {
    schemaVersion: 1, runId: state.runId, generatedAt, elapsedMs,
    quality: { finalVerificationPassed: verification?.passed ?? false, securityPassed: verification?.security?.passed ?? false, unresolvedBlockingFindings: (review?.findings ?? []).filter((finding) => ['P0', 'P1', 'P2'].includes(finding.priority)).length, revisionRounds: state.revisionRound, fallbackUsed: state.fallbackUsed, committed: Boolean(state.implementationCommit), integrated: Boolean(state.integratedCommit) },
    codex: { model: config.codexRateCard.model, rateCardEffectiveDate: config.codexRateCard.effectiveDate, rateCardSource: config.codexRateCard.source, measurementStartSource: state.codexUsageStartSource, usage: codexDelta, actualCredits: actual?.credits ?? null, includedPlanUsageNotCash: true },
    pi: { provider: state.provider, model: state.model, usage: piUsage },
    visual: { route: 'chatgpt-web', generations: state.chatgptImageGenerations ?? 0, delegatedToPi: false, excludedFromCodeSavings: true },
    counterfactual: { label: 'estimate-not-ab-test', estimatedDisplacedSolCredits: displaced.credits, estimatedNoDelegationCredits, estimatedCreditSavingRate },
    cash: { codexPlusMonthlyUsd: config.codexSubscription.monthlyUsd, providerPlan: profile.monthlyPlan, successfulTasksThisMonth, providerCostPerSuccessfulTask: profile.monthlyPlan.amount / successfulTasksThisMonth, cashSavingsAmount: 0, note: 'Within included Plus usage, delegation does not reduce cash spend; the provider plan is additional cost unless it avoids purchased credits or a higher subscription.' },
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
  const savings = recent.map((item) => item.counterfactual.estimatedCreditSavingRate).filter(Number.isFinite);
  const revisions = recent.map((item) => item.quality.revisionRounds).filter(Number.isFinite);
  const medianSavingRate = median(savings);
  return { sampleSize: recent.length, committedVerificationPassRate: recent.filter((item) => item.quality.committed).length === 0 ? null : recent.filter((item) => item.quality.committed && item.quality.finalVerificationPassed).length / recent.filter((item) => item.quality.committed).length, unresolvedBlockingFindings: recent.reduce((sum, item) => sum + item.quality.unresolvedBlockingFindings, 0), medianSavingRate, medianRevisionRounds: median(revisions), recommendation: recent.length < 10 ? 'collect-more-data' : medianSavingRate < 0.3 ? 'disable-implicit-delegation' : medianSavingRate >= 0.5 ? 'target-met' : 'keep-explicit-and-tune' };
}
