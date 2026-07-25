import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COST_TIER_BY_DIFFICULTY,
  MODALITIES,
  TASK_DOMAINS,
  inferDifficulty,
  inferTaskDomain,
  selectProfileByDifficulty,
  selectProfileForTask,
} from '../lib/difficulty.mjs';

function makeConfig(profiles, defaultProfile) {
  return { defaultProfile: defaultProfile ?? Object.keys(profiles)[0], profiles };
}

function makeTask(overrides = {}) {
  return {
    goal: 'Add a small helper function.',
    acceptanceCriteria: ['tests pass'],
    risk: 'low',
    constraints: [],
    requiredCapabilities: ['text', 'code'],
    verification: [{ argv: ['npm', 'test'], timeoutSeconds: 120, env: {} }],
    allowedPaths: ['src/**'],
    forbiddenPaths: ['.env*'],
    ...overrides,
  };
}

test('inferTaskDomain honors explicit task.domain over keyword inference', () => {
  const task = makeTask({ goal: 'Add a React component for the login form', domain: 'backend' });
  const { domain, source } = inferTaskDomain(task);
  assert.equal(domain, 'backend');
  assert.equal(source, 'explicit');
});

test('inferTaskDomain infers frontend from goal keywords', () => {
  const task = makeTask({ goal: 'Refactor the React component to use hooks' });
  const { domain, source } = inferTaskDomain(task);
  assert.equal(domain, 'frontend');
  assert.equal(source, 'inferred');
});

test('inferTaskDomain infers backend from goal keywords', () => {
  const { domain, source } = inferTaskDomain(makeTask({ goal: 'Add a new API endpoint for user signup with database migration' }));
  assert.equal(domain, 'backend');
  assert.equal(source, 'inferred');
});

test('inferTaskDomain infers systems from goal keywords', () => {
  const { domain } = inferTaskDomain(makeTask({ goal: 'Optimize memory and cache usage under concurrency' }));
  assert.equal(domain, 'systems');
});

test('inferTaskDomain infers algorithm from goal keywords', () => {
  const { domain } = inferTaskDomain(makeTask({ goal: 'Implement a graph search algorithm with proper complexity' }));
  assert.equal(domain, 'algorithm');
});

test('inferTaskDomain infers refactor from goal keywords', () => {
  const { domain } = inferTaskDomain(makeTask({ goal: 'Refactor the module to modernize its structure' }));
  assert.equal(domain, 'refactor');
});

test('inferTaskDomain infers docs from goal keywords', () => {
  const { domain } = inferTaskDomain(makeTask({ goal: 'Update the README documentation for v2' }));
  assert.equal(domain, 'docs');
});

test('inferTaskDomain returns null when no keyword matches and no explicit domain', () => {
  const { domain, source } = inferTaskDomain(makeTask({ goal: 'Add a small helper function.' }));
  assert.equal(domain, null);
  assert.equal(source, null);
});

