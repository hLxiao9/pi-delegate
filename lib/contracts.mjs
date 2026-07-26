/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import path from 'node:path';
import { WorkerError, invariant } from './errors.mjs';

const CAPABILITIES = new Set(['text', 'code', 'tool-use', 'vision-input', 'image-output']);
const VISUAL_CAPABILITIES = new Set(['vision-input', 'image-output']);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const BLOCKING_PRIORITIES = new Set(['P0', 'P1', 'P2']);

// task domain and model strengths/modalities value set(see lib/difficulty.mjs).
// domain optional;strengths/modalities optional.no value validation when not declared.
const ALLOWED_DOMAINS = new Set(['frontend', 'backend', 'systems', 'algorithm', 'refactor', 'docs']);
const ALLOWED_MODALITIES = new Set(['text', 'vision', 'image-output']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value, field, { min = 0 } = {}) {
  invariant(Array.isArray(value) && value.length >= min && value.every((item) => typeof item === 'string' && item.length > 0), 'CONTRACT_INVALID', `${field} must be an array of non-empty strings`);
  invariant(new Set(value).size === value.length, 'CONTRACT_INVALID', `${field} must not contain duplicates`);
  return [...value];
}

function assertOnlyKeys(value, allowed, code, label) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  invariant(extras.length === 0, code, `${label} contains unsupported fields`, { extras });
}

export function validateTaskContract(value) {
  invariant(isPlainObject(value), 'CONTRACT_INVALID', 'Task contract must be an object');
  const keys = ['schemaVersion', 'runId', 'repositoryRoot', 'baseRevision', 'goal', 'allowedPaths', 'forbiddenPaths', 'constraints', 'acceptanceCriteria', 'verification', 'requiredCapabilities', 'risk', 'domain'];
  assertOnlyKeys(value, keys, 'CONTRACT_INVALID', 'Task contract');
  invariant(value.schemaVersion === 1, 'CONTRACT_INVALID', 'schemaVersion must equal 1');
  invariant(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(value.runId), 'CONTRACT_INVALID', 'runId is invalid');
  invariant(!value.runId.includes('..') && !value.runId.endsWith('.lock'), 'CONTRACT_INVALID', 'runId must be a valid git branch name component (no .. or .lock suffix)');
  invariant(typeof value.repositoryRoot === 'string' && path.isAbsolute(value.repositoryRoot), 'CONTRACT_INVALID', 'repositoryRoot must be absolute');
  invariant(/^[0-9a-f]{40,64}$/.test(value.baseRevision), 'CONTRACT_INVALID', 'baseRevision must be a full Git object id');
  invariant(typeof value.goal === 'string' && value.goal.length >= 10 && value.goal.length <= 4000, 'CONTRACT_INVALID', 'goal must contain 10-4000 characters');
  const allowedPaths = stringArray(value.allowedPaths, 'allowedPaths', { min: 1 });
  const forbiddenPaths = stringArray(value.forbiddenPaths, 'forbiddenPaths');
  const constraints = stringArray(value.constraints, 'constraints');
  const acceptanceCriteria = stringArray(value.acceptanceCriteria, 'acceptanceCriteria', { min: 1 });
  invariant(Array.isArray(value.verification) && value.verification.length > 0, 'CONTRACT_INVALID', 'verification must contain at least one command');
  const verification = value.verification.map((entry, index) => {
  invariant(isPlainObject(entry), 'CONTRACT_INVALID', `verification[${index}] must be an object`);
  assertOnlyKeys(entry, ['argv', 'timeoutSeconds', 'env'], 'CONTRACT_INVALID', `verification[${index}]`);
  invariant(Array.isArray(entry.argv) && entry.argv.length > 0 && entry.argv.every((part) => typeof part === 'string' && part.length > 0), 'CONTRACT_INVALID', `verification[${index}].argv is invalid`);
  invariant(Number.isInteger(entry.timeoutSeconds) && entry.timeoutSeconds >= 1 && entry.timeoutSeconds <= 3600, 'CONTRACT_INVALID', `verification[${index}].timeoutSeconds is invalid`);
  const env = entry.env ?? {};
  invariant(isPlainObject(env) && Object.entries(env).every(([key, item]) => /^[A-Z_][A-Z0-9_]*$/.test(key) && typeof item === 'string' && item.length <= 1000), 'CONTRACT_INVALID', `verification[${index}].env is invalid`);
  return { argv: [...entry.argv], timeoutSeconds: entry.timeoutSeconds, env: { ...env } };
  });
  const requiredCapabilities = stringArray(value.requiredCapabilities, 'requiredCapabilities', { min: 1 });
  invariant(requiredCapabilities.every((item) => CAPABILITIES.has(item)), 'CONTRACT_INVALID', 'requiredCapabilities contains an unknown capability');
  invariant(['low', 'medium', 'high'].includes(value.risk), 'CONTRACT_INVALID', 'risk must be low, medium, or high');
  // domain optional;if provided value must be in ALLOWED_DOMAINS within(avoid silent fallback to typo inferred path).
  let domain = null;
  if (value.domain !== undefined && value.domain !== null) {
  invariant(typeof value.domain === 'string' && value.domain.length > 0, 'CONTRACT_INVALID', 'domain must be a non-empty string when present');
  invariant(ALLOWED_DOMAINS.has(value.domain), 'CONTRACT_INVALID', `domain must be one of: ${[...ALLOWED_DOMAINS].join(', ')}`, { domain: value.domain });
  domain = value.domain;
  }
  return { ...value, allowedPaths, forbiddenPaths, constraints, acceptanceCriteria, verification, requiredCapabilities, domain };
}

