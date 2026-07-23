import path from 'node:path';
import { WorkerError, invariant } from './errors.mjs';

const CAPABILITIES = new Set(['text', 'code', 'tool-use', 'vision-input', 'image-output']);
const VISUAL_CAPABILITIES = new Set(['vision-input', 'image-output']);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const BLOCKING_PRIORITIES = new Set(['P0', 'P1', 'P2']);

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
  const keys = ['schemaVersion', 'runId', 'repositoryRoot', 'baseRevision', 'goal', 'allowedPaths', 'forbiddenPaths', 'constraints', 'acceptanceCriteria', 'verification', 'requiredCapabilities', 'risk'];
  assertOnlyKeys(value, keys, 'CONTRACT_INVALID', 'Task contract');
  invariant(value.schemaVersion === 1, 'CONTRACT_INVALID', 'schemaVersion must equal 1');
  invariant(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$/.test(value.runId), 'CONTRACT_INVALID', 'runId is invalid');
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
  return { ...value, allowedPaths, forbiddenPaths, constraints, acceptanceCriteria, verification, requiredCapabilities };
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

export function assertDelegableCapabilities(task, profile) {
  const requested = new Set(task.requiredCapabilities);
  const available = new Set(profile.capabilities ?? []);
  const visual = [...requested].filter((item) => VISUAL_CAPABILITIES.has(item));
  if (visual.length > 0) throw new WorkerError('CAPABILITY_MISMATCH', 'Visual tasks are not delegated to Pi in v1', { visual });
  const missing = [...requested].filter((item) => !available.has(item));
  if (missing.length > 0) throw new WorkerError('CAPABILITY_MISMATCH', 'Profile lacks required capabilities', { missing });
  if (task.risk === 'high') throw new WorkerError('CAPABILITY_MISMATCH', 'High-risk tasks must stay with Sol', { risk: task.risk });
}
