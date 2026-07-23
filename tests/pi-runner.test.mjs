import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { installDefaultConfiguration, resolveWorkerPaths } from '../lib/config.mjs';
import { makeTempDir, initGitRepo, runNode, runProcess, writeExecutable } from './helpers.mjs';

const skillRoot = path.resolve(new URL('..', import.meta.url).pathname);
const cli = path.join(skillRoot, 'scripts', 'pi-worker.mjs');

function fakePiSource(mode) {
  return `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.80.10'); process.exit(0); }
if (args.includes('--list-models')) { console.log('volcengine-plan/ark-code-latest'); process.exit(0); }
const provider = args[args.indexOf('--provider') + 1];
const modelName = args[args.indexOf('--model') + 1];
mkdirSync(process.env.HOME, { recursive: true });
writeFileSync(path.join(process.env.HOME, 'argv.json'), JSON.stringify(args));
writeFileSync(path.join(process.env.HOME, 'env.json'), JSON.stringify(Object.keys(process.env).sort()));
const mode = ${JSON.stringify(mode)};
const counterFile = path.join(process.env.HOME, 'counter');
let count = 0;
try { count = Number(readFileSync(counterFile, 'utf8')); } catch {}
writeFileSync(counterFile, String(count + 1));
if (mode === 'transient-once' && count === 0) { console.error('429 rate limit'); process.exit(1); }
if (mode === 'fallback' && provider === 'volcengine-plan') { console.error('503 overloaded'); process.exit(1); }
if (mode.startsWith('auth')) { console.error('401 invalid api key'); process.exit(1); }
mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
writeFileSync(path.join(process.cwd(), 'src', 'generated.js'), 'export const generated = true;\\n');
console.log(JSON.stringify({ type: 'session', version: 3, id: 'fake', cwd: process.cwd() }));
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider, model: modelName, stopReason: 'stop', content: [{ type: 'text', text: 'implemented' }], usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 0, totalTokens: 160, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
console.log(JSON.stringify({ type: 'agent_end', messages: [] }));
`;
}

async function preparedFixture(mode = 'success') {
  const home = await makeTempDir('pi-run-home-');
  const repositoryRoot = await initGitRepo(path.join(home, 'source'));
  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  const config = JSON.parse(await readFile(paths.configFile, 'utf8'));
  config.retryDelaysMs = [0];
  if (mode === 'fallback' || mode === 'auth-with-fallback') {
    config.profiles.volcengine.fallbackProfiles = ['backup'];
    config.profiles.backup = {
      provider: 'backup-plan', model: 'backup-code', thinking: 'high', apiKeyEnv: 'BACKUP_API_KEY',
      capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], monthlyPlan: { currency: 'CNY', amount: 0 },
    };
    const models = JSON.parse(await readFile(paths.modelsFile, 'utf8'));
    models.providers['backup-plan'] = {
      baseUrl: 'https://backup.example.invalid/v1', api: 'openai-completions', apiKey: '$BACKUP_API_KEY',
      models: [{ id: 'backup-code', input: ['text'] }],
    };
    await writeFile(paths.modelsFile, JSON.stringify(models));
  }
  await writeFile(paths.configFile, JSON.stringify(config));
  const pi = path.join(home, 'bin', 'pi');
  await writeExecutable(pi, fakePiSource(mode));
  const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const runId = `pi-${mode}`;
  const taskFile = path.join(home, 'task.json');
  await writeFile(taskFile, JSON.stringify({
    schemaVersion: 1, runId, repositoryRoot, baseRevision: head,
    goal: 'Create the generated module required by the fixture', allowedPaths: ['src/**', 'tests/**'],
    forbiddenPaths: ['.env*', '.git/**'], constraints: ['Do not modify repository metadata'],
    acceptanceCriteria: ['src/generated.js exports generated=true'],
    verification: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutSeconds: 10, env: {} }],
    requiredCapabilities: ['text', 'code', 'tool-use'], risk: 'medium',
  }));
  const env = {
    ...process.env, HOME: home, PI_WORKER_CONFIG: paths.configFile, PI_WORKER_MODELS_FILE: paths.modelsFile,
    PI_WORKER_STATE_DIR: paths.stateRoot, PI_WORKER_CACHE_DIR: paths.cacheRoot, PI_WORKER_PI_BIN: pi,
    VOLCENGINE_API_KEY: 'test-key-not-real', BACKUP_API_KEY: 'test-backup-key-not-real', UNRELATED_SECRET: 'must-not-reach-pi',
  };
  const prepared = await runNode(cli, ['prepare', '--task', taskFile], { env });
  assert.equal(prepared.code, 0, prepared.stderr);
  return { paths, env, runId };
}

