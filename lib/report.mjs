/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { readJson, writeJsonAtomic, writeTextAtomic } from './atomic-json.mjs';
import { snapshotParentUsage, usageDelta } from './parent-usage.mjs';
import { loadConfig, resolveWorkerPaths } from './config.mjs';
import { invariant } from './errors.mjs';
import { buildCohort, buildMetrics, countSuccessfulTasksThisMonth, readPiUsage } from './metrics.mjs';
import { fetchProviderBalance } from './provider-balance/index.mjs';
import { selectProfile } from './config.mjs';
import { loadRun, updateRun, withRunLock } from './state.mjs';

async function optionalJson(file) {
  try { return await readJson(file); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

function percent(value) {
  return value === null ? 'unavailable' : `${(value * 100).toFixed(1)}%`;
}

function markdown(metrics, state, verificationEvidence) {
  const verification = metrics.quality.finalVerificationPassed ? 'pass' : 'Fail';
  const actual = metrics.parent.actualCredits === null ? 'unavailable' : metrics.parent.actualCredits.toFixed(4);
  const lastTransition = state.transitions?.at(-1);
  const security = state.security ?? verificationEvidence?.security;
  const securityCodes = [...new Set((security?.issues ?? []).map((issue) => issue.code).filter(Boolean))];
  const blockedReason = state.blockedReason ?? lastTransition?.reason ?? null;
  const failureMessage = state.failure?.message ?? null;
  const statusDetails = [];
  if (state.status === 'blocked' && blockedReason) statusDetails.push(`- block reason: ${blockedReason}`);
  if (securityCodes.length > 0) statusDetails.push(`- security issue: ${securityCodes.join(', ')}`);
  if (state.status === 'failed' && failureMessage) statusDetails.push(`- Failure reason: ${failureMessage}`);
  return `# Pi Worker Run ${metrics.runId}

- status: ${state.status}
${statusDetails.join('\n')}
- End-to-end measurement window: ${metrics.elapsedMs} ms
- Execution model: ${metrics.pi.provider}/${metrics.pi.model}
- independent verification: ${verification}
- Parent-side review rework: ${metrics.quality.revisionRounds} round
- Actual parent-side credits: ${actual}(includes plan usage, not equivalent to cash)
- Parent-side measurement start: ${metrics.parent.measurementStartSource}
- Pi: ${metrics.pi.usage.requests} calls, duration ${metrics.pi.usage.durationMs} ms; Token input ${metrics.pi.usage.inputTokens}, cache read ${metrics.pi.usage.cachedInputTokens}, output ${metrics.pi.usage.outputTokens}
- ChatGPT web image generation: ${metrics.visual.generations} times(not counted toward Pi code delegation savings)
- Counterfactual estimated saving rate: ${percent(metrics.counterfactual.estimatedCreditSavingRate)}(estimate, not an A/B experiment)
- External plan amortization: ${metrics.cash.providerCostPerSuccessfulTask.toFixed(2)} ${metrics.cash.providerPlan.currency}/per successful task
- Cash savings: 0(while still within the parent plan included allowance, external plan is an additional cost)
- Implementation commit: ${state.implementationCommit ?? 'None'}
- Source integration commit: ${state.integratedCommit ?? 'None'}
- Remote: not pushed to remote

Ten-task window: sample ${metrics.cohort.sampleSize}, median estimated saving rate ${percent(metrics.cohort.medianSavingRate)}, recommendation ${metrics.cohort.recommendation}.
`;
}

export async function reportCommand(options = {}, runtime = {}) {
  invariant(options.id, 'CLI_USAGE', 'report requires --id', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  return withRunLock(paths, options.id, async () => {
  const loaded = await loadRun(paths, options.id);
  const imageCountText = options['chatgpt-image-generations'] ?? String(loaded.state.chatgptImageGenerations ?? 0);
  invariant(/^\d+$/.test(imageCountText), 'CLI_USAGE', '--chatgpt-image-generations must be a non-negative integer', {}, 2);
  const chatgptImageGenerations = Number(imageCountText);
  const config = await loadConfig(paths);
  const parentEnd = await snapshotParentUsage({ home: env.HOME, env });
  const usageStart = loaded.state.parentUsageStart ?? loaded.state.codexUsageStart;
  const parentDelta = usageDelta(usageStart, parentEnd);
  const piUsage = await readPiUsage(loaded.files.events);
  const verification = await optionalJson(loaded.files.verification);
  const review = await optionalJson(loaded.files.review);
  const successfulTasksThisMonth = await countSuccessfulTasksThisMonth(paths);
  const reportState = { ...loaded.state, chatgptImageGenerations };
  const profile = selectProfile(config, reportState.profile);
  const piBalance = await fetchProviderBalance({
  provider: profile.provider,
  adapterName: profile.balanceAdapter,
  apiKey: env[profile.apiKeyEnv],
  config: profile.balanceConfig ?? {},
  });
  let metrics = buildMetrics({ state: reportState, verification, review, config, parentDelta, piUsage, successfulTasksThisMonth, piBalance });
  await writeJsonAtomic(loaded.files.metrics, metrics);
  metrics = { ...metrics, cohort: await buildCohort(paths) };
  await writeJsonAtomic(loaded.files.metrics, metrics);
  await writeTextAtomic(loaded.files.report, markdown(metrics, reportState, verification));
  const lastReportAt = new Date().toISOString();
  await updateRun(paths, options.id, (state) => ({ ...state, chatgptImageGenerations, lastReportAt, updatedAt: lastReportAt }));
  return { runId: options.id, status: loaded.state.status, metricsFile: loaded.files.metrics, reportFile: loaded.files.report, cohort: metrics.cohort };
  });
}
