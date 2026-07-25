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
  return value === null ? '不可用' : `${(value * 100).toFixed(1)}%`;
}

function markdown(metrics, state, verificationEvidence) {
  const verification = metrics.quality.finalVerificationPassed ? '通过' : '未通过';
  const actual = metrics.parent.actualCredits === null ? '不可用' : metrics.parent.actualCredits.toFixed(4);
  const lastTransition = state.transitions?.at(-1);
  const security = state.security ?? verificationEvidence?.security;
  const securityCodes = [...new Set((security?.issues ?? []).map((issue) => issue.code).filter(Boolean))];
  const blockedReason = state.blockedReason ?? lastTransition?.reason ?? null;
  const failureMessage = state.failure?.message ?? null;
  const statusDetails = [];
  if (state.status === 'blocked' && blockedReason) statusDetails.push(`- 阻断原因：${blockedReason}`);
  if (securityCodes.length > 0) statusDetails.push(`- 安全问题：${securityCodes.join('、')}`);
  if (state.status === 'failed' && failureMessage) statusDetails.push(`- 失败原因：${failureMessage}`);
  return `# Pi Worker Run ${metrics.runId}

- 状态：${state.status}
${statusDetails.join('\n')}
- 端到端计量窗口：${metrics.elapsedMs} ms
- 执行模型：${metrics.pi.provider}/${metrics.pi.model}
- 独立验证：${verification}
- 主控端审阅返工：${metrics.quality.revisionRounds} 轮
- 实际主控端 credits：${actual}（含套餐用量，不等同现金）
- 主控端计量起点：${metrics.parent.measurementStartSource}
- Pi：${metrics.pi.usage.requests} 次调用，耗时 ${metrics.pi.usage.durationMs} ms；Token 输入 ${metrics.pi.usage.inputTokens}、缓存读取 ${metrics.pi.usage.cachedInputTokens}、输出 ${metrics.pi.usage.outputTokens}
- ChatGPT 网页生图：${metrics.visual.generations} 次（不计入 Pi 代码委派节省）
- 反事实估算节省率：${percent(metrics.counterfactual.estimatedCreditSavingRate)}（估算，不是 A/B 实验）
- 外部套餐摊销：${metrics.cash.providerCostPerSuccessfulTask.toFixed(2)} ${metrics.cash.providerPlan.currency}/成功任务
- 现金节省：0（仍在主控端套餐包含额度内时，外部套餐是新增成本）
- 实现提交：${state.implementationCommit ?? '无'}
- 来源集成提交：${state.integratedCommit ?? '无'}
- 远端：未推送远端

十任务窗口：样本 ${metrics.cohort.sampleSize}，中位估算节省率 ${percent(metrics.cohort.medianSavingRate)}，建议 ${metrics.cohort.recommendation}。
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
