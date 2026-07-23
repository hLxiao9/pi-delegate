import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { validateReviewResult, validateTaskContract, assertDelegableCapabilities } from '../lib/contracts.mjs';
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
    findings: [],
    verificationGaps: [],
    summary: 'Diff and independent checks satisfy the contract.',
  });
  assert.equal(review.verdict, 'approve');
});

test('visual requirements are rejected even when a profile advertises vision', () => {
  const task = validTask('/tmp/repo');
  task.requiredCapabilities.push('vision-input');
  assert.throws(
    () => assertDelegableCapabilities(task, { capabilities: ['text', 'code', 'tool-use', 'vision-input'] }),
    (error) => error.code === 'CAPABILITY_MISMATCH',
  );
});

test('approve reviews cannot contain blocking findings', () => {
  assert.throws(() => validateReviewResult({
    schemaVersion: 1,
    verdict: 'approve',
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
