import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, readJson, writeJsonAtomic } from './atomic-json.mjs';
import { loadConfig, resolveWorkerPaths, selectProfile } from './config.mjs';
import { assertDelegableCapabilities, validateReviewResult } from './contracts.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { runProcess } from './process.mjs';
import { loadRun, transition, updateRun, withRunLock } from './state.mjs';

const PI_TOOLS = 'read,grep,find,ls,edit,write';
const PI_DISABLE_FLAGS = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve'];

export function buildPiPrompt(task, mode, evidence = null) {
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
    'You are an implementation worker. The Codex/Sol parent owns architecture, review, verification, and commit approval.',
    'Work only inside the current directory. Never read or write an absolute path or a path containing .. .',
    'Modify only paths allowed by the contract. Do not access secrets, Git metadata, external services, or images.',
    'You do not have a shell. Do not claim that tests passed; the parent wrapper runs every verification command independently.',
    'Keep the change minimal and finish by summarizing files changed and any uncertainty.',
    `TASK CONTRACT:\n${JSON.stringify(safeTask, null, 2)}`,
  ];
  if (mode === 'revise') common.push(`MANDATORY REVISION EVIDENCE:\n${JSON.stringify(evidence, null, 2)}`);
  return common.join('\n\n');
}

function selectedEnvironment(env, profile, piHome) {
  const passthrough = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  const selected = { HOME: piHome, CI: '1', NO_COLOR: '1' };
  for (const name of passthrough) if (env[name]) selected[name] = env[name];
  selected[profile.apiKeyEnv] = env[profile.apiKeyEnv];
  return selected;
}

