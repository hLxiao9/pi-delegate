import { appendFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic } from './atomic-json.mjs';
import { loadConfig, resolveWorkerPaths, selectProfile } from './config.mjs';
import { assertDelegableCapabilities, validateReviewResult } from './contracts.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { runProcess } from './process.mjs';
import { resolveAdapter, resolveBin } from './adapters/index.mjs';
import { git } from './git-worker.mjs';
import { appendAuditLog } from './audit-log.mjs';
import { loadRun, transition, updateRun, withRunLock } from './state.mjs';

export function buildPiPrompt(task, mode, evidence = null, promptOverride = null) {
  if (promptOverride) return promptOverride;
  const safeTask = {
    schemaVersion: task.schemaVersion,
    runId: task.runId,
    goal: task.goal,
    allowedPaths: task.allowedPaths,
    forbiddenPaths: task.forbiddenPaths,
    constraints: task.constraints,
    acceptanceCriteria: task.acceptanceCriteria,
    requiredCapabilities: task.requiredCapabilities,
    risk: task.risk,
  };
  const common = [
    'You are an implementation worker. The parent agent owns architecture, review, verification, and commit approval.',
    'Work only inside the current directory. Never read or write an absolute path or a path containing .. .',
    'Modify only paths allowed by the contract. Do not access secrets, Git metadata, external services, or images.',
    'You do not have a shell. Do not claim that tests passed; the parent wrapper runs every verification command independently.',
    'Keep the change minimal and finish by summarizing files changed and any uncertainty.',
    `TASK CONTRACT:\n${JSON.stringify(safeTask, null, 2)}`,
  ];
  if (mode === 'revise') common.push(`MANDATORY REVISION EVIDENCE:\n${JSON.stringify(evidence, null, 2)}`);
  return common.join('\n\n');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 通过 adapter 调用 CLI worker。统一入口,内部根据 adapter 分发到 pi/kimi/trae。
async function invokeWorker({ paths, files, state, profile, env, prompt, config, attempt, phase }) {
  const adapter = resolveAdapter(profile);
  const bin = resolveBin(adapter, env);

  // adapter 专有的 home 隔离 + env 准备
  const { home: workerHome, env: workerEnv } = await adapter.sanitizeHome({ paths, files, profile, env });

  const sessionDir = path.join(files.directory, `${adapter.name}-session`);
  await mkdir(sessionDir, { recursive: true });

  appendFileSync(files.events, `${JSON.stringify({ type: 'worker_attempt', phase, attempt, adapter: adapter.name, profile: profile.name, provider: profile.provider, model: profile.model, at: new Date().toISOString() })}\n`, { mode: 0o600 });

  // adapter 构造命令行参数
  const { argv, input, cwd } = adapter.invokeCommand({
    state, profile, prompt, config, sessionDir, mode: phase,
  });

  let lastAssistant = null;
  let invalidJsonLines = 0;
  let rawStdout = '';
  let rawStderr = '';

  if (adapter.supportsStreaming) {
    // Pi 风格:NDJSON 流,逐行解析
    const result = await runProcess(bin, argv, {
      cwd: cwd ?? state.worktreePath,
      env: workerEnv,
      input,
      timeoutMs: config.limits.piTimeoutSeconds * 1000,
      maxCaptureChars: config.limits.maxCapturedCharsPerStream,
      onStdoutLine(line) {
        rawStdout += line + '\n';
        if (line.length === 0) return;
        appendFileSync(files.events, `${line}\n`, { mode: 0o600 });
        try {
          const event = JSON.parse(line);
          if (event.type === 'message_end' && event.message?.role === 'assistant') lastAssistant = event.message;
        } catch {
          invalidJsonLines += 1;
        }
      },
    });
    rawStderr = result.stderr;
    return finalizeInvoke({ adapter, result, lastAssistant, rawStdout, rawStderr, invalidJsonLines, attempt, phase, profile, files });
  }

  // Kimi/Trae 风格:一次性文本输出,用 parseOutput 解析
  const result = await runProcess(bin, argv, {
    cwd: cwd ?? state.worktreePath,
    env: workerEnv,
    input,
    timeoutMs: config.limits.piTimeoutSeconds * 1000,
    maxCaptureChars: config.limits.maxCapturedCharsPerStream,
  });
  rawStdout = result.stdout;
  rawStderr = result.stderr;
  const parsed = adapter.parseOutput(rawStdout, rawStderr, result.code, result.timedOut);
  lastAssistant = parsed.lastAssistant ?? { content: parsed.text };

  return finalizeInvoke({ adapter, result, lastAssistant, rawStdout, rawStderr, invalidJsonLines: 0, attempt, phase, profile, parsedUsage: parsed.usage, files });
}


// 将 Pi 原始 usage 对象(input/output/cacheRead 等字段)归一化为 metrics 期望的 schema
// (inputTokens/outputTokens/cachedInputTokens 等)。流式和非流式路径共用。
function normalizeUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  return {
    inputTokens: rawUsage.input ?? 0,
    cachedInputTokens: rawUsage.cacheRead ?? 0,
    cacheWriteInputTokens: rawUsage.cacheWrite ?? 0,
    outputTokens: rawUsage.output ?? 0,
    reasoningOutputTokens: rawUsage.reasoning ?? 0,
    totalTokens: rawUsage.totalTokens ?? 0,
    providerReportedCostUsd: rawUsage.cost?.total ?? 0,
    requests: 1,
    durationMs: 0,
  };
}