export function validateReviewResult(value) {
  invariant(isPlainObject(value), 'REVIEW_INVALID', 'Review result must be an object');
  assertOnlyKeys(value, ['schemaVersion', 'verdict', 'diffSha256', 'findings', 'verificationGaps', 'summary'], 'REVIEW_INVALID', 'Review result');
  invariant(value.schemaVersion === 1, 'REVIEW_INVALID', 'schemaVersion must equal 1');
  invariant(value.verdict === 'approve' || value.verdict === 'revise', 'REVIEW_INVALID', 'verdict must be approve or revise');
  invariant(typeof value.diffSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.diffSha256), 'REVIEW_INVALID', 'diffSha256 must be a lowercase SHA-256 digest');
  invariant(Array.isArray(value.findings), 'REVIEW_INVALID', 'findings must be an array');
  const findings = value.findings.map((finding, index) => {
  invariant(isPlainObject(finding), 'REVIEW_INVALID', `findings[${index}] must be an object`);
  assertOnlyKeys(finding, ['priority', 'file', 'line', 'problem', 'evidence', 'requiredChange'], 'REVIEW_INVALID', `findings[${index}]`);
  invariant(PRIORITIES.has(finding.priority), 'REVIEW_INVALID', `findings[${index}].priority is invalid`);
  invariant(typeof finding.file === 'string' && finding.file.length > 0, 'REVIEW_INVALID', `findings[${index}].file is invalid`);
  invariant(finding.line === null || (Number.isInteger(finding.line) && finding.line >= 1), 'REVIEW_INVALID', `findings[${index}].line is invalid`);
  for (const field of ['problem', 'evidence', 'requiredChange']) invariant(typeof finding[field] === 'string' && finding[field].length > 0, 'REVIEW_INVALID', `findings[${index}].${field} is invalid`);
  return { ...finding };
  });
  const verificationGaps = stringArray(value.verificationGaps, 'verificationGaps');
  invariant(typeof value.summary === 'string' && value.summary.length > 0 && value.summary.length <= 4000, 'REVIEW_INVALID', 'summary is invalid');
  const hasBlocking = findings.some((finding) => BLOCKING_PRIORITIES.has(finding.priority));
  if (value.verdict === 'approve') {
  invariant(!hasBlocking && verificationGaps.length === 0, 'REVIEW_INVALID', 'approve cannot contain P0-P2 findings or verification gaps');
  } else {
  invariant(hasBlocking || verificationGaps.length > 0, 'REVIEW_INVALID', 'revise must contain a blocking finding or verification gap');
  }
  return { ...value, findings, verificationGaps };
}

