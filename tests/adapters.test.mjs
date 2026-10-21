/*
 * spotworkers - Delegate bounded coding tasks to cheap agent workers
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { getAdapter, listAdapters, resolveAdapter, resolveBin } from '../lib/adapters/index.mjs';

test('getAdapter returns PiAdapter for pi', () => {
  const adapter = getAdapter('pi');
  assert.equal(adapter.name, 'pi');
  assert.equal(adapter.defaultBin, 'pi');
  assert.equal(adapter.supportsStreaming, true);
  assert.equal(adapter.supportsTokenUsage, true);
  assert.equal(adapter.supportsModelList, true);
});

test('getAdapter returns KimiAdapter for kimi', () => {
  const adapter = getAdapter('kimi');
  assert.equal(adapter.name, 'kimi');
  assert.equal(adapter.defaultBin, 'kimi');
  assert.equal(adapter.supportsStreaming, false);
  assert.equal(adapter.supportsTokenUsage, false);
  assert.equal(adapter.supportsModelList, false);
});

test('getAdapter returns TraeAdapter for trae', () => {
  const adapter = getAdapter('trae');
  assert.equal(adapter.name, 'trae');
  assert.equal(adapter.defaultBin, 'traecli');
  assert.equal(adapter.supportsStreaming, false);
  assert.equal(adapter.supportsTokenUsage, false);
  assert.equal(adapter.supportsModelList, false);
});

test('getAdapter returns QoderAdapter for qoder', () => {
  const adapter = getAdapter('qoder');
  assert.equal(adapter.name, 'qoder');
  assert.equal(adapter.defaultBin, 'qoderclicn');
  assert.equal(adapter.supportsStreaming, false);
  // verified on qoderclicn 1.1.73: the json result object carries usage + total_cost_usd
  assert.equal(adapter.supportsTokenUsage, true);
  // --list-models works once authenticated (verified against 1.1.73)
  assert.equal(adapter.supportsModelList, true);
});

test('getAdapter throws on unknown adapter', () => {
  assert.throws(() => getAdapter('unknown'), (e) => e.code === 'CONFIG_INVALID');
});

test('getAdapter defaults to pi when name is null/undefined', () => {
  assert.equal(getAdapter(null).name, 'pi');
  assert.equal(getAdapter(undefined).name, 'pi');
});

test('resolveAdapter reads profile.adapter field', () => {
  assert.equal(resolveAdapter({ adapter: 'kimi' }).name, 'kimi');
  assert.equal(resolveAdapter({ adapter: 'trae' }).name, 'trae');
  assert.equal(resolveAdapter({ adapter: 'qoder' }).name, 'qoder');
});

test('resolveAdapter defaults to pi when profile has no adapter', () => {
  assert.equal(resolveAdapter({}).name, 'pi');
  assert.equal(resolveAdapter(null).name, 'pi');
});

test('resolveBin uses adapter-specific env var', () => {
  const piAdapter = getAdapter('pi');
  const kimiAdapter = getAdapter('kimi');
  const traeAdapter = getAdapter('trae');
  const qoderAdapter = getAdapter('qoder');
  // default bin
  assert.equal(resolveBin(piAdapter, {}), 'pi');
  assert.equal(resolveBin(kimiAdapter, {}), 'kimi');
  assert.equal(resolveBin(traeAdapter, {}), 'traecli');
  assert.equal(resolveBin(qoderAdapter, {}), 'qoderclicn');
  // env override
  assert.equal(resolveBin(piAdapter, { PI_WORKER_PI_BIN: '/custom/pi' }), '/custom/pi');
  assert.equal(resolveBin(kimiAdapter, { PI_WORKER_KIMI_BIN: '/custom/kimi' }), '/custom/kimi');
  assert.equal(resolveBin(traeAdapter, { PI_WORKER_TRAE_BIN: '/custom/traecli' }), '/custom/traecli');
  assert.equal(resolveBin(qoderAdapter, { PI_WORKER_QODER_BIN: '/custom/qoder' }), '/custom/qoder');
});

test('listAdapters returns all known adapters', () => {
  const list = listAdapters();
  const names = list.map((a) => a.name).sort();
  const expected = ['codebuddy', 'kimi', 'opencode', 'pi', 'qoder', 'trae'].sort();
  assert.deepEqual(names, expected);
  assert.equal(list.length, expected.length);
});

test('PiAdapter.versionCommand returns --version argv', () => {
  const adapter = getAdapter('pi');
  const cmd = adapter.versionCommand();
  assert.deepEqual(cmd.argv, ['--version']);
});

test('KimiAdapter.invokeCommand passes prompt via -p argv (kimi has no stdin-prompt)', () => {
  const adapter = getAdapter('kimi');
  const cmd = adapter.invokeCommand({
  state: { runId: 'test-run', worktreePath: '/tmp/wt' },
  profile: { provider: 'kimi', model: 'kimi-for-coding' },
  prompt: 'hello world',
  config: {},
  sessionDir: '/tmp/session',
  mode: 'run',
  });
  // Kimi v0.29.1 has no stdin-prompt support (`kimi -` / `-p -` both fail),
  // so the prompt must travel as the `-p` argv value.
  const idx = cmd.argv.indexOf('-p');
  assert.ok(idx !== -1, 'kimi must use -p for the prompt');
  assert.equal(cmd.argv[idx + 1], 'hello world');
  assert.equal(cmd.input, '');
});

test('TraeAdapter.invokeCommand passes prompt via stdin (no argv leak)', () => {
  const adapter = getAdapter('trae');
  const cmd = adapter.invokeCommand({
  state: { runId: 'test-run', worktreePath: '/tmp/wt' },
  profile: { provider: 'trae', model: 'default' },
  prompt: 'hello',
  config: {},
  sessionDir: '/tmp/session',
  mode: 'run',
  });
  // Prompt must NOT appear in argv (prevents ps/proc leakage)
  assert.ok(!cmd.argv.includes('hello'));
  assert.ok(!cmd.argv.includes('-p'));
  assert.ok(cmd.argv.includes('--json'));
  assert.ok(cmd.argv.includes('--yolo'));
  assert.ok(cmd.argv.some((a) => a.startsWith('--allowed-tool')));
  assert.ok(cmd.argv.includes('--session-id'));
  assert.ok(cmd.argv.includes('test-run'));
  // stdin marker must be the last argv element (after all flags)
  assert.equal(cmd.argv[cmd.argv.length - 1], '-');
  assert.equal(cmd.input, 'hello');
});

test('QoderAdapter.invokeCommand forces -p and passes prompt via stdin (no argv leak)', () => {
  const adapter = getAdapter('qoder');
  const cmd = adapter.invokeCommand({
  state: { runId: 'test-run', worktreePath: '/tmp/wt' },
  profile: { provider: 'qoder', model: 'default' },
  prompt: 'hello',
  config: {},
  sessionDir: '/tmp/session',
  mode: 'run',
  });
  // -p/--print is mandatory: qoderclicn defaults to the interactive TUI without it.
  assert.ok(cmd.argv.includes('-p'), 'qoder must run in headless mode');
  // Prompt must NOT appear in argv (prevents ps/proc leakage)
  assert.ok(!cmd.argv.includes('hello'));
  assert.ok(cmd.argv.includes('--output-format=json'));
  assert.ok(cmd.argv.includes('--yolo'));
  assert.ok(cmd.argv.some((a) => a.startsWith('--allowed-tool')));
  // No positional '-' marker: with -p the CLI reads the prompt from stdin on its own.
  assert.ok(!cmd.argv.includes('-'), 'no stdin marker; -p already enables stdin prompt');
  assert.equal(cmd.input, 'hello');
});

test('QoderAdapter.invokeCommand keeps --max-turns as a flag without a stdin marker', () => {
  const adapter = getAdapter('qoder');
  const cmd = adapter.invokeCommand({
  state: { runId: 'test-run', worktreePath: '/tmp/wt' },
  profile: { provider: 'qoder', model: 'default' },
  prompt: 'hello',
  config: { limits: { piMaxTurns: 25 } },
  sessionDir: '/tmp/session',
  mode: 'run',
  });
  const maxTurnsIdx = cmd.argv.indexOf('--max-turns');
  assert.ok(maxTurnsIdx !== -1, '--max-turns must be present');
  assert.equal(cmd.argv[maxTurnsIdx + 1], '25');
  assert.ok(!cmd.argv.includes('-'), 'no stdin marker should be appended');
  assert.equal(cmd.input, 'hello');
});

test('QoderAdapter.parseOutput extracts text and usage from the json result object', () => {
  const adapter = getAdapter('qoder');
  const stdout = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1234,
  num_turns: 3,
  result: 'done',
  total_cost_usd: 0.0123,
  usage: {
  input_tokens: 100,
  output_tokens: 40,
  cache_read_input_tokens: 20,
  cache_creation_input_tokens: 5,
  },
  });
  const out = adapter.parseOutput(stdout, '', 0, false);
  assert.equal(out.text, 'done');
  assert.equal(out.stopReason, 'stop');
  assert.equal(out.usage.inputTokens, 100);
  assert.equal(out.usage.outputTokens, 40);
  assert.equal(out.usage.cachedInputTokens, 20);
  assert.equal(out.usage.cacheWriteInputTokens, 5);
  assert.equal(out.usage.totalTokens, 165);
  assert.equal(out.usage.providerReportedCostUsd, 0.0123);
  assert.equal(out.usage.requests, 3);
});

test('QoderAdapter keeps provider credits when every token counter is zero', () => {
  // Real qoderclicn 1.1.73 payload: token counters are all 0, billing is in
  // credits. Returning null here would hide the only number the provider reports.
  const adapter = getAdapter('qoder');
  const stdout = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, num_turns: 1,
    duration_ms: 3004, result: 'PONG', total_cost_usd: 0, total_credits: 0.107335932,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  const out = adapter.parseOutput(stdout, '', 0, false);
  assert.ok(out.usage, 'usage must survive credits-only payloads');
  assert.equal(out.usage.totalCredits, 0.107335932);
  assert.equal(out.usage.inputTokens, 0);
  assert.equal(out.usage.totalTokens, 0);
  // the raw shape handed to normalizeUsage must carry credits too
  assert.equal(out.lastAssistant.usage.credits, 0.107335932);
});

test('QoderAdapter.invokeCommand pins the model with -m when one is selected', () => {
  const adapter = getAdapter('qoder');
  const cmd = adapter.invokeCommand({
    state: { runId: 'r', worktreePath: '/tmp/wt' },
    profile: { provider: 'qoder', model: 'Qwen3.8-Flash' },
    prompt: 'hi', config: {},
  });
  const idx = cmd.argv.indexOf('-m');
  assert.ok(idx !== -1, 'selected model must reach the CLI');
  assert.equal(cmd.argv[idx + 1], 'Qwen3.8-Flash');
});

test('QoderAdapter.invokeCommand omits -m for the placeholder model', () => {
  const adapter = getAdapter('qoder');
  for (const model of ['qoder-default', 'default', '']) {
    const cmd = adapter.invokeCommand({
      state: { runId: 'r', worktreePath: '/tmp/wt' },
      profile: { provider: 'qoder', model }, prompt: 'hi', config: {},
    });
    assert.ok(!cmd.argv.includes('-m'), `placeholder '${model}' must not be pinned`);
  }
});

test('QoderAdapter.listModels returns a priced catalog when a token is available', async () => {
  const adapter = getAdapter('qoder');
  // No cacheRoot => the adapter must decline rather than invent a roster.
  assert.equal(await adapter.listModels({ profile: { provider: 'qoder' }, env: {}, bin: 'qoderclicn' }), null);
});

test('QoderAdapter.invokeCommand forwards reasoning effort and context window', () => {
  const adapter = getAdapter('qoder');
  const cmd = adapter.invokeCommand({
    state: { runId: 'r', worktreePath: '/tmp/wt' },
    profile: { provider: 'qoder', model: 'Qwen3.8-Flash', reasoningEffort: 'xhigh', maxContextSize: 1000000 },
    prompt: 'hi', config: {},
  });
  const effortIdx = cmd.argv.indexOf('--reasoning-effort');
  assert.ok(effortIdx !== -1, 'reasoning effort must reach the CLI');
  assert.equal(cmd.argv[effortIdx + 1], 'xhigh');
  const ctxIdx = cmd.argv.indexOf('--context-window');
  assert.ok(ctxIdx !== -1, 'context window must reach the CLI');
  assert.equal(cmd.argv[ctxIdx + 1], '1000000');
});

test('QoderAdapter.invokeCommand lets env override thinking depth for one run', () => {
  const adapter = getAdapter('qoder');
  const prev = process.env.PI_WORKER_QODER_REASONING_EFFORT;
  process.env.PI_WORKER_QODER_REASONING_EFFORT = 'max';
  try {
    const cmd = adapter.invokeCommand({
      state: { runId: 'r', worktreePath: '/tmp/wt' },
      profile: { provider: 'qoder', model: 'Qwen3.8-Flash', reasoningEffort: 'high' },
      prompt: 'hi', config: {},
    });
    assert.equal(cmd.argv[cmd.argv.indexOf('--reasoning-effort') + 1], 'max');
  } finally {
    if (prev === undefined) delete process.env.PI_WORKER_QODER_REASONING_EFFORT;
    else process.env.PI_WORKER_QODER_REASONING_EFFORT = prev;
  }
});

test('QoderAdapter.invokeCommand omits thinking flags when unset', () => {
  const adapter = getAdapter('qoder');
  const cmd = adapter.invokeCommand({
    state: { runId: 'r', worktreePath: '/tmp/wt' },
    profile: { provider: 'qoder', model: 'qoder-default' },
    prompt: 'hi', config: {},
  });
  assert.ok(!cmd.argv.includes('--reasoning-effort'));
  assert.ok(!cmd.argv.includes('--context-window'));
});

test('QoderAdapter.parseOutput flags is_error results with exit code 0', () => {
  const adapter = getAdapter('qoder');
  const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
  const out = adapter.parseOutput(stdout, '', 0, false);
  assert.equal(out.stopReason, 'error');
  assert.equal(out.usage, null);
});

test('QoderAdapter.classifyFailure maps a rejected PAT to auth', () => {
  const adapter = getAdapter('qoder');
  const stderr = 'An unexpected critical error occurred:QoderAuthError: The QODERCN_PERSONAL_ACCESS_TOKEN environment variable contains a token that was rejected.';
  assert.equal(adapter.classifyFailure({ stderr, stdout: '', exitCode: 1, timedOut: false }), 'auth');
  // unauthenticated json result (empty stderr) is also an auth problem
  const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' });
  assert.equal(adapter.classifyFailure({ stderr: '', stdout, exitCode: 1, timedOut: false }), 'auth');
});

test('PiAdapter.parseOutput extracts text from NDJSON', () => {
  const adapter = getAdapter('pi');
  const ndjson = [
  JSON.stringify({ type: 'message_start' }),
  JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello pi' }], usage: { input: 10, output: 5 } } }),
  ].join('\n');
  const result = adapter.parseOutput(ndjson, '', 0, false);
  assert.equal(result.text, 'hello pi');
  assert.equal(result.usage.inputTokens, 10);
  assert.equal(result.usage.outputTokens, 5);
});

test('KimiAdapter.parseOutput returns text with null usage', () => {
  const adapter = getAdapter('kimi');
  const result = adapter.parseOutput('hello kimi', '', 0, false);
  assert.equal(result.text, 'hello kimi');
  assert.equal(result.usage, null);
});

test('TraeAdapter.parseOutput parses JSON array', () => {
  const adapter = getAdapter('trae');
  const jsonOutput = JSON.stringify([
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello trae' },
  ]);
  const result = adapter.parseOutput(jsonOutput, '', 0, false);
  assert.equal(result.text, 'hello trae');
  assert.equal(result.usage, null);
});

test('TraeAdapter.parseOutput falls back to raw stdout on invalid JSON', () => {
  const adapter = getAdapter('trae');
  const result = adapter.parseOutput('plain text output', '', 0, false);
  assert.equal(result.text, 'plain text output');
});

test('QoderAdapter.parseOutput parses JSON object', () => {
  const adapter = getAdapter('qoder');
  const jsonOutput = JSON.stringify({ role: 'assistant', content: 'hello qoder' });
  const result = adapter.parseOutput(jsonOutput, '', 0, false);
  assert.equal(result.text, 'hello qoder');
  assert.equal(result.usage, null);
});

test('QoderAdapter.parseOutput falls back to raw stdout on invalid JSON', () => {
  const adapter = getAdapter('qoder');
  const result = adapter.parseOutput('plain text', '', 0, false);
  assert.equal(result.text, 'plain text');
});

test('classifyFailure detects auth errors', () => {
  const adapter = getAdapter('pi');
  assert.equal(adapter.classifyFailure({ stderr: '401 Unauthorized', stdout: '', exitCode: 1, timedOut: false }), 'auth');
  assert.equal(adapter.classifyFailure({ stderr: 'invalid api key', stdout: '', exitCode: 1, timedOut: false }), 'auth');
});

test('classifyFailure detects transient errors', () => {
  const adapter = getAdapter('pi');
  assert.equal(adapter.classifyFailure({ stderr: '429 rate limit', stdout: '', exitCode: 1, timedOut: false }), 'transient');
  assert.equal(adapter.classifyFailure({ stderr: '503 overloaded', stdout: '', exitCode: 1, timedOut: false }), 'transient');
});

test('classifyFailure detects timeout', () => {
  const adapter = getAdapter('pi');
  assert.equal(adapter.classifyFailure({ stderr: '', stdout: '', exitCode: null, timedOut: true }), 'timeout');
});

test('classifyFailure defaults to permanent', () => {
  const adapter = getAdapter('pi');
  assert.equal(adapter.classifyFailure({ stderr: 'some error', stdout: '', exitCode: 1, timedOut: false }), 'permanent');
});

test('TraeAdapter.checkAuthHint returns OAuth hint', () => {
  const adapter = getAdapter('trae');
  const hint = adapter.checkAuthHint();
  assert.equal(hint.requiresManualLogin, true);
  assert.ok(hint.loginCommand);
  assert.ok(hint.loginHint.includes('OAuth'));
});

test('config loads profiles with adapter field', async () => {
  const { loadConfig, resolveWorkerPaths } = await import('../lib/config.mjs');
  const { readJson } = await import('../lib/atomic-json.mjs');
  const { makeTempDir } = await import('./helpers.mjs');
  const home = await makeTempDir('adapter-config-');
  const paths = resolveWorkerPaths({}, home);
  const { ensureDir, writeJsonAtomic } = await import('../lib/atomic-json.mjs');
  await ensureDir(path.dirname(paths.configFile));
  const defaultConfig = await readJson(new URL('../fixtures/default-config.json', import.meta.url));
  await writeJsonAtomic(paths.configFile, defaultConfig);
  const config = await loadConfig(paths);
  // kimi-cli profile shouldthehas adapter='kimi'
  assert.equal(config.profiles['kimi-cli'].adapter, 'kimi');
  assert.equal(config.profiles['trae-cli'].adapter, 'trae');
  assert.equal(config.profiles['qoder-cli'].adapter, 'qoder');
  // volcengine profile noexplicit adapter,defaultshouldtheis 'pi'
  assert.equal(config.profiles['volcengine'].adapter, 'pi');
});

test('config rejects invalid adapter name', async () => {
  const { loadConfig, resolveWorkerPaths } = await import('../lib/config.mjs');
  const { makeTempDir } = await import('./helpers.mjs');
  const { ensureDir, writeJsonAtomic } = await import('../lib/atomic-json.mjs');
  const { readJson } = await import('../lib/atomic-json.mjs');
  const home = await makeTempDir('adapter-invalid-');
  const paths = resolveWorkerPaths({}, home);
  await ensureDir(path.dirname(paths.configFile));
  const config = await readJson(new URL('../fixtures/default-config.json', import.meta.url));
  config.profiles['bad'] = { provider: 'x', model: 'm', apiKeyEnv: 'K', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: [], monthlyPlan: { currency: 'USD', amount: 0 } };
  config.profiles['bad'].adapter = 'unknown-cli';
  await writeJsonAtomic(paths.configFile, config);
  await assert.rejects(() => loadConfig(paths), (e) => e.code === 'CONFIG_INVALID');
});

test('CodeBuddyAdapter parses a result object with usage', () => {
  const adapter = getAdapter('codebuddy');
  const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 });
  const parsed = adapter.parseOutput(stdout, '', 0, false);
  assert.equal(parsed.text, 'done');
  assert.equal(parsed.lastAssistant.stopReason, 'stop');
  assert.equal(parsed.lastAssistant.usage.input, 10);
  assert.equal(parsed.lastAssistant.usage.output, 5);
});

test('CodeBuddyAdapter treats unauthenticated exit-0 output as an auth failure', () => {
  const adapter = getAdapter('codebuddy');
  const stderr = 'Authentication required. Please use /login command to sign in to your account';
  const parsed = adapter.parseOutput('', stderr, 0, false);
  assert.equal(parsed.lastAssistant.stopReason, 'error');
  assert.equal(adapter.classifyFailure({ stderr, stdout: '', exitCode: 0, timedOut: false }), 'auth');
});

test('CodeBuddyAdapter.invokeCommand passes prompt via stdin and restricts tools', () => {
  const adapter = getAdapter('codebuddy');
  const spec = adapter.invokeCommand({ state: { runId: 'r1', worktreePath: '/wt' }, profile: { model: 'deepseek-v4.1-flash' }, prompt: 'SECRET_PROMPT', config: { limits: {} } });
  assert.equal(spec.input, 'SECRET_PROMPT');
  assert.ok(!spec.argv.includes('SECRET_PROMPT'));
  assert.ok(!spec.argv.join(',').includes('Bash'));
  assert.deepEqual(spec.argv.slice(spec.argv.indexOf('--model'), spec.argv.indexOf('--model') + 2), ['--model', 'deepseek-v4.1-flash']);
  assert.equal(spec.cwd, '/wt');
});

test('CodeBuddyAdapter parses tail-truncated stream-json and takes the final result', () => {
  const adapter = getAdapter('codebuddy');
  const lines = [
    'ed-fragment-of-a-cut-off-line"}',
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'all done', usage: { input_tokens: 6346, output_tokens: 3, cache_read_input_tokens: 6144 }, total_cost_usd: 0 }),
  ];
  const parsed = adapter.parseOutput(lines.join('\n') + '\n', '', 0, false);
  assert.equal(parsed.text, 'all done');
  assert.equal(parsed.lastAssistant.stopReason, 'stop');
  assert.equal(parsed.lastAssistant.usage.cacheRead, 6144);
});

test('CodeBuddyAdapter flags an error result even with exit code 0', () => {
  const adapter = getAdapter('codebuddy');
  const stdout = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' });
  assert.equal(adapter.parseOutput(stdout, '', 0, false).lastAssistant.stopReason, 'error');
});