test('selectProfileForTask honors explicit options.profile over routing', () => {
  const config = makeConfig({
    cheap: { provider: 'p', model: 'm-cheap', apiKeyEnv: 'K1', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'cheap', strengths: ['frontend'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
    premium: { provider: 'p', model: 'm-premium', apiKeyEnv: 'K2', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'premium', strengths: ['backend'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
  });
  const task = makeTask({ risk: 'high' }); // would route to premium
  const result = selectProfileForTask(config, task, { profile: 'cheap' });
  assert.equal(result.name, 'cheap');
  assert.equal(result.routing, undefined, 'routing metadata is omitted when explicit profile is used');
});

test('selectProfileForTask routes by costTier when no domain match', () => {
  const config = makeConfig({
    cheap: { provider: 'p', model: 'm-cheap', apiKeyEnv: 'K1', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'cheap', strengths: ['algorithm'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
    standard: { provider: 'p', model: 'm-std', apiKeyEnv: 'K2', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'standard', strengths: ['backend'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
    premium: { provider: 'p', model: 'm-premium', apiKeyEnv: 'K3', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'premium', strengths: ['refactor'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
  });
  // 构造真正 high 难度但 risk=medium(避免被 HIGH_RISK_BLOCKED 提前返回 null):
  // long goal + 多验收标准 + medium risk + 多约束 + tool-use + 多验证 + 多路径
  const task = makeTask({
    goal: 'Refactor the entire streaming pipeline with backpressure, exactly-once semantics, multi-region failover, observability, and reversible migration. ' + 'x'.repeat(200),
    acceptanceCriteria: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    risk: 'medium',
    constraints: ['c1', 'c2', 'c3', 'c4', 'c5'],
    requiredCapabilities: ['text', 'code', 'tool-use'],
    verification: [{ argv: ['npm', 'test'], timeoutSeconds: 300, env: {} }, { argv: ['npm', 'run', 'lint'], timeoutSeconds: 60, env: {} }, { argv: ['npm', 'run', 'e2e'], timeoutSeconds: 600, env: {} }],
    allowedPaths: ['src/**', 'tests/**', 'docs/**', 'scripts/**', 'config/**'],
  }); // score = 2(goal>800) + 2(acceptance>=8) + 1(risk=medium) + 1(constraints>=5) + 1(tool-use) + 1(verification>=3) + 1(allowedPaths>=5) = 9 → high
  const result = selectProfileForTask(config, task);
  assert.equal(result.name, 'premium');
  assert.equal(result.routing.difficulty, 'high');
  assert.equal(result.routing.targetTier, 'premium');
  assert.match(result.routing.matchReason, /^costTier/);
});

test('selectProfileForTask soft-matches domain strengths within the target tier', () => {
  // 同一 standard tier 内有两个 profile:一个擅长 backend,一个擅长 frontend。
  const config = makeConfig({
    stdBackend: { provider: 'p', model: 'm-backend', apiKeyEnv: 'K1', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'standard', strengths: ['backend'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
    stdFrontend: { provider: 'p', model: 'm-frontend', apiKeyEnv: 'K2', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'standard', strengths: ['frontend'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
  });
  const task = makeTask({
    goal: 'Refactor the React component to use hooks',
    acceptanceCriteria: ['a', 'b', 'c', 'd'], risk: 'medium', // medium → standard tier
  });
  const result = selectProfileForTask(config, task);
  assert.equal(result.name, 'stdFrontend', 'should pick the frontend-strength profile in standard tier');
  assert.equal(result.routing.domain, 'frontend');
  assert.equal(result.routing.matchReason, 'strengths:frontend');
});

test('selectProfileForTask falls back to first candidate when domain has no strength match', () => {
  const config = makeConfig({
    stdBackend: { provider: 'p', model: 'm-backend', apiKeyEnv: 'K1', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'standard', strengths: ['backend'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
  });
  const task = makeTask({
    goal: 'Refactor the React component', // inferred frontend
    acceptanceCriteria: ['a', 'b', 'c', 'd'], risk: 'medium',
  });
  const result = selectProfileForTask(config, task);
  assert.equal(result.name, 'stdBackend');
  assert.equal(result.routing.domain, 'frontend');
  assert.match(result.routing.matchReason, /no-strength-match/);
});

test('selectProfileForTask falls back to defaultProfile when no costTier configured anywhere', () => {
  const config = makeConfig({
    a: { provider: 'p', model: 'ma', apiKeyEnv: 'K1', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], monthlyPlan: { currency: 'USD', amount: 0 } },
    b: { provider: 'p', model: 'mb', apiKeyEnv: 'K2', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], monthlyPlan: { currency: 'USD', amount: 0 } },
  }, 'b');
  const result = selectProfileForTask(config, makeTask());
  assert.equal(result.name, 'b');
});

test('selectProfileForTask soft-matches explicit task.domain even without keyword inference', () => {
  const config = makeConfig({
    cheapAlgo: { provider: 'p', model: 'm1', apiKeyEnv: 'K1', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'cheap', strengths: ['algorithm'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
    cheapDocs: { provider: 'p', model: 'm2', apiKeyEnv: 'K2', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'cheap', strengths: ['docs'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
  });
  const task = makeTask({ domain: 'docs' }); // low difficulty → cheap tier, explicit docs
  const result = selectProfileForTask(config, task);
  assert.equal(result.name, 'cheapDocs');
  assert.equal(result.routing.domainSource, 'explicit');
  assert.equal(result.routing.matchReason, 'strengths:docs');
});

test('selectProfileForTask returns null when no profiles and no defaultProfile', () => {
  const config = { defaultProfile: null, profiles: {} };
  const result = selectProfileForTask(config, makeTask());
  assert.equal(result, null);
});

test('selectProfileForTask exposes routing metadata for observability', () => {
  const config = makeConfig({
    cheap: { provider: 'p', model: 'm', apiKeyEnv: 'K', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'cheap', strengths: ['frontend'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
  });
  const result = selectProfileForTask(config, makeTask({ goal: 'Add a React component' }));
  assert.ok(result.routing);
  assert.equal(typeof result.routing.difficulty, 'string');
  assert.equal(typeof result.routing.difficultyScore, 'number');
  assert.ok(Array.isArray(result.routing.difficultySignals));
  assert.ok(Array.isArray(result.routing.candidatesConsidered));
  assert.equal(result.routing.candidatesConsidered[0], 'cheap');
});

test('selectProfileByDifficulty legacy entry still works', () => {
  const config = makeConfig({
    cheap: { provider: 'p', model: 'm', apiKeyEnv: 'K', capabilities: ['text', 'code'], fallbackProfiles: [], costTier: 'cheap' },
  });
  const result = selectProfileByDifficulty(config, 'low');
  assert.equal(result.name, 'cheap');
});

test('constants are stable', () => {
  assert.deepEqual(TASK_DOMAINS, ['frontend', 'backend', 'systems', 'algorithm', 'refactor', 'docs']);
  assert.deepEqual(MODALITIES, ['text', 'vision', 'image-output']);
  assert.deepEqual(COST_TIER_BY_DIFFICULTY, { low: 'cheap', medium: 'standard', high: 'premium' });
});

test('selectProfileForTask routes vision-input task to vision-capable profile', () => {
  const config = makeConfig({
    textOnly: { provider: 'p', model: 'm-text', apiKeyEnv: 'K1', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'cheap', strengths: ['backend'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
    visionPro: { provider: 'p', model: 'm-vision', apiKeyEnv: 'K2', capabilities: ['text', 'code', 'tool-use', 'vision-input'], fallbackProfiles: [], costTier: 'cheap', strengths: ['docs'], modalities: ['text', 'vision'], monthlyPlan: { currency: 'USD', amount: 0 } },
  });
  const task = makeTask({ requiredCapabilities: ['text', 'code', 'vision-input'], risk: 'low' });
  const result = selectProfileForTask(config, task);
  assert.equal(result.name, 'visionPro');
  assert.ok(result.modalities.includes('vision'));
});

test('selectProfileForTask routes image-output task to image-capable profile', () => {
  const config = makeConfig({
    textOnly: { provider: 'p', model: 'm-text', apiKeyEnv: 'K1', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'cheap', strengths: ['frontend'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
    imagePro: { provider: 'p', model: 'm-image', apiKeyEnv: 'K2', capabilities: ['text', 'code', 'tool-use', 'image-output'], fallbackProfiles: [], costTier: 'cheap', strengths: ['frontend'], modalities: ['text', 'image-output'], monthlyPlan: { currency: 'USD', amount: 0 } },
  });
  const task = makeTask({ requiredCapabilities: ['text', 'image-output'], risk: 'low' });
  const result = selectProfileForTask(config, task);
  assert.equal(result.name, 'imagePro');
  assert.ok(result.modalities.includes('image-output'));
});

test('selectProfileForTask returns null when no profile supports required vision modality', () => {
  const config = makeConfig({
    textOnly: { provider: 'p', model: 'm-text', apiKeyEnv: 'K1', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], costTier: 'cheap', strengths: ['backend'], modalities: ['text'], monthlyPlan: { currency: 'USD', amount: 0 } },
  });
  const task = makeTask({ requiredCapabilities: ['text', 'vision-input'], risk: 'low' });
  const result = selectProfileForTask(config, task);
  assert.equal(result, null, 'should return null so caller can report a setup blocker');
});