// Self-review is Pi worker self-check report,parent LLM read it instead of full diff reading.
// note:Pi may lie.validation only guarantees structural legality;truthfulness by parent spot-check + verification.json fallback.
// - diffSha256 must match verification.json  diffSha256 consistent,otherwise parent should enter full review.
// - acceptanceEvidence.status: met=Pi claims to satisfy(parent spot-check), uncertain=Pi uncertain(parent must check), unmet=Pi self-considered unmet(parent should judge revise)
// - findings by Pi actively reports its own issues;parent can merge with its own spot-check results merged.
export function validateSelfReviewResult(value) {
  invariant(isPlainObject(value), 'SELF_REVIEW_INVALID', 'Self-review result must be an object');
  assertOnlyKeys(value, ['schemaVersion', 'runId', 'diffSha256', 'acceptanceEvidence', 'findings', 'uncertainCriteria', 'summary'], 'SELF_REVIEW_INVALID', 'Self-review result');
  invariant(value.schemaVersion === 1, 'SELF_REVIEW_INVALID', 'schemaVersion must equal 1');
  invariant(typeof value.runId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(value.runId), 'SELF_REVIEW_INVALID', 'runId is invalid');
  invariant(typeof value.diffSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.diffSha256), 'SELF_REVIEW_INVALID', 'diffSha256 must be a lowercase SHA-256 digest');
  invariant(Array.isArray(value.acceptanceEvidence) && value.acceptanceEvidence.length > 0, 'SELF_REVIEW_INVALID', 'acceptanceEvidence must be a non-empty array');
  const acceptanceEvidence = value.acceptanceEvidence.map((entry, index) => {
  invariant(isPlainObject(entry), 'SELF_REVIEW_INVALID', `acceptanceEvidence[${index}] must be an object`);
  assertOnlyKeys(entry, ['criterion', 'status', 'evidence'], 'SELF_REVIEW_INVALID', `acceptanceEvidence[${index}]`);
  invariant(typeof entry.criterion === 'string' && entry.criterion.length > 0 && entry.criterion.length <= 1000, 'SELF_REVIEW_INVALID', `acceptanceEvidence[${index}].criterion is invalid`);
  invariant(['met', 'uncertain', 'unmet'].includes(entry.status), 'SELF_REVIEW_INVALID', `acceptanceEvidence[${index}].status must be met, uncertain, or unmet`);
  invariant(Array.isArray(entry.evidence), 'SELF_REVIEW_INVALID', `acceptanceEvidence[${index}].evidence must be an array`);
  const evidence = entry.evidence.map((item, j) => {
  invariant(isPlainObject(item), 'SELF_REVIEW_INVALID', `acceptanceEvidence[${index}].evidence[${j}] must be an object`);
  assertOnlyKeys(item, ['file', 'line', 'note'], 'SELF_REVIEW_INVALID', `acceptanceEvidence[${index}].evidence[${j}]`);
  invariant(typeof item.file === 'string' && item.file.length > 0 && item.file.length <= 1000, 'SELF_REVIEW_INVALID', `acceptanceEvidence[${index}].evidence[${j}].file is invalid`);
  invariant(item.line === null || (Number.isInteger(item.line) && item.line >= 1), 'SELF_REVIEW_INVALID', `acceptanceEvidence[${index}].evidence[${j}].line is invalid`);
  if (item.note !== undefined) invariant(typeof item.note === 'string' && item.note.length > 0 && item.note.length <= 1000, 'SELF_REVIEW_INVALID', `acceptanceEvidence[${index}].evidence[${j}].note is invalid`);
  return { ...item };
  });
  return { criterion: entry.criterion, status: entry.status, evidence };
  });
  invariant(Array.isArray(value.findings), 'SELF_REVIEW_INVALID', 'findings must be an array');
  const findings = value.findings.map((finding, index) => {
  invariant(isPlainObject(finding), 'SELF_REVIEW_INVALID', `findings[${index}] must be an object`);
  assertOnlyKeys(finding, ['priority', 'file', 'line', 'problem', 'requiredChange'], 'SELF_REVIEW_INVALID', `findings[${index}]`);
  invariant(PRIORITIES.has(finding.priority), 'SELF_REVIEW_INVALID', `findings[${index}].priority is invalid`);
  invariant(typeof finding.file === 'string' && finding.file.length > 0 && finding.file.length <= 1000, 'SELF_REVIEW_INVALID', `findings[${index}].file is invalid`);
  invariant(finding.line === null || (Number.isInteger(finding.line) && finding.line >= 1), 'SELF_REVIEW_INVALID', `findings[${index}].line is invalid`);
  invariant(typeof finding.problem === 'string' && finding.problem.length > 0 && finding.problem.length <= 4000, 'SELF_REVIEW_INVALID', `findings[${index}].problem is invalid`);
  invariant(typeof finding.requiredChange === 'string' && finding.requiredChange.length > 0 && finding.requiredChange.length <= 4000, 'SELF_REVIEW_INVALID', `findings[${index}].requiredChange is invalid`);
  return { ...finding };
  });
  const uncertainCriteria = stringArray(value.uncertainCriteria, 'uncertainCriteria');
  invariant(typeof value.summary === 'string' && value.summary.length > 0 && value.summary.length <= 4000, 'SELF_REVIEW_INVALID', 'summary is invalid');
  // unlike review strongly validated as verdict and findings consistency:Pi may honestly report unmet self-check finding.
  // parent LLM see any unmet/uncertain or P0-P2 finding after,should decide on its own verdict.
  return { ...value, acceptanceEvidence, findings, uncertainCriteria };
}

