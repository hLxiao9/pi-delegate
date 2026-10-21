/*
 * spotworkers - Delegate bounded coding tasks to cheap agent workers
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeCatalog,
  readCatalogSync,
  refreshCatalog,
  cheapestModel,
  resolveModelAlias,
  resolveEffort,
  resolveContextWindow,
  findModel,
  formatCatalog,
  CATALOG_TTL_MS,
  CATALOG_SCHEMA,
} from '../lib/qoder-catalog.mjs';
import { getAdapter } from '../lib/adapters/index.mjs';

// Verbatim shape from GET /api/v1/cloud/models (CN, 2026-10).
const PAYLOAD = {
  data: [
    { id: 'qm', display_name: 'Qwen3.7-Plus', price_factor: 0.1, max_input_tokens: 180000, available_context_windows: [200000] },
    { id: 'auto', display_name: 'Auto', price_factor: 0.5, max_input_tokens: 200000, available_context_windows: [200000] },
    {
      id: 'qfmodel',
      display_name: 'Qwen3.8-Flash',
      price_factor: 0,
      efforts: ['low', 'medium', 'xhigh'],
      default_effort: 'medium',
      max_input_tokens: 180000,
      default_context_window: 200000,
      available_context_windows: [200000, 400000, 1000000],
    },
    {
      id: 'dfmodel',
      display_name: 'DeepSeek-Flash',
      price_factor: 0,
      efforts: ['high', 'low', 'max'],
      default_effort: 'max',
      max_input_tokens: 180000,
      available_context_windows: [200000, 400000, 1000000],
    },
    { id: 'km', display_name: 'Kimi-K3', price_factor: 1.4, max_input_tokens: 180000, available_context_windows: [200000] },
  ],
  has_more: false,
};

test('normalizeCatalog keeps price factor and per-model capability tiers', () => {
  const models = normalizeCatalog(PAYLOAD);
  assert.equal(models.length, 5);
  const flash = models.find((m) => m.name === 'Qwen3.8-Flash');
  assert.equal(flash.priceFactor, 0);
  assert.deepEqual(flash.efforts, ['low', 'medium', 'xhigh']);
  assert.deepEqual(flash.contextWindows, [200000, 400000, 1000000]);
  // Absent capabilities stay absent instead of being invented.
  assert.deepEqual(models.find((m) => m.name === 'Auto').efforts, []);
});

test('normalizeCatalog drops rows without an id and tolerates junk', () => {
  assert.deepEqual(normalizeCatalog(null), []);
  assert.deepEqual(normalizeCatalog({ data: [{ display_name: 'no id' }] }), []);
  assert.deepEqual(normalizeCatalog({ data: 'nope' }), []);
});

test('cheapestModel prefers price_factor 0, then the widest context', () => {
  const models = normalizeCatalog(PAYLOAD);
  const pick = cheapestModel(models);
  assert.equal(pick.priceFactor, 0);
  // Both free models tie on price and window; the name breaks the tie so the
  // choice is stable across runs. DeepSeek-Flash sorts before Qwen3.8-Flash.
  assert.equal(pick.name, 'DeepSeek-Flash');
  assert.equal(cheapestModel([]), null);
});

test('resolveModelAlias maps free/cheapest onto a real display name', () => {
  const models = normalizeCatalog(PAYLOAD);
  for (const alias of ['free', 'FREE', 'qoder-free', 'cheapest']) {
    const resolved = resolveModelAlias(alias, models);
    assert.equal(resolved.model, 'DeepSeek-Flash', `${alias} must resolve`);
    assert.match(resolved.note, /resolved to DeepSeek-Flash \(free\)/);
  }
  // Without a catalog the alias degrades to "let the CLI decide" rather than
  // pinning a name it cannot verify.
  assert.deepEqual(resolveModelAlias('free', null), {
    model: '',
    note: "model 'free' could not be resolved (no catalog); falling back to the CLI default",
  });
});

test('resolveModelAlias accepts the opaque id and the display name', () => {
  const models = normalizeCatalog(PAYLOAD);
  assert.equal(resolveModelAlias('qfmodel', models).model, 'Qwen3.8-Flash');
  assert.equal(resolveModelAlias('qwen3.8-flash', models).model, 'Qwen3.8-Flash');
  // A name the catalog does not know is passed through: the CLI is the final
  // authority and its error message is clearer than a guess.
  assert.equal(resolveModelAlias('Some-Future-Model', models).model, 'Some-Future-Model');
  assert.equal(resolveModelAlias('', models).model, '');
});

test('resolveEffort passes through supported levels and snaps the rest', () => {
  const models = normalizeCatalog(PAYLOAD);
  const flash = findModel('Qwen3.8-Flash', models);
  assert.deepEqual(resolveEffort('xhigh', flash), { effort: 'xhigh', note: null });
  // Qwen3.8-Flash supports low/medium/xhigh — 'max' is one step past xhigh.
  const snapped = resolveEffort('max', flash);
  assert.equal(snapped.effort, 'xhigh');
  assert.match(snapped.note, /allowed: low, medium, xhigh/);
  // A model that publishes no efforts accepts whatever was asked for.
  assert.deepEqual(resolveEffort('xhigh', findModel('Auto', models)), { effort: 'xhigh', note: null });
  assert.deepEqual(resolveEffort('', flash), { effort: '', note: null });
});

test('resolveContextWindow rounds down to a published tier', () => {
  const models = normalizeCatalog(PAYLOAD);
  const flash = findModel('Qwen3.8-Flash', models);
  assert.deepEqual(resolveContextWindow(1000000, flash), { contextWindow: '1000000', note: null });
  assert.equal(resolveContextWindow(500000, flash).contextWindow, '400000');
  assert.match(resolveContextWindow(500000, flash).note, /tiers: 200000, 400000, 1000000/);
  // Below the smallest tier: use the smallest rather than inventing a value.
  assert.equal(resolveContextWindow(1000, flash).contextWindow, '200000');
  assert.deepEqual(resolveContextWindow('', flash), { contextWindow: '', note: null });
});

test('formatCatalog lists free models first with price and tiers', () => {
  const lines = formatCatalog(normalizeCatalog(PAYLOAD)).join('\n');
  assert.match(lines, /- DeepSeek-Flash\s+\(free/);
  assert.match(lines, /effort low\|medium\|xhigh/);
  assert.match(lines, /ctx 200K\/400K\/1M/);
  // Sorted by price: the 1.4x model must be last.
  assert.ok(lines.indexOf('DeepSeek-Flash') < lines.indexOf('Kimi-K3'));
});

test('refreshCatalog caches the fetch and readCatalogSync honours the TTL', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qoder-catalog-'));
  const paths = { cacheRoot: root };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    assert.match(String(url), /\/api\/v1\/cloud\/models$/);
    return { ok: true, json: async () => PAYLOAD };
  };
  try {
    const first = await refreshCatalog({ paths, env: { QODERCN_PERSONAL_ACCESS_TOKEN: 't' } });
    assert.equal(first.models.length, 5);
    assert.equal(calls, 1);
    // Second call inside the TTL must not touch the network.
    await refreshCatalog({ paths, env: { QODERCN_PERSONAL_ACCESS_TOKEN: 't' } });
    assert.equal(calls, 1);
    assert.ok(readCatalogSync(paths), 'cache must be readable synchronously');
    // Expired cache is rejected by the default read.
    const expired = { schema: CATALOG_SCHEMA, fetchedAt: new Date(Date.now() - CATALOG_TTL_MS - 1000).toISOString(), models: first.models };
    await writeFile(path.join(root, 'qoder-models.json'), JSON.stringify(expired));
    assert.equal(readCatalogSync(paths), null);
    assert.ok(readCatalogSync(paths, { maxAgeMs: Infinity }), 'stale reads are allowed on request');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('refreshCatalog survives a rejected fetch and falls back to a stale cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qoder-catalog-'));
  const paths = { cacheRoot: root };
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'qoder-models.json'), JSON.stringify({ schema: CATALOG_SCHEMA, fetchedAt: '2020-01-01T00:00:00.000Z', models: normalizeCatalog(PAYLOAD) }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const catalog = await refreshCatalog({ paths, env: { QODERCN_PERSONAL_ACCESS_TOKEN: 't' } });
    assert.equal(catalog.models.length, 5, 'stale catalog must still be usable');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('QoderAdapter.invokeCommand resolves the free alias from the on-disk cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'qoder-command-'));
  const paths = { cacheRoot: root };
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'qoder-models.json'), JSON.stringify({ schema: CATALOG_SCHEMA, fetchedAt: new Date().toISOString(), models: normalizeCatalog(PAYLOAD) }));
  try {
    const adapter = getAdapter('qoder');
    const cmd = adapter.invokeCommand({
      state: { runId: 'r', worktreePath: '/tmp/wt' },
      profile: { provider: 'qoder', model: 'free', reasoningEffort: 'max', maxContextSize: 500000 },
      prompt: 'hi', config: {}, paths,
    });
    assert.equal(cmd.argv[cmd.argv.indexOf('-m') + 1], 'DeepSeek-Flash');
    // DeepSeek-Flash tops out at 'max', so max survives untouched.
    assert.equal(cmd.argv[cmd.argv.indexOf('--reasoning-effort') + 1], 'max');
    // 500K is not a published tier; the nearest lower one wins.
    assert.equal(cmd.argv[cmd.argv.indexOf('--context-window') + 1], '400000');
    assert.match(cmd.warnings.join('\n'), /resolved to DeepSeek-Flash \(free\)/);
    assert.match(cmd.warnings.join('\n'), /using 400000/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('QoderAdapter.invokeCommand degrades gracefully without a catalog', () => {
  const adapter = getAdapter('qoder');
  const cmd = adapter.invokeCommand({
    state: { runId: 'r', worktreePath: '/tmp/wt' },
    profile: { provider: 'qoder', model: 'free', reasoningEffort: 'xhigh', maxContextSize: 1000000 },
    prompt: 'hi', config: {},
  });
  // No cache => no -m (CLI default), but the explicit effort/window still pass
  // through for the CLI to accept or reject.
  assert.ok(!cmd.argv.includes('-m'));
  assert.equal(cmd.argv[cmd.argv.indexOf('--reasoning-effort') + 1], 'xhigh');
  assert.equal(cmd.argv[cmd.argv.indexOf('--context-window') + 1], '1000000');
  assert.match(cmd.warnings.join('\n'), /could not be resolved/);
});
