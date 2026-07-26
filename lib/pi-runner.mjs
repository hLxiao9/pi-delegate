/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

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
import { findSimilarEnvVarNames, loadShellProfileEnv } from './shell-profile.mjs';

// Build the compact, parenthesized credential hint used by runPiTurn.
// Mirrors buildCredentialHint's decision tree but uses the shorter phrasing
// specified for PI_FAILED errors. The hint lives in the message field so that
// redactDiagnostic (which strips non-whitelisted details fields) cannot drop it.
async function buildPiRunnerCredentialMessage(apiKeyEnv, { home } = {}) {
  const profileEnv = await loadShellProfileEnv([apiKeyEnv], { home });
  if (Object.prototype.hasOwnProperty.call(profileEnv, apiKeyEnv)) {
    return `Missing provider credential: ${apiKeyEnv} (found in shell profile but not inherited by this process — start from a login shell or source your profile first)`;
  }
  const similar = await findSimilarEnvVarNames([apiKeyEnv], { home });
  if (similar[apiKeyEnv]) {
    return `Missing provider credential: ${apiKeyEnv} (found similar '${similar[apiKeyEnv]}' in shell profile — rename it to '${apiKeyEnv}')`;
  }
  return `Missing provider credential: ${apiKeyEnv} (add 'export ${apiKeyEnv}=YOUR_KEY' to your shell profile, then run 'pi-worker doctor')`;
}
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

// pass adapter call CLI worker.unified entry,internal based on adapter dispatches to pi/kimi/trae.
async function invokeWorker({ paths, files, state, profile, env, prompt, config, attempt, phase }) {
  const adapter = resolveAdapter(profile);
  const bin = resolveBin(adapter, env);

  // adapter proprietary home isolation + env prepare
  const { home: workerHome, env: workerEnv } = await adapter.sanitizeHome({ paths, files, profile, env });

  const sessionDir = path.join(files.directory, `${adapter.name}-session`);
  await mkdir(sessionDir, { recursive: true });

  appendFileSync(files.events, `${JSON.stringify({ type: 'worker_attempt', phase, attempt, adapter: adapter.name, profile: profile.name, provider: profile.provider, model: profile.model, at: new Date().toISOString() })}\n`, { mode: 0o600 });

  // adapter constructs command-line args
  const { argv, input, cwd } = adapter.invokeCommand({
  state, profile, prompt, config, sessionDir, mode: phase,
  });

  let lastAssistant = null;
  let invalidJsonLines = 0;
  let rawStdout = '';
  let rawStderr = '';

  if (adapter.supportsStreaming) {
  // Pi style:NDJSON stream,line-by-line parsing
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

  // Kimi/Trae style:one-shot text output,use parseOutput parse
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


// converts Pi raw usage object(input/output/cacheRead and other fields)normalized to metrics expected schema
// (inputTokens/outputTokens/cachedInputTokens etc.).shared by streaming and non-streaming paths.
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

// unified consolidation invoke result,generate ok/failure determination
function finalizeInvoke({ adapter, result, lastAssistant, rawStdout, rawStderr, invalidJsonLines, attempt, phase, profile, parsedUsage, files }) {
  const ok = invalidJsonLines === 0 && result.code === 0 && !result.timedOut && !result.interrupted && lastAssistant?.stopReason !== 'error' && lastAssistant?.stopReason !== 'aborted';
  const failure = ok ? null : (result.interrupted ? 'interrupted' : (invalidJsonLines > 0 ? 'permanent' : adapter.classifyFailure({ stderr: rawStderr, stdout: rawStdout, exitCode: result.code, timedOut: result.timedOut })));
  appendFileSync(files.events, `${JSON.stringify({
  type: 'worker_attempt_end', phase, attempt, adapter: adapter.name, profile: profile.name, provider: profile.provider, model: profile.model,
  code: result.code, timedOut: result.timedOut, interrupted: result.interrupted, interruptionReason: result.interruptionReason, durationMs: result.durationMs, ok, failure, at: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  // usage:Pi streaming from lastAssistant.usage take(needs normalization);Kimi/Trae from parsedUsage take(normalized,may be null)
  const rawUsage = lastAssistant?.usage ?? null;
  const usage = rawUsage ? normalizeUsage(rawUsage) : (parsedUsage ?? null);
  return { ok, result, lastAssistant, failure, invalidJsonLines, usage, adapter: adapter.name };
}

export async function runPiTurn({ paths, files, state, task, config, env, mode, evidence = null, promptOverride = null, expectJsonOutput = false }) {
  let profile = selectProfile(config, state.profile);
  const adapter = resolveAdapter(profile);
  // self-review mode does not write files, does not execute code,just lets worker use read/grep read its own diff.
  // in this case vision-input/image-output not needed,skip capability strong validation.
  if (mode !== 'self-review') {
  assertDelegableCapabilities(task, profile);
  }
  // credential check:Trae use OAuth skip;Pi/Kimi/Qoder check env variable.
  // Qoder default apiKeyEnv=QODERCN_PERSONAL_ACCESS_TOKEN,can in profile override in.
  // On missing process.env credential, fall back to the user's shell profile so a
  // non-login shell is not falsely flagged. The compact hint text is placed in the
  // WorkerError message field because redactDiagnostic strips non-whitelisted details.
  if (adapter.name !== 'trae' && !env[profile.apiKeyEnv]) {
  const message = await buildPiRunnerCredentialMessage(profile.apiKeyEnv, { home: env.HOME });
  throw new WorkerError('PI_FAILED', message, { category: 'auth' });
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
  if (fallbackAdapter.name !== 'trae' && !env[fallback.apiKeyEnv]) {
  const fallbackMessage = await buildPiRunnerCredentialMessage(fallback.apiKeyEnv, { home: env.HOME });
  throw new WorkerError('PI_FAILED', fallbackMessage, { category: 'auth' });
  }
  // (Qoder fallback same check QODERCN_PERSONAL_ACCESS_TOKEN)
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

// compute worktree current diff hash of,for detecting whether revision round actually produced changes.
// compare before/after revision diffHash,can distinguish "Pi wrote new code" and "Pi did nothing".
async function worktreeDiffHash(paths, state, env) {
  try {
  const result = await git(paths, state.worktreePath, ['diff', '--no-color'], { env, maxCaptureChars: 5_000_000, allowTruncated: true });
  // also records untracked file status(status --porcelain can capture untracked + modified)
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
  // revise also allows selfReviewing status:parent may skip self-review directly decide revise.
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
  // records before revision worktree diff hash,for judging at cleanup whether Pi actually produced changes.
  // declared in try outside,makes catch block can also access(for recovery judgment on misjudged failure).
  let diffHashBefore = null;
  try {
  // key fix:use latest.files/latest.state rather than loaded,ensures reading transition latest state after.
  // before bug:loaded is transition snapshot before,files variable flow error caused run marked failed.
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
  // revision round cleanup recovery:if runPiTurn misjudged failure(exit code/invalidJsonLines/stopReason)
  // but worker actually in worktree produced new changes(diffHash change),transition to verifying lets parent independently verify.
  // this solves Codex reported bug:Pi revision code has landed worktree,tests pass,but worker cleanup mislabeling failed.
  const isPiFailure = ['PI_FAILED', 'PI_INTERRUPTED', 'PI_TIMEOUT'].includes(error.code) && error.details?.category !== 'auth';
  if (isPiFailure) {
  const latestState = await loadRun(paths, options.id);
  const diffHashAfter = await worktreeDiffHash(paths, latestState.state, env);
  // diffHashBefore !== diffHashAfter explains Pi actually modified files in revision round
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