export function assertDelegableCapabilities(task, profile) {
  // M5: high-risk is policy decision,uses independent error code,and pre-check avoids invalid capability validate.
  if (task.risk === 'high') throw new WorkerError('HIGH_RISK_BLOCKED', 'High-risk tasks must stay with the parent agent', { risk: task.risk });
  const requested = new Set(task.requiredCapabilities);
  const available = new Set(profile.capabilities ?? []);
  // vision/image tasks can be delegated to declared capability and modality  profile.
  const missing = [...requested].filter((item) => !available.has(item));
  if (missing.length > 0) throw new WorkerError('CAPABILITY_MISMATCH', 'Profile lacks required capabilities', { missing });
  // modalities soft check:if profile declared modalities,vision/image capability should have corresponding modality support.
  const modalities = new Set(profile.modalities ?? ['text']);
  if (requested.has('vision-input') && !modalities.has('vision')) {
  throw new WorkerError('CAPABILITY_MISMATCH', 'Profile declares vision-input capability but modalities lacks vision', { profile: profile.name ?? null });
  }
  if (requested.has('image-output') && !modalities.has('image-output')) {
  throw new WorkerError('CAPABILITY_MISMATCH', 'Profile declares image-output capability but modalities lacks image-output', { profile: profile.name ?? null });
  }
}

// validate profile  strengths/modalities field(optional,but if provided value must be legal).
// in config.mjs load profiles called at,typos exposed early.
export function validateProfileFields(profile, profileName) {
  if (profile.strengths !== undefined && profile.strengths !== null) {
  invariant(Array.isArray(profile.strengths) && profile.strengths.every((s) => typeof s === 'string' && s.length > 0), 'CONFIG_INVALID', `profile ${profileName}.strengths must be an array of non-empty strings`);
  const unknown = profile.strengths.filter((s) => !ALLOWED_DOMAINS.has(s));
  invariant(unknown.length === 0, 'CONFIG_INVALID', `profile ${profileName}.strengths contains unknown domain`, { unknown, allowed: [...ALLOWED_DOMAINS] });
  }
  if (profile.modalities !== undefined && profile.modalities !== null) {
  invariant(Array.isArray(profile.modalities) && profile.modalities.every((m) => typeof m === 'string' && m.length > 0), 'CONFIG_INVALID', `profile ${profileName}.modalities must be an array of non-empty strings`);
  const unknown = profile.modalities.filter((m) => !ALLOWED_MODALITIES.has(m));
  invariant(unknown.length === 0, 'CONFIG_INVALID', `profile ${profileName}.modalities contains unknown modality`, { unknown, allowed: [...ALLOWED_MODALITIES] });
  }
}
