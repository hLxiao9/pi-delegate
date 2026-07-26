/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './atomic-json.mjs';
import { loadConfig, resolveWorkerPaths, selectProfile } from './config.mjs';
import { validateSelfReviewResult, assertDelegableCapabilities } from './contracts.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { git } from './git-worker.mjs';
import { runPiTurn } from './pi-runner.mjs';
import { loadRun, transition, updateRun, withRunLock } from './state.mjs';

// construct Pi self-review prompt.Pi gets its own diff, independent verification result, 
// acceptance criteria and constraints,and review-policy  P0-P3 priority table,generates structured self-review.
// key:Pi still no shell,can only use read/grep tool to read its own diff,cannot forge test results.
export function buildSelfReviewPrompt({ task, verification, changedFiles, diffStat, diffSha256 }) {
  const acceptanceList = task.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
  const constraintList = task.constraints.length > 0
  ? task.constraints.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
  : '  (none)';
  const changedList = changedFiles.map((f) => `  - ${f}`).join('\n');
  const statList = diffStat.map((s) => `  ${s.added}+ ${s.deleted}- ${s.path}`).join('\n');
  const verificationSummary = verification.commands.map((c) => {
  const status = c.passed ? 'PASS' : `FAIL(exit=${c.code})`;
  return `  ${status} ${c.argv.join(' ')} (${c.durationMs}ms)`;
  }).join('\n');

  return [
  'You are an implementation worker performing SELF-REVIEW on your own diff before the parent agent reviews it.',
  'The parent agent owns the final verdict; your self-review is a hint to reduce the parent token spend, not a substitute for its judgment.',
  'Be honest and precise. Lying about evidence will cause the parent to fall back to a full-diff review and cost more tokens.',
  '',
  '## Hard rules',
  '- You do NOT have a shell. Do not claim that tests pass or fail beyond what is in the verification evidence below.',
  '- Use the read/grep tools to inspect your own diff and the changed files.',
  '- For every acceptance criterion, classify it as: met (you can point to evidence), uncertain (you cannot prove it), or unmet (you know it fails).',
  '- Report any P0-P3 finding you notice in your own work using the priority table below.',
  '- The diffSha256 in your output MUST equal the value provided below.',
  '',
  '## Priority table',
  '| P0 | Data loss, credential exposure, destructive or production-critical defect |',
  '| P1 | Likely correctness/security failure in normal use |',
  '| P2 | Real edge-case regression, missing required test, contract breach, material maintainability defect |',
  '| P3 | Non-blocking preference or polish |',
  '',
  '## Task contract summary',
  `Goal: ${task.goal}`,
  `Risk: ${task.risk}`,
  `Domain: ${task.domain ?? '(not declared)'}`,
  `Required capabilities: ${task.requiredCapabilities.join(', ')}`,
  '',
  '## Acceptance criteria (judge each one)',
  acceptanceList,
  '',
  '## Constraints',
  constraintList,
  '',
  '## Independent verification (run by the parent wrapper, not you)',
  `diffSha256: ${diffSha256}`,
  `Overall passed: ${verification.passed}`,
  verificationSummary,
  '',
  '## Changed files',
  changedList,
  '',
  '## Diff stat',
  statList,
  '',
  '## Required output format',
  'Output a single JSON object matching this shape:',
  '```json',
  '{',
  '  "schemaVersion": 1,',
  '  "runId": "<the run id>",',
  '  "diffSha256": "<the diffSha256 provided above>",',
  '  "acceptanceEvidence": [',
  '  { "criterion": "<verbatim acceptance criterion text>", "status": "met|uncertain|unmet",',
  '  "evidence": [ { "file": "<relative path>", "line": <integer|null>, "note": "<short justification>" } ] }',
  '  ],',
  '  "findings": [',
  '  { "priority": "P0|P1|P2|P3", "file": "<relative path>", "line": <integer|null>,',
  '  "problem": "<what is wrong>", "requiredChange": "<what to fix>" }',
  '  ],',
  '  "uncertainCriteria": ["<criterion text that you marked uncertain or could not evidence>"],',
  '  "summary": "<one short paragraph summarizing the change and your confidence>"',
  '}',
  '```',
  'Output ONLY the JSON object. Do not wrap it in markdown fences. Do not include commentary before or after.',
  ].join('\n');
}

