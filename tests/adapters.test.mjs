/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
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
  assert.equal(adapter.supportsTokenUsage, false);
  assert.equal(adapter.supportsModelList, false);
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

test('listAdapters returns all 4 adapters', () => {
  const list = listAdapters();
  assert.equal(list.length, 4);
  const names = list.map((a) => a.name).sort();
  assert.deepEqual(names, ['kimi', 'pi', 'qoder', 'trae']);
});

test('PiAdapter.versionCommand returns --version argv', () => {
  const adapter = getAdapter('pi');
  const cmd = adapter.versionCommand();
  assert.deepEqual(cmd.argv, ['--version']);
});

test('KimiAdapter.invokeCommand returns -p prompt argv', () => {
  const adapter = getAdapter('kimi');
  const cmd = adapter.invokeCommand({
  state: { runId: 'test-run', worktreePath: '/tmp/wt' },
  profile: { provider: 'kimi', model: 'kimi-for-coding' },
  prompt: 'hello world',
  config: {},
  sessionDir: '/tmp/session',
  mode: 'run',
  });
  assert.deepEqual(cmd.argv, ['-p', 'hello world']);
  assert.equal(cmd.input, null);
});

test('TraeAdapter.invokeCommand returns -p --json --yolo argv', () => {
  const adapter = getAdapter('trae');
  const cmd = adapter.invokeCommand({
  state: { runId: 'test-run', worktreePath: '/tmp/wt' },
  profile: { provider: 'trae', model: 'default' },
  prompt: 'hello',
  config: {},
  sessionDir: '/tmp/session',
  mode: 'run',
  });
  assert.ok(cmd.argv.includes('-p'));
  assert.ok(cmd.argv.includes('hello'));
  assert.ok(cmd.argv.includes('--json'));
  assert.ok(cmd.argv.includes('--yolo'));
  assert.ok(cmd.argv.some((a) => a.startsWith('--allowed-tool')));
  assert.ok(cmd.argv.includes('--session-id'));
  assert.ok(cmd.argv.includes('test-run'));
});

test('QoderAdapter.invokeCommand returns -p --output-format=json --yolo argv', () => {
  const adapter = getAdapter('qoder');
  const cmd = adapter.invokeCommand({
  state: { runId: 'test-run', worktreePath: '/tmp/wt' },
  profile: { provider: 'qoder', model: 'default' },
  prompt: 'hello',
  config: {},
  sessionDir: '/tmp/session',
  mode: 'run',
  });
  assert.ok(cmd.argv.includes('-p'));
  assert.ok(cmd.argv.includes('hello'));
  assert.ok(cmd.argv.includes('--output-format=json'));
  assert.ok(cmd.argv.includes('--yolo'));
  assert.ok(cmd.argv.some((a) => a.startsWith('--allowed-tool')));
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