async function createSanitizedPiHome(paths, files, profile) {
  const models = JSON.parse(await readFile(paths.modelsFile, 'utf8'));
  const provider = models.providers?.[profile.provider];
  invariant(provider, 'CONFIG_INVALID', `Provider missing from models.json: ${profile.provider}`);
  const expectedKeys = [`$${profile.apiKeyEnv}`, '${' + profile.apiKeyEnv + '}'];
  invariant(expectedKeys.includes(provider.apiKey), 'CONFIG_INVALID', 'Selected provider must resolve its key from the selected environment variable');
  const piHome = path.join(files.directory, 'pi-home');
  const agentDir = path.join(piHome, '.pi', 'agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, 'models.json'), `${JSON.stringify({ providers: { [profile.provider]: provider } }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(agentDir, 'settings.json'), '{"quietStartup":true}\n', { mode: 0o600 });
  return piHome;
}

export function classifyPiFailure(result, lastAssistant) {
  const text = `${result.stderr}\n${result.stdout}\n${lastAssistant?.errorMessage ?? ''}`.toLowerCase();
  if (result.timedOut) return 'timeout';
  if (/\b(401|403)\b|unauthori[sz]ed|invalid api.?key|authentication failed/.test(text)) return 'auth';
  if (/\b(408|409|425|429|500|502|503|504)\b|rate.?limit|econnreset|etimedout|temporar|overloaded|network/.test(text)) return 'transient';
  return 'permanent';
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function invokePi({ paths, files, state, profile, env, prompt, config, attempt, phase }) {
  const piHome = await createSanitizedPiHome(paths, files, profile);
  const sessionDir = path.join(files.directory, 'pi-session');
  await mkdir(sessionDir, { recursive: true });
  appendFileSync(files.events, `${JSON.stringify({ type: 'worker_attempt', phase, attempt, profile: profile.name, provider: profile.provider, model: profile.model, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  let lastAssistant = null;
  let invalidJsonLines = 0;
  const argv = [
    '--mode', 'json', '--provider', profile.provider, '--model', profile.model,
    '--thinking', profile.thinking ?? 'high', '--session-dir', sessionDir, '--session-id', state.runId,
    '--tools', PI_TOOLS, ...PI_DISABLE_FLAGS,
  ];
  const result = await runProcess(paths.piBin, argv, {
    cwd: state.worktreePath,
    env: selectedEnvironment(env, profile, piHome),
    input: prompt,
    timeoutMs: config.limits.piTimeoutSeconds * 1000,
    maxCaptureChars: config.limits.maxCapturedCharsPerStream,
    onStdoutLine(line) {
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
  const ok = invalidJsonLines === 0 && result.code === 0 && !result.timedOut && lastAssistant?.stopReason !== 'error' && lastAssistant?.stopReason !== 'aborted';
  const failure = ok ? null : invalidJsonLines > 0 ? 'permanent' : classifyPiFailure(result, lastAssistant);
  appendFileSync(files.events, `${JSON.stringify({
    type: 'worker_attempt_end', phase, attempt, profile: profile.name, provider: profile.provider, model: profile.model,
    code: result.code, timedOut: result.timedOut, durationMs: result.durationMs, ok, failure, at: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return { ok, result, lastAssistant, failure, invalidJsonLines };
}

export async function runPiTurn({ paths, files, state, task, config, env, mode, evidence = null }) {
  let profile = selectProfile(config, state.profile);
  assertDelegableCapabilities(task, profile);
  if (!env[profile.apiKeyEnv]) throw new WorkerError('PI_FAILED', `Missing provider credential: ${profile.apiKeyEnv}`, { category: 'auth' });
  const prompt = buildPiPrompt(task, mode, evidence);
  let finalAttempt;
  for (let attempt = 0; attempt <= config.retryDelaysMs.length; attempt += 1) {
    finalAttempt = await invokePi({ paths, files, state, profile, env, prompt, config, attempt: attempt + 1, phase: mode });
    if (finalAttempt.ok) return { ...finalAttempt, profile, fallbackUsed: false };
    if (finalAttempt.failure === 'auth' || finalAttempt.failure === 'permanent' || finalAttempt.failure === 'timeout') break;
    if (attempt < config.retryDelaysMs.length) await sleep(config.retryDelaysMs[attempt]);
  }
  if (finalAttempt.failure === 'transient' && profile.fallbackProfiles.length === 1) {
    const fallback = selectProfile(config, profile.fallbackProfiles[0]);
    assertDelegableCapabilities(task, fallback);
    if (!env[fallback.apiKeyEnv]) throw new WorkerError('PI_FAILED', `Missing fallback credential: ${fallback.apiKeyEnv}`, { category: 'auth' });
    const fallbackAttempt = await invokePi({ paths, files, state, profile: fallback, env, prompt, config, attempt: 1, phase: `${mode}-fallback` });
    if (fallbackAttempt.ok) return { ...fallbackAttempt, profile: fallback, fallbackUsed: true };
    finalAttempt = fallbackAttempt;
  }
  throw new WorkerError('PI_FAILED', 'Pi implementation turn failed', {
    category: finalAttempt.failure, exitCode: finalAttempt.result.code, timedOut: finalAttempt.result.timedOut,
  });
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
      await updateRun(paths, options.id, (state) => transition(state, target, { failure: { code: error.code, message: error.message, details: error.details } }, category));
      throw error;
    }
  });
}

export async function reviseCommand(options = {}, runtime = {}) {
  invariant(options.id && options.review, 'CLI_USAGE', 'revise requires --id and --review', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  return withRunLock(paths, options.id, async () => {
    const loaded = await loadRun(paths, options.id);
    invariant(loaded.state.status === 'reviewing', 'STATE_INVALID', `revise requires reviewing state, found ${loaded.state.status}`);
    const config = await loadConfig(paths);
    if (loaded.state.revisionRound >= config.maxRevisionRounds) {
      await updateRun(paths, options.id, (state) => transition(state, 'failed', { failure: { code: 'REVISION_LIMIT', message: 'Maximum revision rounds reached' } }, 'revision limit'));
      throw new WorkerError('REVISION_LIMIT', `Maximum revision rounds reached: ${config.maxRevisionRounds}`);
    }
    const review = validateReviewResult(JSON.parse(await readFile(path.resolve(options.review), 'utf8')));
    invariant(review.verdict === 'revise', 'REVIEW_INVALID', 'revise requires verdict=revise');
    const verification = await readJson(loaded.files.verification);
    invariant(review.diffSha256 === verification.security?.diffSha256, 'DIFF_CHANGED', 'Sol review does not match the independently verified worker diff');
    const round = loaded.state.revisionRound + 1;
    const reviewDirectory = path.join(loaded.files.directory, 'reviews');
    await ensureDir(reviewDirectory);
    await writeJsonAtomic(path.join(reviewDirectory, `revision-${round}.json`), review);
    await writeJsonAtomic(loaded.files.review, review);
    await updateRun(paths, options.id, (state) => transition(state, 'revising', { revisionRound: round }));
    try {
      const latest = await loadRun(paths, options.id);
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
      const target = error.details?.category === 'auth' ? 'blocked' : 'failed';
      await updateRun(paths, options.id, (state) => transition(state, target, { failure: { code: error.code, message: error.message, details: error.details } }, error.details?.category));
      throw error;
    }
  });
}