async function readDiffMetadata({ paths, state, env }) {
  // reuse security.mjs scan results to ensure diffSha256 and verification.json consistent.
  // here only reads git diff metadata of(name-only + numstat),does not recompute hash.
  const namesResult = await git(paths, state.worktreePath, ['diff', '--name-only', '-z', '--no-renames', state.workerBaseRevision], { env });
  const changedFiles = namesResult.stdout.split('\0').filter(Boolean);
  const numstatResult = await git(paths, state.worktreePath, ['diff', '--numstat', '-z', '--no-renames', state.workerBaseRevision], { env });
  const diffStat = numstatResult.stdout.split('\0').filter(Boolean).map((record) => {
  const [added, deleted, ...pathParts] = record.split('\t');
  return { added, deleted, path: pathParts.join('\t') };
  });
  return { changedFiles, diffStat };
}

function parseSelfReviewJson(raw) {
  // Pi may output content with ```json fences content,or with explanation text before/after.extract first { ... } block.
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
  try { return JSON.parse(trimmed); } catch {}
  }
  const fenceMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) {
  try { return JSON.parse(fenceMatch[1]); } catch {}
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
  const candidate = trimmed.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch {}
  }
  throw new WorkerError('SELF_REVIEW_INVALID', 'Pi did not return a parseable JSON self-review', { rawPreview: trimmed.slice(0, 500) });
}

