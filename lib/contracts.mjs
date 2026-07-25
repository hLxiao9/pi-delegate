import path from 'node:path';
import { WorkerError, invariant } from './errors.mjs';

const CAPABILITIES = new Set(['text', 'code', 'tool-use', 'vision-input', 'image-output']);
const VISUAL_CAPABILITIES = new Set(['vision-input', 'image-output']);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const BLOCKING_PRIORITIES = new Set(['P0', 'P1', 'P2']);

// 任务领域与模型 strengths/modalities 取值集合(见 lib/difficulty.mjs)。
// domain 可选;strengths/modalities 可选。未声明时不校验取值。
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
  // domain 可选;若提供必须取值在 ALLOWED_DOMAINS 内(避免拼写错误静默落到 inferred 路径)。
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

// Self-review 是 Pi worker 自检报告,主控 LLM 读它代替全量 diff 阅读。
// 注意:Pi 可能撒谎。校验只保证结构合法;真伪由主控 spot-check + verification.json 兜底。
// - diffSha256 必须与 verification.json 的 diffSha256 一致,否则主控应进入全量 review。
// - acceptanceEvidence.status: met=Pi 声称满足(主控抽检), uncertain=Pi 不确定(主控必查), unmet=Pi 自认未满足(主控应判 revise)
// - findings 由 Pi 主动报告自身问题;主控可将其与自身 spot-check 结果合并。
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
  // 不像 review 那样强校验 verdict 与 findings 一致性:Pi 可能诚实报告 unmet 自检 finding。
  // 主控 LLM 看到任何 unmet/uncertain 或 P0-P2 finding 后,应自行决定 verdict。
  return { ...value, acceptanceEvidence, findings, uncertainCriteria };
}

export function assertDelegableCapabilities(task, profile) {
  // M5: high-risk 是策略决策,用独立错误码,且提前检查避免无效 capability 校验。
  if (task.risk === 'high') throw new WorkerError('HIGH_RISK_BLOCKED', 'High-risk tasks must stay with the parent agent', { risk: task.risk });
  const requested = new Set(task.requiredCapabilities);
  const available = new Set(profile.capabilities ?? []);
  // 视觉/图像任务可委派给声明了对应 capability 和 modality 的 profile。
  const missing = [...requested].filter((item) => !available.has(item));
  if (missing.length > 0) throw new WorkerError('CAPABILITY_MISMATCH', 'Profile lacks required capabilities', { missing });
  // modalities 软校验:若 profile 声明了 modalities,视觉/图像 capability 应有对应 modality 支撑。
  const modalities = new Set(profile.modalities ?? ['text']);
  if (requested.has('vision-input') && !modalities.has('vision')) {
    throw new WorkerError('CAPABILITY_MISMATCH', 'Profile declares vision-input capability but modalities lacks vision', { profile: profile.name ?? null });
  }
  if (requested.has('image-output') && !modalities.has('image-output')) {
    throw new WorkerError('CAPABILITY_MISMATCH', 'Profile declares image-output capability but modalities lacks image-output', { profile: profile.name ?? null });
  }
}

// 校验 profile 的 strengths/modalities 字段(可选,但若提供必须取值合法)。
// 在 config.mjs 加载 profiles 时调用,拼写错误尽早暴露。
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
