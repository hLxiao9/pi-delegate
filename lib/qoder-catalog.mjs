/*
 * spotworkers - Delegate bounded coding tasks to cheap agent workers
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

// Qoder model catalog: pricing multiplier + per-model capability metadata.
//
// WHY THIS EXISTS
// `qoderclicn --list-models` prints a bare name column (Auto, Qwen3.8-Flash,
// ...) and nothing else, so the CLI cannot tell you that Qwen3.8-Flash and
// DeepSeek-Flash cost 0x while Kimi-K3 costs 1.4x. The same catalog the CLI
// itself consumes is served as plain JSON by the cloud API:
//
//   GET https://api.qoder.com.cn/api/v1/cloud/models
//   Authorization: Bearer <PAT>
//
// and each entry carries exactly what dispatch needs:
//   { id, display_name, price_factor, efforts, default_effort,
//     max_input_tokens, default_context_window, available_context_windows }
//
// Two consequences worth spelling out:
//   1. `price_factor: 0` means the model is free for this account. That is the
//      only reliable signal — nothing in the CLI surfaces it.
//   2. `efforts` and `available_context_windows` are PER MODEL. Asking
//      DeepSeek-Flash for `xhigh` (it supports high/low/max) or a window that
//      is not one of its published tiers is rejected by the CLI. The catalog is
//      the only place to learn the legal values before spending a run.
//
// The response is cached on disk because dispatch must stay cheap and because
// invokeCommand is synchronous; it reads the cache, never the network.

import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Price factors and model rosters change on the order of days, not minutes.
// 30 minutes keeps a long delegation session consistent while still noticing a
// newly published model within one work block.
export const CATALOG_TTL_MS = 30 * 60 * 1000;

// Bump whenever normalizeCatalog changes shape or ordering. Cached records are
// stored post-normalization, so without this an improved normalizer would keep
// serving the old interpretation until the TTL expired.
export const CATALOG_SCHEMA = 2;

const DEFAULT_BASE_URL = 'https://api.qoder.com.cn';
const FETCH_TIMEOUT_MS = 5000;

// Pseudonyms a caller may pass as `model` to mean "pick for me by price".
export const FREE_MODEL_ALIASES = new Set(['free', 'qoder-free', 'cheapest']);

// Canonical ordering, used to snap an unsupported effort level to its nearest
// legal neighbour instead of failing the run.
const EFFORT_ORDER = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

export function catalogFile(paths) {
  return path.join(paths.cacheRoot, 'qoder-models.json');
}

function toPositiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

// Maps the API payload onto the internal shape. Unknown/absent fields become
// null or [] rather than being invented, so callers can distinguish "the
// provider did not say" from "the provider said zero".
export function normalizeCatalog(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .filter((row) => row && typeof row.id === 'string' && row.id.length > 0)
    .map((row) => {
      const windows = Array.isArray(row.available_context_windows)
        ? [...new Set(row.available_context_windows.map(toPositiveInteger).filter(Boolean))].sort((a, b) => a - b)
        : [];
      return {
        id: row.id,
        name: typeof row.display_name === 'string' && row.display_name ? row.display_name : row.id,
        priceFactor: typeof row.price_factor === 'number' && Number.isFinite(row.price_factor) ? row.price_factor : null,
        efforts: Array.isArray(row.efforts)
          ? [...new Set(row.efforts.filter((e) => typeof e === 'string' && e))].sort(
            (a, b) => {
              const ia = EFFORT_ORDER.indexOf(a);
              const ib = EFFORT_ORDER.indexOf(b);
              if (ia === -1 && ib === -1) return a.localeCompare(b);
              if (ia === -1) return 1;
              if (ib === -1) return -1;
              return ia - ib;
            },
          )
          : [],
        defaultEffort: typeof row.default_effort === 'string' && row.default_effort ? row.default_effort : null,
        maxInputTokens: toPositiveInteger(row.max_input_tokens),
        defaultContextWindow: toPositiveInteger(row.default_context_window),
        contextWindows: windows,
        isNew: row.is_new === true,
      };
    });
}

// Synchronous read used by invokeCommand. The default enforces the TTL; callers
// that only need "some catalog to validate against" pass maxAgeMs: Infinity,
// because a stale tier list is still a better hint than none.
export function readCatalogSync(paths, { maxAgeMs = CATALOG_TTL_MS, now = Date.now() } = {}) {
  let raw;
  try {
    raw = readFileSync(catalogFile(paths), 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || parsed.schema !== CATALOG_SCHEMA) return null;
  if (!Array.isArray(parsed.models) || parsed.models.length === 0) return null;
  const fetchedAt = Date.parse(parsed.fetchedAt ?? '');
  if (Number.isFinite(fetchedAt) && now - fetchedAt > maxAgeMs) return null;
  return parsed;
}

export function apiBaseUrl(env = process.env) {
  const raw = String(env.QODERCN_API_BASE ?? '').trim();
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

async function fetchCatalog({ env, apiKeyEnv }) {
  const token = env[apiKeyEnv];
  if (!token) return null;
  const response = await fetch(`${apiBaseUrl(env)}/api/v1/cloud/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const models = normalizeCatalog(await response.json());
  return models.length > 0 ? models : null;
}

// Cache-first refresh. Never throws: a delegation run must not fail because the
// pricing endpoint hiccuped — a stale catalog or none at all is acceptable.
export async function refreshCatalog({ paths, env = process.env, profile = {}, force = false }) {
  const cached = readCatalogSync(paths, { maxAgeMs: CATALOG_TTL_MS });
  if (cached && !force) return cached;

  const apiKeyEnv = profile.apiKeyEnv || 'QODERCN_PERSONAL_ACCESS_TOKEN';
  let models = null;
  try {
    models = await fetchCatalog({ env, apiKeyEnv });
  } catch {
    models = null;
  }
  if (!models) return readCatalogSync(paths, { maxAgeMs: Infinity });

  const record = { schema: CATALOG_SCHEMA, fetchedAt: new Date().toISOString(), baseUrl: apiBaseUrl(env), models };
  try {
    await mkdir(path.dirname(catalogFile(paths)), { recursive: true });
    await writeFile(catalogFile(paths), JSON.stringify(record, null, 2), { mode: 0o600 });
  } catch {
    // best-effort cache
  }
  return record;
}

// Cheapest first, then the model with the most headroom, then alphabetical so
// the ordering is stable across runs instead of following API ordering.
export function sortByPrice(models) {
  return [...models].sort((a, b) => {
    const pa = a.priceFactor ?? Number.POSITIVE_INFINITY;
    const pb = b.priceFactor ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    if (a.maxInputTokens !== b.maxInputTokens) return (b.maxInputTokens ?? 0) - (a.maxInputTokens ?? 0);
    return a.name.localeCompare(b.name);
  });
}

export function cheapestModel(models) {
  if (!Array.isArray(models) || models.length === 0) return null;
  return sortByPrice(models)[0];
}

export function isFreeModel(model) {
  return model?.priceFactor === 0;
}

// `-m` takes the display name (`Qwen3.8-Flash`), not the opaque id
// (`qfmodel`). Callers may supply either, so both are matched case-insensitively.
export function resolveModelAlias(requested, models) {
  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (!raw) return { model: '', note: null };

  const lowered = raw.toLowerCase();
  if (FREE_MODEL_ALIASES.has(lowered)) {
    const pick = cheapestModel(models);
    if (!pick) {
      return { model: '', note: `model '${raw}' could not be resolved (no catalog); falling back to the CLI default` };
    }
    const price = pick.priceFactor === 0 ? 'free' : `${pick.priceFactor}x`;
    return { model: pick.name, note: `model '${raw}' resolved to ${pick.name} (${price})` };
  }

  if (!Array.isArray(models)) return { model: raw, note: null };
  const hit = models.find((m) => m.name.toLowerCase() === lowered || m.id.toLowerCase() === lowered);
  if (!hit) return { model: raw, note: null };
  return { model: hit.name, note: hit.name === raw ? null : `model '${raw}' resolved to ${hit.name}` };
}

export function findModel(name, models) {
  if (!Array.isArray(models) || !name) return null;
  const lowered = String(name).toLowerCase();
  return models.find((m) => m.name.toLowerCase() === lowered || m.id.toLowerCase() === lowered) ?? null;
}

// Snap an unsupported effort level to the closest legal one. Returns the value
// to pass plus a note when it differs from what was asked for.
export function resolveEffort(requested, model) {
  const raw = String(requested ?? '').trim().toLowerCase();
  if (!raw) return { effort: '', note: null };
  const allowed = model?.efforts ?? [];
  if (allowed.length === 0) return { effort: raw, note: null };
  if (allowed.includes(raw)) return { effort: raw, note: null };

  const target = EFFORT_ORDER.indexOf(raw);
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of allowed) {
    const index = EFFORT_ORDER.indexOf(candidate);
    const distance = target === -1 || index === -1 ? Number.POSITIVE_INFINITY : Math.abs(index - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  const fallback = best ?? model?.defaultEffort ?? allowed[0];
  return {
    effort: fallback,
    note: `reasoning effort '${raw}' is not supported by ${model?.name ?? 'this model'} (allowed: ${allowed.join(', ')}); using '${fallback}'`,
  };
}

// Context windows are published as discrete tiers (200K / 400K / 1M), not as an
// arbitrary range, so an off-tier request is rounded DOWN to the largest tier
// that still satisfies it — never silently upgraded past what was asked.
export function resolveContextWindow(requested, model) {
  const wanted = toPositiveInteger(requested);
  if (!wanted) return { contextWindow: '', note: null };
  const windows = model?.contextWindows ?? [];
  if (windows.length === 0) return { contextWindow: String(wanted), note: null };
  if (windows.includes(wanted)) return { contextWindow: String(wanted), note: null };

  const lower = windows.filter((w) => w <= wanted);
  const chosen = lower.length > 0 ? lower[lower.length - 1] : windows[0];
  return {
    contextWindow: String(chosen),
    note: `context window ${wanted} is not offered by ${model?.name ?? 'this model'} (tiers: ${windows.join(', ')}); using ${chosen}`,
  };
}

function formatTokens(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return '?';
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function formatFactor(factor) {
  if (factor === null || factor === undefined) return '?';
  return factor === 0 ? 'free' : `${factor}x`;
}

// Human-readable roster for `spot detect` / `doctor`. Free models are
// listed first and flagged, because that is the whole point of asking.
export function formatCatalog(models, { indent = '      ' } = {}) {
  if (!Array.isArray(models) || models.length === 0) return [];
  return sortByPrice(models).map((m) => {
    const parts = [formatFactor(m.priceFactor)];
    if (m.contextWindows.length > 0) parts.push(`ctx ${m.contextWindows.map(formatTokens).join('/')}`);
    if (m.efforts.length > 0) parts.push(`effort ${m.efforts.join('|')}`);
    if (m.maxInputTokens) parts.push(`max-in ${formatTokens(m.maxInputTokens)}`);
    return `${indent}- ${m.name}  (${parts.join(' · ')})`;
  });
}
