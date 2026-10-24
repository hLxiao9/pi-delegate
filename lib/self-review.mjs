/*
 * spotworkers - Delegate bounded coding tasks to cheap agent workers
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './atomic-json.mjs';
import { loadConfig, resolveWorkerPaths, selectProfile } from './config.mjs';
import { validateSelfReviewResult, assertDelegableCapabilities } from './contracts.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { git } from './git-worker.mjs';
import { runPiTurn } from './pi-runner.mjs';
import { loadRun, transition, updateRun, withRunLock } from './state.mjs';

// Self-review always runs on the profile that implemented the change. A
// cross-family reviewer was tried and dropped: parent agents do not go looking
// for a second model to grade themselves either, so the phase that actually
// costs tokens (the extra turn) would have to be paid for by a wiring nobody
// configures. What keeps the report honest is upstream of the model —
// verification.json is wrapper-produced, locked paths stop the test from being
// rewritten, the hash pins the report to one diff — plus the proportional
// spot-check below. `reviewerModel` is recorded so the reviewer's identity is
// never a guess.

// A fixed spot-check count does not scale: with `spotCheckCount: 1` on a
// twelve-criterion contract, a lying worker gets eleven free passes. The
// ratio makes the check proportional to what it is checking.
function spotCheckRequiredFor({ config, acceptanceEvidence }) {
  const met = acceptanceEvidence.filter((entry) => entry.status === 'met').length;
  const uncertain = acceptanceEvidence.filter((entry) => entry.status === 'uncertain').length;
  const ratio = config.selfReview.spotCheckRatio ?? 0;
  return Math.max(config.selfReview.spotCheckCount ?? 0, Math.ceil(met * ratio), uncertain);
}

// construct Pi self-review prompt.Pi gets its own diff, independent verification result, 
// acceptance criteria and constraints,and review-policy  P0-P3 priority table,generates structured self-review.
// key:Pi still no shell,can only use read/grep tool to read its own diff,cannot forge test results.
export function buildSelfReviewPrompt({ task, verification, changedFiles, diffStat, diffSha256 }) {
  const acceptanceList = task.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
  const constraintList = task.constraints.length > 0
  ? task.constraints.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
  : '  (none)';
  const lockedList = (task.lockedPaths ?? []).length > 0
  ? task.lockedPaths.map((c) => `  - ${c}`).join('\n')
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
  '## Locked paths (you must not have modified these)',
  lockedList,
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
  "Output ONLY the JSON object. Do not wrap it in markdown fences. Do not include commentary before or after. Do not add extra fields: no confirmation flags, no confidence scores, no fields outside the shape above.",
  ].join('\n');
}

// What a Tier C reviewer would otherwise have to read: the diff plus every
// changed file in full. Files that were deleted contribute nothing.
async function reviewSurfaceBytes({ state, security }) {
  let total = security?.diffBytes ?? 0;
  for (const relative of security?.changedFiles ?? []) {
    const info = await lstat(path.join(state.worktreePath, relative)).catch(() => null);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

async function readDiffMetadata({ paths, state, env }) {  // reuse security.mjs scan results to ensure diffSha256 and verification.json consistent.
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

// Cheap models like to add a confirmation echo ("diffSha256_confirmed": true,
// "confidence": "high"). Strictly rejecting the whole report for one unknown
// key throws away the token saving the phase exists for, while gaining nothing:
// unknown keys are never read. Drop them, remember what was dropped, and keep
// validating every field the parent actually consumes.
const SELF_REVIEW_KEYS = ['schemaVersion', 'runId', 'diffSha256', 'acceptanceEvidence', 'findings', 'uncertainCriteria', 'summary'];
const EVIDENCE_KEYS = ['criterion', 'status', 'evidence'];
const EVIDENCE_ITEM_KEYS = ['file', 'line', 'note'];
const FINDING_KEYS = ['priority', 'file', 'line', 'problem', 'requiredChange'];

function keepKeys(value, allowed, dropped, prefix) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const kept = {};
  for (const [key, item] of Object.entries(value)) {
    if (allowed.includes(key)) kept[key] = item;
    else dropped.push(`${prefix}${key}`);
  }
  return kept;
}

export function stripUnknownFields(parsed) {
  const dropped = [];
  const clean = keepKeys(parsed, SELF_REVIEW_KEYS, dropped, '');
  if (Array.isArray(clean?.acceptanceEvidence)) {
    clean.acceptanceEvidence = clean.acceptanceEvidence.map((entry, index) => {
      const kept = keepKeys(entry, EVIDENCE_KEYS, dropped, `acceptanceEvidence[${index}].`);
      if (Array.isArray(kept?.evidence)) {
        kept.evidence = kept.evidence.map((item, j) => keepKeys(item, EVIDENCE_ITEM_KEYS, dropped, `acceptanceEvidence[${index}].evidence[${j}].`));
      }
      return kept;
    });
  }
  if (Array.isArray(clean?.findings)) {
    clean.findings = clean.findings.map((finding, index) => keepKeys(finding, FINDING_KEYS, dropped, `findings[${index}].`));
  }
  return { value: clean, dropped };
}

function parseSelfReviewJson(raw) {  // Pi may output content with ```json fences content,or with explanation text before/after.extract first { ... } block.
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

  // A report is not free: it runs ~700 bytes per acceptance criterion plus a
  // fixed header, while the diff a reviewer would read is roughly 40 bytes per
  // changed line. Measured on real runs, a 24-line change produced a 3.4 KB
  // report against a 2.9 KB review surface — the "saving" was negative. So the
  // gate is the *review surface* (diff + every changed file), not the diff
  // alone: editing 70 lines inside a 9 KB file is worth a report, editing 20
  // lines in three 400-byte files is not.
  const surfaceBytes = await reviewSurfaceBytes({ state: loaded.state, security: verification.security });
  const expectedReportBytes = 900 + 700 * loaded.task.acceptanceCriteria.length;
  if (surfaceBytes < config.selfReview.minSurfaceBytes) {
  const updated = await updateRun(paths, options.id, (state) => transition(state, 'reviewing', {
  selfReviewSkipped: true,
  selfReviewSkipReason: 'review-surface-too-small',
  reviewSurfaceBytes: surfaceBytes,
  expectedReportBytes,
  }));
  return { runId: options.id, status: updated.state.status, skipped: true, reason: 'review-surface-too-small', reviewSurfaceBytes: surfaceBytes, expectedReportBytes };
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
  const { value: normalized, dropped } = stripUnknownFields(parsed);
  let selfReview;
  try {
  selfReview = validateSelfReviewResult(normalized);
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
  const reviewerProfile = piResult.profile ?? {};
  const spotCheckRequired = spotCheckRequiredFor({
  config,
  acceptanceEvidence: selfReview.acceptanceEvidence,
  });
  const fallbackRecommended = shaMismatch
  || selfReview.acceptanceEvidence.some((e) => e.status === 'unmet')
  || selfReview.findings.some((f) => ['P0', 'P1', 'P2'].includes(f.priority));

  await writeJsonAtomic(loaded.files.selfReview, {
  ...selfReview,
  diffSha256Mismatch: shaMismatch,
  generatedAt: new Date().toISOString(),
  reviewerProfile: reviewerProfile.name ?? null,
  reviewerProvider: reviewerProfile.provider ?? null,
  reviewerModel: reviewerProfile.model ?? null,
  droppedFields: dropped,
  spotCheckRequired,
  fallbackRecommended,
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
  reviewerProfile: reviewerProfile.name ?? null,
  spotCheckRequired,
  fallbackRecommended,
  selfReviewFile: loaded.files.selfReview,
  };
  });
}