test('run uses JSON mode, no Bash, no auto-loaded resources, and a sanitized env', async () => {
  const fixture = await preparedFixture();
  const result = await runNode(cli, ['run', '--id', fixture.runId], { env: fixture.env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'verifying');
  const runDir = path.join(fixture.paths.stateRoot, 'runs', fixture.runId);
  const piHome = path.join(runDir, 'pi-home');
  const argv = JSON.parse(await readFile(path.join(piHome, 'argv.json'), 'utf8'));
  assert.deepEqual(argv.slice(argv.indexOf('--tools') + 1, argv.indexOf('--tools') + 2), ['read,grep,find,ls,edit,write']);
  for (const flag of ['--mode', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve']) assert.ok(argv.includes(flag), flag);
  assert.ok(!argv.join(' ').includes('bash'));
  const envNames = JSON.parse(await readFile(path.join(piHome, 'env.json'), 'utf8'));
  assert.ok(envNames.includes('VOLCENGINE_API_KEY'));
  assert.ok(!envNames.includes('BACKUP_API_KEY'));
  assert.ok(!envNames.includes('UNRELATED_SECRET'));
  assert.match(await readFile(path.join(runDir, 'pi-events.jsonl'), 'utf8'), /message_end/);
});

test('transient provider failure retries once and then succeeds', async () => {
  const fixture = await preparedFixture('transient-once');
  const result = await runNode(cli, ['run', '--id', fixture.runId], { env: fixture.env });
  assert.equal(result.code, 0, result.stderr);
  const count = await readFile(path.join(fixture.paths.stateRoot, 'runs', fixture.runId, 'pi-home', 'counter'), 'utf8');
  assert.equal(count, '2');
});

test('exhausted transient retries use at most one configured fallback', async () => {
  const fixture = await preparedFixture('fallback');
  const result = await runNode(cli, ['run', '--id', fixture.runId], { env: fixture.env });
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.fallbackUsed, true);
  assert.equal(payload.provider, 'backup-plan');
  const count = await readFile(path.join(fixture.paths.stateRoot, 'runs', fixture.runId, 'pi-home', 'counter'), 'utf8');
  assert.equal(count, '3');
  const envNames = JSON.parse(await readFile(path.join(fixture.paths.stateRoot, 'runs', fixture.runId, 'pi-home', 'env.json'), 'utf8'));
  assert.ok(envNames.includes('BACKUP_API_KEY'));
  assert.ok(!envNames.includes('VOLCENGINE_API_KEY'));
});

test('authentication failure stops immediately and blocks the run', async () => {
  const fixture = await preparedFixture('auth-with-fallback');
  const result = await runNode(cli, ['run', '--id', fixture.runId], { env: fixture.env });
  assert.equal(result.code, 1);
  const state = JSON.parse(await readFile(path.join(fixture.paths.stateRoot, 'runs', fixture.runId, 'state.json'), 'utf8'));
  assert.equal(state.status, 'blocked');
  const count = await readFile(path.join(fixture.paths.stateRoot, 'runs', fixture.runId, 'pi-home', 'counter'), 'utf8');
  assert.equal(count, '1');
});