// 统一整理 invoke 结果,生成 ok/failure 判定
function finalizeInvoke({ adapter, result, lastAssistant, rawStdout, rawStderr, invalidJsonLines, attempt, phase, profile, parsedUsage, files }) {
  const ok = invalidJsonLines === 0 && result.code === 0 && !result.timedOut && !result.interrupted && lastAssistant?.stopReason !== 'error' && lastAssistant?.stopReason !== 'aborted';
  const failure = ok ? null : (result.interrupted ? 'interrupted' : (invalidJsonLines > 0 ? 'permanent' : adapter.classifyFailure({ stderr: rawStderr, stdout: rawStdout, exitCode: result.code, timedOut: result.timedOut })));
  appendFileSync(files.events, `${JSON.stringify({
    type: 'worker_attempt_end', phase, attempt, adapter: adapter.name, profile: profile.name, provider: profile.provider, model: profile.model,
    code: result.code, timedOut: result.timedOut, interrupted: result.interrupted, interruptionReason: result.interruptionReason, durationMs: result.durationMs, ok, failure, at: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  // usage:Pi 流式从 lastAssistant.usage 取(需归一化);Kimi/Trae 从 parsedUsage 取(已归一化,可能为 null)
  const rawUsage = lastAssistant?.usage ?? null;
  const usage = rawUsage ? normalizeUsage(rawUsage) : (parsedUsage ?? null);
  return { ok, result, lastAssistant, failure, invalidJsonLines, usage, adapter: adapter.name };
}

export async function runPiTurn({ paths, files, state, task, config, env, mode, evidence = null, promptOverride = null, expectJsonOutput = false }) {
  let profile = selectProfile(config, state.profile);
  const adapter = resolveAdapter(profile);
  // self-review mode 不写文件、不执行代码,只是让 worker 用 read/grep 读自己的 diff。
  // 这种情况下 vision-input/image-output 不需要,跳过 capability 强校验。
  if (mode !== 'self-review') {
    assertDelegableCapabilities(task, profile);
  }
  // 凭证检查:Trae 用 OAuth 跳过;Pi/Kimi/Qoder 检查 env 变量
  // Qoder 默认 apiKeyEnv=QODERCN_PERSONAL_ACCESS_TOKEN,可在 profile 里覆盖
  if (adapter.name !== 'trae' && !env[profile.apiKeyEnv]) {
    throw new WorkerError('PI_FAILED', `Missing provider credential: ${profile.apiKeyEnv}`, { category: 'auth' });
  }
  const prompt = buildPiPrompt(task, mode, evidence, promptOverride);
  let finalAttempt;
  for (let attempt = 0; attempt <= config.retryDelaysMs.length; attempt += 1) {
    finalAttempt = await invokeWorker({ paths, files, state, profile, env, prompt, config, attempt: attempt + 1, phase: mode });
    if (finalAttempt.ok) return { ...finalAttempt, profile, fallbackUsed: false };
    if (finalAttempt.failure === 'auth' || finalAttempt.failure === 'permanent' || finalAttempt.failure === 'timeout' || finalAttempt.failure === 'interrupted') break;
    if (attempt < config.retryDelaysMs.length) await sleep(config.retryDelaysMs[attempt]);
  }
  if (finalAttempt.failure === 'transient' && profile.fallbackProfiles.length === 1) {
    const fallback = selectProfile(config, profile.fallbackProfiles[0]);
    assertDelegableCapabilities(task, fallback);
    const fallbackAdapter = resolveAdapter(fallback);
    if (fallbackAdapter.name !== 'trae' && !env[fallback.apiKeyEnv]) throw new WorkerError('PI_FAILED', `Missing fallback credential: ${fallback.apiKeyEnv}`, { category: 'auth' });
    // (Qoder fallback 同样检查 QODERCN_PERSONAL_ACCESS_TOKEN)
    const fallbackAttempt = await invokeWorker({ paths, files, state, profile: fallback, env, prompt, config, attempt: 1, phase: `${mode}-fallback` });
    if (fallbackAttempt.ok) return { ...fallbackAttempt, profile: fallback, fallbackUsed: true };
    finalAttempt = fallbackAttempt;
  }
  const interrupted = finalAttempt.failure === 'interrupted';
  const timedOut = finalAttempt.failure === 'timeout';
  const failureCode = interrupted ? 'PI_INTERRUPTED' : timedOut ? 'PI_TIMEOUT' : 'PI_FAILED';
  throw new WorkerError(failureCode, `${adapter.name} implementation turn ${interrupted ? 'was interrupted' : timedOut ? 'timed out' : 'failed'}`, {
    category: finalAttempt.failure, exitCode: finalAttempt.result.code, timedOut: finalAttempt.result.timedOut,
    interrupted: finalAttempt.result.interrupted,
    interruptionReason: finalAttempt.result.interruptionReason,
  });
}

// 计算 worktree 当前 diff 的哈希,用于检测修订回合是否实际产生了变更。
// 比较修订前后的 diffHash,可以区分 "Pi 写了新代码" 和 "Pi 什么都没做"。
async function worktreeDiffHash(paths, state, env) {
  try {
    const result = await git(paths, state.worktreePath, ['diff', '--no-color'], { env, maxCaptureChars: 5_000_000, allowTruncated: true });
    // 同时记录未跟踪文件的状态(status --porcelain 可以捕获 untracked + modified)
    const statusResult = await git(paths, state.worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { env, allowTruncated: true });
    return createHash('sha256').update(result.stdout).update('\0').update(statusResult.stdout).digest('hex');
  } catch {
    return null;
  }
}

export async function runCommand(options = {}, runtime = {}) {
  invariant(options.id, 'CLI_USAGE', 'run requires --id', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  return withRunLock(paths, options.id, async () => {
    const loaded = await loadRun(paths, options.id);
    invariant(loaded.state.status === 'prepared', 'STATE_INVALID', `run requires prepared state, found ${loaded.state.status}`);
    const config = await loadConfig(paths);
    await updateRun(paths, options.id, (state) => transition(state, 'running'));
    try {
      const latest = await loadRun(paths, options.id);
      const result = await runPiTurn({ paths, files: latest.files, state: latest.state, task: latest.task, config, env, mode: 'run' });
      const updated = await updateRun(paths, options.id, (state) => transition(state, 'verifying', {
        profile: result.profile.name, provider: result.profile.provider, model: result.profile.model,
        fallbackUsed: result.fallbackUsed, lastPiDurationMs: result.result.durationMs,
      }));
      return { runId: options.id, status: updated.state.status, provider: updated.state.provider, model: updated.state.model, fallbackUsed: updated.state.fallbackUsed };
    } catch (error) {
      const category = error.details?.category;
      const target = category === 'auth' ? 'blocked' : 'failed';
      const interruption = ['interrupted', 'timeout'].includes(category)
        ? { interruptedAt: new Date().toISOString(), signal: error.details?.interruptionReason ?? null, reason: category, recoverableFrom: 'running' }
        : undefined;
      await updateRun(paths, options.id, (state) => transition(state, target, {
        failure: { code: error.code, message: error.message, details: error.details },
        ...(interruption ? { interruption } : {}),
      }, category));
      throw error;
    }
  });
}

export async function reviseCommand(options = {}, runtime = {}) {
  invariant(options.id && options.review, 'CLI_USAGE', 'revise requires --id and --review', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  return withRunLock(paths, options.id, async () => {
    let loaded = await loadRun(paths, options.id);
    // revise 也允许 selfReviewing 状态:主控可能跳过 self-review 直接决定 revise。
    if (loaded.state.status === 'selfReviewing') {
      await updateRun(paths, options.id, (state) => transition(state, 'reviewing', { selfReviewSkipped: true, selfReviewSkipReason: 'parent-skipped-revise' }));
      loaded = await loadRun(paths, options.id);
    }
    invariant(loaded.state.status === 'reviewing', 'STATE_INVALID', `revise requires reviewing state, found ${loaded.state.status}`);
    const config = await loadConfig(paths);
    if (loaded.state.revisionRound >= config.maxRevisionRounds) {
      await updateRun(paths, options.id, (state) => transition(state, 'failed', { failure: { code: 'REVISION_LIMIT', message: 'Maximum revision rounds reached' } }, 'revision limit'));
      throw new WorkerError('REVISION_LIMIT', `Maximum revision rounds reached: ${config.maxRevisionRounds}`);
    }
    const review = validateReviewResult(JSON.parse(await readFile(path.resolve(options.review), 'utf8')));
    invariant(review.verdict === 'revise', 'REVIEW_INVALID', 'revise requires verdict=revise');
    const verification = await readJson(loaded.files.verification);
    invariant(review.diffSha256 === verification.security?.diffSha256, 'DIFF_CHANGED', 'Parent review does not match the independently verified worker diff');
    const round = loaded.state.revisionRound + 1;
    const reviewDirectory = path.join(loaded.files.directory, 'reviews');
    await ensureDir(reviewDirectory);
    await writeJsonAtomic(path.join(reviewDirectory, `revision-${round}.json`), review);
    await writeJsonAtomic(loaded.files.review, review);
    await updateRun(paths, options.id, (state) => transition(state, 'revising', { revisionRound: round }));
    // 修订前记录 worktree diff 哈希,用于收尾时判断 Pi 是否实际产出了变更。
    // 声明在 try 外,使 catch 块也能访问(用于误判失败时的恢复判断)。
    let diffHashBefore = null;
    try {
      // 关键修复:使用 latest.files/latest.state 而非 loaded,确保读到 transition 后的最新状态。
      // 之前的 bug:loaded 是 transition 前的快照,files 变量流程错误导致 run 标 failed。
      const latest = await loadRun(paths, options.id);
      diffHashBefore = await worktreeDiffHash(paths, latest.state, env);
      const result = await runPiTurn({ paths, files: latest.files, state: latest.state, task: latest.task, config, env, mode: 'revise', evidence: { review, verification } });
      const updated = await updateRun(paths, options.id, (state) => transition(state, 'verifying', {
        profile: result.profile.name,
        provider: result.profile.provider,
        model: result.profile.model,
        fallbackUsed: state.fallbackUsed || result.fallbackUsed,
        lastPiDurationMs: result.result.durationMs,
      }));
      return { runId: options.id, status: updated.state.status, revisionRound: updated.state.revisionRound };
    } catch (error) {
      // 修订回合收尾恢复:若 runPiTurn 误判失败(exit code/invalidJsonLines/stopReason)
      // 但 worker 实际在 worktree 产出了新变更(diffHash 变化),转 verifying 让主控独立验证。
      // 这解决了 Codex 报告的 bug:Pi 修订代码已落地 worktree,测试通过,但 worker 收尾误标 failed。
      const isPiFailure = ['PI_FAILED', 'PI_INTERRUPTED', 'PI_TIMEOUT'].includes(error.code) && error.details?.category !== 'auth';
      if (isPiFailure) {
        const latestState = await loadRun(paths, options.id);
        const diffHashAfter = await worktreeDiffHash(paths, latestState.state, env);
        // diffHashBefore !== diffHashAfter 说明 Pi 在修订回合中实际修改了文件
        if (diffHashBefore && diffHashAfter && diffHashBefore !== diffHashAfter) {
          appendAuditLog(paths, {
            command: 'revise',
            runId: options.id,
            phase: 'recovery',
            message: 'runPiTurn reported failure but worktree diff changed; transitioning to verifying for independent parent verification',
            error: { code: error.code, message: error.message, category: error.details?.category },
            diffHashBefore,
            diffHashAfter,
          });
          const updated = await updateRun(paths, options.id, (state) => transition(state, 'verifying', {
            revisionRecovery: {
              recoveredAt: new Date().toISOString(),
              reason: 'worker turn reported failure but worktree diff changed',
              originalError: { code: error.code, message: error.message, category: error.details?.category },
            },
          }, 'revision recovery'));
          return { runId: options.id, status: updated.state.status, revisionRound: updated.state.revisionRound, recovered: true };
        }
      }
      const target = error.details?.category === 'auth' ? 'blocked' : 'failed';
      const interruption = ['interrupted', 'timeout'].includes(error.details?.category)
        ? { interruptedAt: new Date().toISOString(), signal: error.details?.interruptionReason ?? null, reason: error.details?.category, recoverableFrom: 'revising' }
        : undefined;
      await updateRun(paths, options.id, (state) => transition(state, target, {
        failure: { code: error.code, message: error.message, details: error.details },
        ...(interruption ? { interruption } : {}),
      }, error.details?.category));
      throw error;
    }
  });
}