export async function selfReviewCommand(options = {}, runtime = {}) {
  invariant(options.id, 'CLI_USAGE', 'self-review requires --id', {}, 2);
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  return withRunLock(paths, options.id, async () => {
  const loaded = await loadRun(paths, options.id);
  invariant(['verifying', 'selfReviewing'].includes(loaded.state.status), 'STATE_INVALID', `self-review requires verifying or selfReviewing state, found ${loaded.state.status}`);
  const config = await loadConfig(paths);

  // config disabled → directly transition to reviewing,does not call Pi
  if (!config.selfReview.enabled) {
  const updated = await updateRun(paths, options.id, (state) => transition(state, 'reviewing', { selfReviewSkipped: true, selfReviewSkipReason: 'disabled' }));
  return { runId: options.id, status: updated.state.status, skipped: true, reason: 'disabled' };
  }

  // read independent verification result(by verify command produces)
  const verification = await readJson(loaded.files.verification).catch((error) => {
  if (error.code === 'ENOENT') throw new WorkerError('STATE_INVALID', `verification.json missing; run 'verify --id ${options.id}' first`);
  throw error;
  });
  if (!verification.passed) {
  // verification failure does not throw and hang,but transitions to reviewing lets parent decide revise.
  // previously using invariant throwing would cause run stuck at selfReviewing/verifying state unrecoverable.
  const updated = await updateRun(paths, options.id, (state) => transition(state, 'reviewing', {
  selfReviewSkipped: true,
  selfReviewSkipReason: 'verification-not-passed',
  }));
  return { runId: options.id, status: updated.state.status, skipped: true, reason: 'verification-not-passed' };
  }

  // diff too small → self-review cost outweighs benefit
  if (typeof verification.security?.diffBytes === 'number' && verification.security.diffBytes < config.selfReview.minDiffBytes) {
  const updated = await updateRun(paths, options.id, (state) => transition(state, 'reviewing', { selfReviewSkipped: true, selfReviewSkipReason: 'diff-too-small', diffBytes: verification.security.diffBytes }));
  return { runId: options.id, status: updated.state.status, skipped: true, reason: 'diff-too-small', diffBytes: verification.security.diffBytes };
  }

  const diffSha256 = verification.security?.diffSha256;
  invariant(diffSha256, 'STATE_INVALID', 'verification.json is missing security.diffSha256');

  // enter self-reviewing(if already self-reviewing then skip transition)
  if (loaded.state.status === 'verifying') {
  await updateRun(paths, options.id, (state) => transition(state, 'selfReviewing'));
  }

  const { changedFiles, diffStat } = await readDiffMetadata({ paths, state: loaded.state, env });
  const prompt = buildSelfReviewPrompt({
  task: loaded.task,
  verification,
  changedFiles,
  diffStat,
  diffSha256,
  });

  // reuse runPiTurn  retry / fallback logic,mode=self-review
  // Pi self-review does not modify files(only use read/grep),no need assertDelegableCapabilities limit vision etc.
  let piResult;
  try {
  piResult = await runPiTurn({
  paths,
  files: loaded.files,
  state: loaded.state,
  task: loaded.task,
  config,
  env,
  mode: 'self-review',
  evidence: null,
  promptOverride: prompt,
  expectJsonOutput: true,
  });
  } catch (error) {
  if (error.code === 'PI_INTERRUPTED' || error.details?.category === 'interrupted') {
  // Keep selfReviewing so the parent can retry the same phase after a
  // process interruption; treating a partial self-review as complete
  // would silently downgrade the review gate.
  await updateRun(paths, options.id, (state) => ({
  ...state,
  updatedAt: new Date().toISOString(),
  interruption: {
  interruptedAt: new Date().toISOString(),
  signal: error.details?.interruptionReason ?? null,
  recoverableFrom: 'selfReviewing',
  },
  }));
  throw error;
  }
  // self-review failure should not block entire run;degrade to reviewing lets parent do full review.
  const updated = await updateRun(paths, options.id, (state) => transition(state, 'reviewing', {
  selfReviewSkipped: true,
  selfReviewSkipReason: 'pi-failed',
  selfReviewError: { code: error.code, message: error.message },
  }));
  return { runId: options.id, status: updated.state.status, skipped: true, reason: 'pi-failed', error: { code: error.code, message: error.message } };
  }

  // parse Pi output.Pi --mode json output message_end event,message.content is [{type:'text', text:'...'}].
  const content = piResult.lastAssistant?.content;
  let rawText = '';
  if (Array.isArray(content)) {
  rawText = content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n');
  } else if (typeof content === 'string') {
  rawText = content;
  } else if (typeof piResult.lastAssistant?.text === 'string') {
  rawText = piResult.lastAssistant.text;
  }
  let parsed;
  try {
  parsed = parseSelfReviewJson(rawText);
  } catch (error) {
  const updated = await updateRun(paths, options.id, (state) => transition(state, 'reviewing', {
  selfReviewSkipped: true,
  selfReviewSkipReason: 'parse-failed',
  selfReviewError: { code: error.code, message: error.message },
  }));
  return { runId: options.id, status: updated.state.status, skipped: true, reason: 'parse-failed', error: { code: error.code, message: error.message } };
  }

  // runId fallback(if Pi missing fields)
  if (!parsed.runId) parsed.runId = loaded.state.runId;
  let selfReview;
  try {
  selfReview = validateSelfReviewResult(parsed);
  } catch (error) {
  // schema validation failure(field missing/type error)degrade to when reviewing,rather than hang at selfReviewing.
  // and parse-failed path consistent,lets parent do full review.
  const updated = await updateRun(paths, options.id, (state) => transition(state, 'reviewing', {
  selfReviewSkipped: true,
  selfReviewSkipReason: 'validation-failed',
  selfReviewError: { code: error.code, message: error.message },
  }));
  return { runId: options.id, status: updated.state.status, skipped: true, reason: 'validation-failed', error: { code: error.code, message: error.message } };
  }

  // consistency check:Pi reported diffSha256 must equal verification  diffSha256.
  // mismatch means Pi lying or read wrong diff → parent must do full review.
  const shaMismatch = selfReview.diffSha256 !== diffSha256;

  await writeJsonAtomic(loaded.files.selfReview, {
  ...selfReview,
  diffSha256Mismatch: shaMismatch,
  generatedAt: new Date().toISOString(),
  spotCheckRequired: Math.max(config.selfReview.spotCheckCount, selfReview.acceptanceEvidence.filter((e) => e.status === 'uncertain').length),
  fallbackRecommended: shaMismatch || selfReview.acceptanceEvidence.some((e) => e.status === 'unmet') || selfReview.findings.some((f) => ['P0', 'P1', 'P2'].includes(f.priority)),
  });

  const updated = await updateRun(paths, options.id, (state) => transition(state, 'reviewing', {
  selfReviewCompleted: true,
  selfReviewShaMismatch: shaMismatch,
  }));
  return {
  runId: options.id,
  status: updated.state.status,
  skipped: false,
  diffSha256Mismatch: shaMismatch,
  spotCheckRequired: Math.max(config.selfReview.spotCheckCount, selfReview.acceptanceEvidence.filter((e) => e.status === 'uncertain').length),
  fallbackRecommended: shaMismatch || selfReview.acceptanceEvidence.some((e) => e.status === 'unmet') || selfReview.findings.some((f) => ['P0', 'P1', 'P2'].includes(f.priority)),
  selfReviewFile: loaded.files.selfReview,
  };
  });
}
