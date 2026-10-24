/*
 * spotworkers - Delegate bounded coding tasks to cheap agent workers
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ensureDir, readJson, writeJsonAtomic } from '../lib/atomic-json.mjs';
import { loadConfig, normalizeCaller, preferredProfileForCaller, resolveCallerEnv, resolveWorkerPaths } from '../lib/config.mjs';
import { selectProfileForTask } from '../lib/difficulty.mjs';
import { makeTempDir } from './helpers.mjs';

const base = { apiKeyEnv: 'K', fallbackProfiles: [], monthlyPlan: { currency: 'USD', amount: 0 }, modalities: ['text'] };

function makeConfig(callerProfiles) {
  return {
  defaultProfile: 'premium',
  callerProfiles,
  profiles: {
    premium: { ...base, provider: 'p', model: 'm-premium', capabilities: ['text', 'code', 'tool-use'], costTier: 'premium' },
    cheap: { ...base, provider: 'p', model: 'm-cheap', capabilities: ['text', 'code', 'tool-use'], costTier: 'cheap' },
    free: { ...base, provider: 'q', model: 'm-free', capabilities: ['text', 'code', 'tool-use'], fallbackProfiles: ['cheap'] },
    vision: { ...base, provider: 'v', model: 'm-vision', capabilities: ['text', 'code', 'tool-use', 'vision-input'], modalities: ['text', 'vision'], costTier: 'cheap' },
  },
  };
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

async function writeConfig(mutate) {
  const home = await makeTempDir('caller-profiles-');
  const paths = resolveWorkerPaths({}, home);
  await ensureDir(path.dirname(paths.configFile));
  const config = await readJson(new URL('../fixtures/default-config.json', import.meta.url));
  mutate(config);
  await writeJsonAtomic(paths.configFile, config);
  return paths;
}

test('caller preference wins over difficulty routing for that caller only', () => {
  const config = makeConfig({ 'claude-code': 'free' });
  const fromClaude = selectProfileForTask(config, makeTask(), { caller: 'claude-code' });
  assert.equal(fromClaude.name, 'free');
  assert.deepEqual(fromClaude.fallbackProfiles, ['cheap'], 'the preferred profile keeps its own fallback chain');
  assert.equal(fromClaude.routing.matchReason, 'caller-preference');
  assert.equal(fromClaude.routing.caller, 'claude-code');

  const fromCodex = selectProfileForTask(config, makeTask(), { caller: 'codex' });
  assert.equal(fromCodex.name, 'cheap', 'a caller without a preference keeps difficulty routing');
});

test('explicit --profile still beats the caller preference', () => {
  const config = makeConfig({ 'claude-code': 'free' });
  const result = selectProfileForTask(config, makeTask(), { profile: 'premium', caller: 'claude-code' });
  assert.equal(result.name, 'premium');
});

test('caller preference never unblocks a high-risk task', () => {
  const config = makeConfig({ 'claude-code': 'free' });
  assert.equal(selectProfileForTask(config, makeTask({ risk: 'high' }), { caller: 'claude-code' }), null);
});

test('a preferred profile that cannot take the task falls through to routing', () => {
  const config = makeConfig({ 'claude-code': 'free' });
  const task = makeTask({ requiredCapabilities: ['text', 'code', 'vision-input'] });
  const result = selectProfileForTask(config, task, { caller: 'claude-code' });
  assert.equal(result.name, 'vision');
  assert.notEqual(result.routing.matchReason, 'caller-preference');
});

test('preferredProfileForCaller returns null without a preference', () => {
  assert.equal(preferredProfileForCaller(makeConfig(undefined), 'claude-code'), null);
  assert.equal(preferredProfileForCaller(makeConfig({ codex: 'cheap' }), 'claude-code'), null);
  assert.equal(preferredProfileForCaller(makeConfig({ 'claude-code': 'free' }), 'claude-code'), 'free');
});

test('caller helpers resolve PARENT_AGENT and collapse unknown callers', () => {
  assert.equal(normalizeCaller(resolveCallerEnv({ PARENT_AGENT: 'Claude-Code' })), 'claude-code');
  assert.equal(normalizeCaller(resolveCallerEnv({ WORKBUDDY: '1' })), 'workbuddy');
  assert.equal(normalizeCaller(resolveCallerEnv({})), 'cli');
  assert.equal(normalizeCaller('someone-else'), 'unknown');
});

test('shipped default config has no personal caller preference', async () => {
  const config = await readJson(new URL('../fixtures/default-config.json', import.meta.url));
  assert.equal(config.callerProfiles, undefined);
});

test('config accepts a valid callerProfiles map', async () => {
  const paths = await writeConfig((config) => { config.callerProfiles = { 'claude-code': config.defaultProfile }; });
  const config = await loadConfig(paths);
  assert.equal(preferredProfileForCaller(config, 'claude-code'), config.defaultProfile);
});

test('config rejects callerProfiles pointing at an unknown profile', async () => {
  const paths = await writeConfig((config) => { config.callerProfiles = { 'claude-code': 'does-not-exist' }; });
  await assert.rejects(() => loadConfig(paths), (e) => e.code === 'CONFIG_INVALID' && /unknown profile/.test(e.message));
});

test('config rejects callerProfiles keyed by an unknown caller', async () => {
  const paths = await writeConfig((config) => { config.callerProfiles = { claude: config.defaultProfile }; });
  await assert.rejects(() => loadConfig(paths), (e) => e.code === 'CONFIG_INVALID' && /not a known caller/.test(e.message));
});
