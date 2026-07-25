import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installDefaultConfiguration, resolveWorkerPaths } from '../lib/config.mjs';
import { makeTempDir, initGitRepo, runNode, runProcess, writeExecutable } from './helpers.mjs';

export const skillRoot = path.resolve(new URL('..', import.meta.url).pathname);
export const cli = path.join(skillRoot, 'scripts', 'pi-worker.mjs');

export async function createReviewedFixture({ dirty = false } = {}) {
  const home = await makeTempDir('pi-workflow-home-');
  const repositoryRoot = await initGitRepo(path.join(home, 'source'));
  if (dirty) await writeFile(path.join(repositoryRoot, 'README.md'), '# uncommitted user work\n');
  const threadId = `019f8c7b-e659-7463-${Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12)}`;
  const codexSessionDirectory = path.join(home, '.codex', 'sessions', '2026', '07', '23');
  await mkdir(codexSessionDirectory, { recursive: true });
  const codexSessionFile = path.join(codexSessionDirectory, `rollout-test-${threadId}.jsonl`);
  await writeFile(codexSessionFile, `${JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 800,
          cache_write_input_tokens: 0,
          output_tokens: 100,
          reasoning_output_tokens: 0,
          total_tokens: 1100,
        },
      },
    },
  })}\n`);
  const paths = resolveWorkerPaths({}, home);
  await installDefaultConfiguration({ paths });
  // workflow-fixture drives prepare/run/verify/approve directly; skip the self-review stage so verify -> reviewing.
  const cfg = JSON.parse(await readFile(paths.configFile, 'utf8'));
  cfg.selfReview = { enabled: false };
  await writeFile(paths.configFile, JSON.stringify(cfg));
  const pi = path.join(home, 'bin', 'pi');
  await writeExecutable(pi, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.80.10'); process.exit(0); }
if (args.includes('--list-models')) { console.log('volcengine-plan/ark-code-latest'); process.exit(0); }
mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
writeFileSync(path.join(process.cwd(), 'src', 'answer.js'), 'export const answer = 42;\\n');
console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider: 'volcengine-plan', model: 'ark-code-latest', stopReason: 'stop', content: [], usage: { input: 120, output: 30, cacheRead: 20, cacheWrite: 0, totalTokens: 170, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
`);
  const head = (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
  const runId = `workflow-${dirty ? 'dirty' : 'clean'}-${Math.random().toString(16).slice(2)}`;
  const taskFile = path.join(home, 'task.json');
  await writeFile(taskFile, JSON.stringify({
    schemaVersion: 1,
    runId,
    repositoryRoot,
    baseRevision: head,
    goal: 'Create the independently verified answer module',
    allowedPaths: ['src/**', 'tests/**'],
    forbiddenPaths: ['.env*', '.git/**'],
    constraints: ['Do not change existing user files'],
    acceptanceCriteria: ['src/answer.js exports answer=42'],
    verification: [{ argv: [process.execPath, '-e', "import('./src/answer.js').then(m=>process.exit(m.answer===42?0:1))"], timeoutSeconds: 10, env: { CI: '1' } }],
    requiredCapabilities: ['text', 'code', 'tool-use'],
    risk: 'medium',
  }));
  const env = {
    ...process.env,
    HOME: home,
    PI_WORKER_CONFIG: paths.configFile,
    PI_WORKER_MODELS_FILE: paths.modelsFile,
    PI_WORKER_STATE_DIR: paths.stateRoot,
    PI_WORKER_CACHE_DIR: paths.cacheRoot,
    PI_WORKER_PI_BIN: pi,
    CODEX_THREAD_ID: threadId,
    VOLCENGINE_API_KEY: 'test-key-not-real',
  };
  const prepared = await runNode(cli, ['prepare', '--task', taskFile], { env });
  assert.equal(prepared.code, 0, prepared.stderr);
  const run = await runNode(cli, ['run', '--id', runId], { env });
  assert.equal(run.code, 0, run.stderr);
  const verified = await runNode(cli, ['verify', '--id', runId], { env });
  assert.equal(verified.code, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).passed, true);
  const verification = JSON.parse(await readFile(path.join(paths.stateRoot, 'runs', runId, 'verification.json'), 'utf8'));
  const reviewFile = path.join(home, 'approve-review.json');
  await writeFile(reviewFile, JSON.stringify({
    schemaVersion: 1,
    verdict: 'approve',
    diffSha256: verification.security.diffSha256,
    findings: [],
    verificationGaps: [],
    summary: 'The actual diff is scoped, correct, and independently verified.',
  }));
  return {
    home,
    repositoryRoot,
    paths,
    env,
    runId,
    reviewFile,
    worktree: JSON.parse(prepared.stdout).worktreePath,
    sourceHead: head,
    codexSessionFile,
  };
}

export async function readState(item) {
  return JSON.parse(await readFile(path.join(item.paths.stateRoot, 'runs', item.runId, 'state.json'), 'utf8'));
}
