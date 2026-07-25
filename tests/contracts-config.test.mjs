import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { validateReviewResult, validateTaskContract, assertDelegableCapabilities, validateProfileFields } from '../lib/contracts.mjs';
import { installDefaultConfiguration, resolveWorkerPaths } from '../lib/config.mjs';
import { makeTempDir } from './helpers.mjs';

function validTask(root) {
  return {
    schemaVersion: 1,
    runId: '20260723-contract-test',
    repositoryRoot: root,
    baseRevision: 'a'.repeat(40),
    goal: 'Add a deterministic parser',
    allowedPaths: ['src/**', 'tests/**'],
    forbiddenPaths: ['.env*', '.git/**'],
    constraints: ['Keep public API compatible'],
    acceptanceCriteria: ['All parser tests pass'],
    verification: [{ argv: ['npm', 'test'], timeoutSeconds: 900, env: { CI: '1' } }],
    requiredCapabilities: ['text', 'code', 'tool-use'],
    risk: 'medium',
  };
}

test('task and approve review contracts normalize valid inputs', () => {
  const task = validateTaskContract(validTask('/tmp/repo'));
  assert.equal(task.schemaVersion, 1);
  const review = validateReviewResult({
    schemaVersion: 1,
    verdict: 'approve',
    diffSha256: 'a'.repeat(64),
    findings: [],
    verificationGaps: [],
    summary: 'Diff and independent checks satisfy the contract.',
  });
  assert.equal(review.verdict, 'approve');
});

test('vision-input is delegated when profile has vision capability + modality', () => {
  const task = validTask('/tmp/repo');
  task.requiredCapabilities.push('vision-input');
  // profile 声明 vision-input capability 且 modalities 含 vision → 通过
  assertDelegableCapabilities(task, { capabilities: ['text', 'code', 'tool-use', 'vision-input'], modalities: ['text', 'vision'] });
});

test('vision-input is rejected when profile lacks vision modality', () => {
  const task = validTask('/tmp/repo');
  task.requiredCapabilities.push('vision-input');
  // profile 有 vision-input capability 但 modalities 不含 vision → 拒绝
  assert.throws(
    () => assertDelegableCapabilities(task, { capabilities: ['text', 'code', 'tool-use', 'vision-input'], modalities: ['text'] }),
    (error) => error.code === 'CAPABILITY_MISMATCH',
  );
});

test('image-output is delegated when profile has image-output capability + modality', () => {
  const task = validTask('/tmp/repo');
  task.requiredCapabilities.push('image-output');
  assertDelegableCapabilities(task, { capabilities: ['text', 'code', 'tool-use', 'image-output'], modalities: ['text', 'image-output'] });
});

test('image-output is rejected when profile lacks image-output modality', () => {
  const task = validTask('/tmp/repo');
  task.requiredCapabilities.push('image-output');
  assert.throws(
    () => assertDelegableCapabilities(task, { capabilities: ['text', 'code', 'tool-use', 'image-output'], modalities: ['text'] }),
    (error) => error.code === 'CAPABILITY_MISMATCH',
  );
});

test('approve reviews cannot contain blocking findings', () => {
  assert.throws(() => validateReviewResult({
    schemaVersion: 1,
    verdict: 'approve',
    diffSha256: 'a'.repeat(64),
    findings: [{
      priority: 'P2',
      file: 'src/a.js',
      line: 1,
      problem: 'Missing bounds check',
      evidence: 'Negative input reaches array access',
      requiredChange: 'Reject negative input',
    }],
    verificationGaps: [],
    summary: 'Incorrect approval',
  }), (error) => error.code === 'REVIEW_INVALID');
});

test('installer preserves existing Pi providers and existing worker config', async () => {
  const home = await makeTempDir('pi-config-');
  const paths = resolveWorkerPaths({}, home);
  await mkdir(path.dirname(paths.modelsFile), { recursive: true });
  await writeFile(paths.modelsFile, JSON.stringify({ providers: { existing: { baseUrl: 'https://example.invalid', api: 'openai-completions', models: [{ id: 'kept' }] } } }));
  await mkdir(path.dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, JSON.stringify({ schemaVersion: 1, marker: 'keep-me', limits: { piTimeoutSeconds: 777 } }));
  await installDefaultConfiguration({ paths });
  const models = JSON.parse(await readFile(paths.modelsFile, 'utf8'));
  const config = JSON.parse(await readFile(paths.configFile, 'utf8'));
  assert.equal(models.providers.existing.models[0].id, 'kept');
  assert.equal(models.providers['volcengine-plan'].models[0].id, 'ark-code-latest');
  assert.equal(config.marker, 'keep-me');
  assert.equal(config.limits.piTimeoutSeconds, 777);
  assert.equal(config.limits.maxChangedFiles, 80);
  assert.equal(config.maxRevisionRounds, 2);
});

test('installer preserves an existing Volcengine provider and adds only missing defaults', async () => {
  const home = await makeTempDir('pi-existing-volc-');
  const paths = resolveWorkerPaths({}, home);
  await mkdir(path.dirname(paths.modelsFile), { recursive: true });
  await writeFile(paths.modelsFile, JSON.stringify({
    providers: {
      'volcengine-plan': {
        baseUrl: 'https://user-proxy.example.invalid/v1',
        api: 'openai-completions',
        apiKey: '$VOLCENGINE_API_KEY',
        headers: { 'x-user-route': 'kept' },
        models: [{ id: 'user-model', input: ['text'] }]
      }
    }
  }));
  await installDefaultConfiguration({ paths });
  const provider = JSON.parse(await readFile(paths.modelsFile, 'utf8')).providers['volcengine-plan'];
  assert.equal(provider.baseUrl, 'https://user-proxy.example.invalid/v1');
  assert.equal(provider.headers['x-user-route'], 'kept');
  assert.deepEqual(provider.models.map((model) => model.id), ['user-model', 'ark-code-latest']);
});

test('task contract accepts optional domain field', () => {
  const task = validTask('/tmp/repo');
  task.domain = 'frontend';
  const validated = validateTaskContract(task);
  assert.equal(validated.domain, 'frontend');
});

test('task contract rejects unknown domain value', () => {
  const task = validTask('/tmp/repo');
  task.domain = 'mobile'; // not in ALLOWED_DOMAINS
  assert.throws(() => validateTaskContract(task), (error) => error.code === 'CONTRACT_INVALID');
});

test('task contract without domain defaults to null', () => {
  const validated = validateTaskContract(validTask('/tmp/repo'));
  assert.equal(validated.domain, null);
});

test('validateProfileFields accepts valid strengths and modalities', () => {
  validateProfileFields({ strengths: ['frontend', 'backend'], modalities: ['text', 'vision'] }, 'ok-profile');
  validateProfileFields({}, 'empty-profile'); // both optional
});

test('validateProfileFields rejects unknown strengths value', () => {
  assert.throws(
    () => validateProfileFields({ strengths: ['frontend', 'mobile'] }, 'bad-profile'),
    (error) => error.code === 'CONFIG_INVALID',
  );
});

test('validateProfileFields rejects unknown modalities value', () => {
  assert.throws(
    () => validateProfileFields({ modalities: ['text', 'audio'] }, 'bad-profile'),
    (error) => error.code === 'CONFIG_INVALID',
  );
});
