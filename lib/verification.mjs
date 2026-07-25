import { loadConfig, resolveWorkerPaths } from './config.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { runProcess } from './process.mjs';
import { scanWorkerDelta } from './security.mjs';
import { loadRun, transition, updateRun, withRunLock } from './state.mjs';
import { writeJsonAtomic } from './atomic-json.mjs';

function verificationEnvironment(env, commandEnv, allowlist) {
  const selected = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) if (env[name]) selected[name] = env[name];
  for (const [name, value] of Object.entries(commandEnv)) {
    invariant(allowlist.includes(name), 'CONTRACT_INVALID', `Verification env is not allowed: ${name}`);
    selected[name] = value;
  }
  return selected;
}

export async function executeVerification({ specifications, cwd, env, config }) {
  const commands = [];
  for (const specification of specifications) {
    const [command, ...argv] = specification.argv;
    const result = await runProcess(command, argv, {
      cwd,
      env: verificationEnvironment(env, specification.env, config.verificationEnvAllowlist),
      timeoutMs: specification.timeoutSeconds * 1000,
      maxCaptureChars: config.limits.maxCapturedCharsPerStream,
    });
    commands.push({
      argv: specification.argv,
      timeoutSeconds: specification.timeoutSeconds,
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      passed: result.code === 0 && !result.timedOut && !result.stdoutTruncated && !result.stderrTruncated,
    });
  }
  return commands;
}

export async function verifyCommand(options = {}, runtime = {}) {
  invariant(options.id, 'CLI_USAGE', 'verify requires --id', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  return withRunLock(paths, options.id, async () => {
    const loaded = await loadRun(paths, options.id);
    invariant(loaded.state.status === 'verifying', 'STATE_INVALID', `verify requires verifying state, found ${loaded.state.status}`);
    const config = await loadConfig(paths);
    const security = await scanWorkerDelta({ paths, state: loaded.state, task: loaded.task, config, env });
    if (!security.passed) {
      const evidence = { schemaVersion: 1, runId: options.id, passed: false, security, commands: [], at: new Date().toISOString() };
      await writeJsonAtomic(loaded.files.verification, evidence);
      await updateRun(paths, options.id, (state) => transition(state, 'blocked', { security }, 'security guardrail'));
      throw new WorkerError('SECURITY_BLOCKED', 'Worker diff failed security guardrails', { issues: security.issues });
    }
    const commands = await executeVerification({
      specifications: loaded.task.verification,
      cwd: loaded.state.worktreePath,
      env,
      config,
    });
    const passed = commands.every((command) => command.passed);
    const outputTruncated = commands.some((command) => command.stdoutTruncated || command.stderrTruncated);
    const evidence = { schemaVersion: 1, runId: options.id, passed, security, commands, outputTruncated, at: new Date().toISOString() };
    await writeJsonAtomic(loaded.files.verification, evidence);
    if (outputTruncated) {
      await updateRun(paths, options.id, (state) => transition(state, 'blocked', { failure: { code: 'VERIFICATION_OUTPUT_TRUNCATED', message: 'Verification output exceeded the safe capture limit' } }, 'verification output truncated'));
      throw new WorkerError('VERIFICATION_OUTPUT_TRUNCATED', 'Verification output exceeded the safe capture limit');
    }
    // verify 通过后:若 selfReview 配置启用,转到 self-reviewing 让主控决定是否调用 self-review;
    // 否则直接 reviewing。self-review 命令在 self-reviewing 状态下被调用,也可在 reviewing 状态下被跳过。
    const nextState = config.selfReview?.enabled ? 'selfReviewing' : 'reviewing';
    const updated = await updateRun(paths, options.id, (state) => transition(state, nextState, { lastVerificationPassed: passed }));
    return { runId: options.id, status: updated.state.status, passed, verificationFile: loaded.files.verification };
  });
}
