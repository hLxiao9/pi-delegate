import { readJson, writeJsonAtomic, writeTextAtomic } from './atomic-json.mjs';
import { snapshotCodexUsage, usageDelta } from './codex-usage.mjs';
import { loadConfig, resolveWorkerPaths } from './config.mjs';
import { invariant } from './errors.mjs';
import { buildCohort, buildMetrics, countSuccessfulTasksThisMonth, readPiUsage } from './metrics.mjs';
import { loadRun, updateRun, withRunLock } from './state.mjs';

async function optionalJson(file) {
  try { return await readJson(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function percent(value) {
  return value === null ? '不可用' : `${(value * 100).toFixed(1)}%`;
}

function markdown(metrics, state) {
  const verification = metrics.quality.finalVerificationPassed ? '通过' : '未通过';
  const actual = metrics.codex.actualCredits === null ? '不可用' : metrics.codex.actualCredits.toFixed(4);
  return `# Pi Worker Run ${metrics.runId}

- 状态：${state.status}
- 端到端计量窗口：${metrics.elapsedMs} ms
- 执行模型：${metrics.pi.provider}/${metrics.pi.model}
- 独立验证：${verification}
- Sol 审阅返工：${metrics.quality.revisionRounds} 轮
- 实际 Codex credits：${actual}（Plus 包含用量，不等同现金）
- Codex 计量起点：${metrics.codex.measurementStartSource}
- Pi：${metrics.pi.usage.requests} 次调用，耗时 ${metrics.pi.usage.durationMs} ms；Token 输入 ${metrics.pi.usage.inputTokens}、缓存读取 ${metrics.pi.usage.cachedInputTokens}、输出 ${metrics.pi.usage.outputTokens}
- ChatGPT 网页生图：${metrics.visual.generations} 次（不计入 Pi 代码委派节省）
- 反事实估算节省率：${percent(metrics.counterfactual.estimatedCreditSavingRate)}（估算，不是 A/B 实验）
- 外部套餐摊销：${metrics.cash.providerCostPerSuccessfulTask.toFixed(2)} ${metrics.cash.providerPlan.currency}/成功任务
- 现金节省：0（仍在 Plus 包含额度内时，外部套餐是新增成本）
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
    const codexEnd = await snapshotCodexUsage({ home: env.HOME, threadId: env.CODEX_THREAD_ID });
    const codexDelta = usageDelta(loaded.state.codexUsageStart, codexEnd);
    const piUsage = await readPiUsage(loaded.files.events);
    const verification = await optionalJson(loaded.files.verification);
    const review = await optionalJson(loaded.files.review);
    const successfulTasksThisMonth = await countSuccessfulTasksThisMonth(paths);
    const reportState = { ...loaded.state, chatgptImageGenerations };
    let metrics = buildMetrics({ state: reportState, verification, review, config, codexDelta, piUsage, successfulTasksThisMonth });
    await writeJsonAtomic(loaded.files.metrics, metrics);
    metrics = { ...metrics, cohort: await buildCohort(paths) };
    await writeJsonAtomic(loaded.files.metrics, metrics);
    await writeTextAtomic(loaded.files.report, markdown(metrics, reportState));
    const lastReportAt = new Date().toISOString();
    await updateRun(paths, options.id, (state) => ({ ...state, chatgptImageGenerations, lastReportAt, updatedAt: lastReportAt }));
    return { runId: options.id, status: loaded.state.status, metricsFile: loaded.files.metrics, reportFile: loaded.files.report, cohort: metrics.cohort };
  });
}
