/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

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
  interrupted: result.interrupted,
  interruptionReason: result.interruptionReason,
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
  const interrupted = commands.some((command) => command.interrupted);
  if (interrupted) {
  throw new WorkerError('VERIFICATION_INTERRUPTED', 'Verification was interrupted; the run remains in verifying for a safe retry', { category: 'interrupted' });
  }
  if (outputTruncated) {
  // output truncated:safe fail-closed.truncation may indicate abnormal verify command output(attack or configuration issue),
  // transition to blocked(terminal state)safer than keeping verifying safer.user can manually adjust config then use recover recover.
  await updateRun(paths, options.id, (state) => transition(state, 'blocked', { failure: { code: 'VERIFICATION_OUTPUT_TRUNCATED', message: 'Verification output exceeded the safe capture limit' } }, 'verification output truncated'));
  throw new WorkerError('VERIFICATION_OUTPUT_TRUNCATED', 'Verification output exceeded the safe capture limit');
  }
  // verify after pass:if selfReview config enabled,transition to self-reviewing lets parent decide whether to call self-review;
  // otherwise directly reviewing.self-review command at self-reviewing called in state,also at reviewing skipped in state.
  // verification failure does not enter selfReviewing(self-review will due to verification.passed=false hang).
  const nextState = (passed && config.selfReview?.enabled) ? 'selfReviewing' : 'reviewing';
  const updated = await updateRun(paths, options.id, (state) => transition(state, nextState, { lastVerificationPassed: passed }));
  return { runId: options.id, status: updated.state.status, passed, verificationFile: loaded.files.verification };
  });
}
