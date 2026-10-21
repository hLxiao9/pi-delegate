/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { resolveWorkerPaths } from './config.mjs';
import { getAdapter, resolveBin, listAdapters } from './adapters/index.mjs';
import { runProcess } from './process.mjs';
import { loadShellProfileEnv } from './shell-profile.mjs';

// Adapters whose model enumeration authenticates with a token. `detect` builds
// a synthetic profile ({}), so the adapter-specific default variable name is
// resolved here instead of coming from config.json.
const ADAPTER_CREDENTIAL_ENV = {
  qoder: 'QODERCN_PERSONAL_ACCESS_TOKEN',
};

// A CLI launched from a desktop app or a cron job does not inherit the shell
// profile, so the token may exist on disk but not in process.env. Reads it
// without overriding anything that is already set.
async function withAdapterCredentials(adapter, env) {
  const name = ADAPTER_CREDENTIAL_ENV[adapter.name];
  if (!name || env[name]) return env;
  try {
    const loaded = await loadShellProfileEnv([name], { home: env.HOME });
    return loaded[name] ? { ...loaded, ...env } : env;
  } catch {
    return env;
  }
}

// How long a cached registry stays fresh before the next `detect` re-probes
// the environment. 10 minutes keeps dispatch snappy while still picking up a
// freshly installed CLI within a reasonable window.
const REGISTRY_MAX_AGE_MS = 10 * 60 * 1000;

export function isRegistryFresh(reg, maxAgeMs = REGISTRY_MAX_AGE_MS) {
  if (!reg || typeof reg.generatedAt !== 'string') return false;
  const age = Date.now() - Date.parse(reg.generatedAt);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

// Resolve the actual executable path for an adapter, probing the resolved bin
// first then any adapter-declared candidateBins (e.g. opencode's
// ~/.opencode/bin). Returns the first bin that responds to `--version`, or the
// primary resolved bin when none respond (so callers can still surface a
// precise "not installed" error). Used by both detect and doctor so a CLI that
// isn't on PATH is still discovered.
export async function resolveInstalledBin(adapter, env, timeoutMs = 8000) {
  const primary = resolveBin(adapter, env);
  const candidates = [primary, ...(adapter.candidateBins ?? [])].filter(Boolean);
  for (const tryBin of candidates) {
    try {
      const probe = await runProcess(tryBin, adapter.versionCommand().argv, {
        env: { ...env, PATH: env.PATH },
        timeoutMs,
      });
      if (probe.code === 0) return tryBin;
    } catch {
      // spawn ENOENT or timeout => try the next candidate
    }
  }
  return primary;
}

// Probe every known adapter: is its CLI installed, and (when the adapter can
// enumerate models) what models are available? The result is cached to
// `registryFile` so repeated dispatch stays cheap and so a parent agent can
// read the cached file to learn which CLIs/models exist on this machine.
//
// Each adapter is probed independently and failures degrade gracefully: a
// missing binary simply reports `installed: false`, and a model-listing that
// fails (no creds / offline) yields an empty `models` array. Detection never
// throws.
export async function detectEnvironment({ paths, env, force = false } = {}) {
  const runtimeEnv = env ?? process.env;
  const p = paths ?? resolveWorkerPaths(runtimeEnv);
  const adaptersMeta = listAdapters();
  const adapters = [];
  for (const meta of adaptersMeta) {
    const adapter = getAdapter(meta.name);
    const bin = resolveBin(adapter, runtimeEnv);
    const entry = {
      name: meta.name,
      bin,
      installed: false,
      version: null,
      supportsModelList: Boolean(adapter.supportsModelList),
      models: [],
    };
    // 1) version probe => is the CLI installed? Probe the resolved bin first,
    // then any adapter-declared candidateBins (e.g. opencode's ~/.opencode/bin)
    // so a CLI that isn't on PATH is still discovered. First bin that runs
    // wins; we record the bin that worked so model enumeration uses it too.
    const candidateBins = [bin, ...(adapter.candidateBins ?? [])].filter(Boolean);
    for (const tryBin of candidateBins) {
      try {
        const probe = await runProcess(tryBin, adapter.versionCommand().argv, {
          env: { ...runtimeEnv, PATH: runtimeEnv.PATH },
          timeoutMs: 8000,
        });
        if (probe.code === 0) {
          entry.installed = true;
          entry.version = probe.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
          entry.bin = tryBin;
          break;
        }
      } catch {
        // spawn ENOENT or timeout => try the next candidate
      }
    }
    // 2) model enumeration (only adapters that support it; opencode does,
    // pi's "listModels" is a presence-check so its result is coerced below).
    // Uses entry.bin — the binary that actually responded to the version probe.
    if (entry.installed && adapter.supportsModelList) {
      try {
        // Model enumeration often needs a credential that only lives in the
        // shell profile (a GUI-launched process does not inherit it). Fill the
        // gap without overwriting anything already in the environment.
        const modelEnv = await withAdapterCredentials(adapter, runtimeEnv);
        const spec = await adapter.listModels({ paths: p, profile: {}, env: modelEnv, bin: entry.bin });
        if (spec && Array.isArray(spec.models)) {
          // Adapter already resolved the roster (possibly from an API instead
          // of a CLI subcommand, e.g. qoder's priced catalog).
          entry.models = spec.models;
        } else if (spec && Array.isArray(spec.argv)) {
          const out = await runProcess(entry.bin, spec.argv, {
            env: spec.env ?? modelEnv,
            timeoutMs: 20000,
          });
          if (out.code === 0 && spec.parse) {
            const parsed = spec.parse(out.stdout);
            // Some adapters (pi) return a boolean presence-check rather than a
            // list; only keep real arrays so the chooser doesn't choke.
            entry.models = Array.isArray(parsed) ? parsed : [];
          }
        }
      } catch {
        entry.models = [];
      }
    }
    adapters.push(entry);
  }
  const reg = { generatedAt: new Date().toISOString(), adapters };
  try {
    await mkdir(path.dirname(p.registryFile), { recursive: true });
    await writeFile(p.registryFile, JSON.stringify(reg, null, 2), { mode: 0o600 });
  } catch {
    // Non-fatal: caching is best-effort.
  }
  return reg;
}

export async function loadRegistry({ paths, env } = {}) {
  const p = paths ?? resolveWorkerPaths(env ?? process.env);
  try {
    return JSON.parse(await readFile(p.registryFile, 'utf8'));
  } catch {
    return null;
  }
}

// Returns a fresh registry when forced, otherwise the cached one when fresh.
export async function getRegistry({ paths, env, force = false, maxAgeMs } = {}) {
  if (!force) {
    const cached = await loadRegistry({ paths, env });
    if (isRegistryFresh(cached, maxAgeMs)) return cached;
  }
  return detectEnvironment({ paths, env, force: true });
}

// Map a (cli, model) pair to a configured profile. Prefer an exact pinned-model
// match, then a profile with an empty/auto model (clean override target), then
// the first profile for that adapter. Returns { name, costTier } or null.
export function resolveProfileForSelection(config, { cli, model }) {
  const candidates = Object.entries(config.profiles ?? {})
    .filter(([, p]) => (p.adapter ?? 'pi') === cli)
    .map(([name, p]) => ({ name, ...p }));
  if (candidates.length === 0) return null;
  const exact = candidates.find((c) => (c.model || '').trim() === model);
  if (exact) return { name: exact.name, costTier: exact.costTier ?? null };
  const empty = candidates.find((c) => !c.model || c.model === 'auto' || c.model === 'default');
  if (empty) return { name: empty.name, costTier: empty.costTier ?? null };
  return { name: candidates[0].name, costTier: candidates[0].costTier ?? null };
}

// Build the flattened list of (cli, model, profile) choices shown to the user.
// Sources:
//   - detected models per installed adapter (the full opencode list, etc.)
//   - configured profiles not already covered (covers CLIs that cannot
//     enumerate models: pi/kimi/trae/qoder, and pinned-only models)
// A CLI that detection explicitly found NOT installed is dropped, so the user
// only picks from things that can actually run here.
export function buildWorkerChoices(config, reg) {
  const choices = [];
  const seen = new Set();
  const knownAdapters = new Map((reg?.adapters ?? []).map((a) => [a.name, a]));
  const installedAdapters = new Set([...knownAdapters.values()].filter((a) => a.installed).map((a) => a.name));

  for (const a of reg?.adapters ?? []) {
    if (!a.installed) continue;
    for (const m of a.models ?? []) {
      const modelId = m.id;
      const key = `${a.name}:${modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resolved = resolveProfileForSelection(config, { cli: a.name, model: modelId });
      // A per-model price tag beats the profile's coarse costTier: every Qoder
      // model would otherwise inherit the same [free] label from the qoder-cli
      // profile even though Kimi-K3 costs 1.4x.
      const priceLabel = typeof m?.priceFactor === 'number'
        ? (m.priceFactor === 0 ? 'free' : `${m.priceFactor}x`)
        : null;
      choices.push({ cli: a.name, model: modelId, profile: resolved?.name ?? null, costTier: resolved?.costTier ?? null, priceLabel });
    }
  }

  for (const [name, p] of Object.entries(config.profiles ?? {})) {
    const cli = p.adapter ?? 'pi';
    const known = knownAdapters.get(cli);
    if (known && !known.installed) continue; // detected-but-missing => skip
    const modelId = (p.model || '').trim() || `${cli} (default)`;
    const key = `${cli}:${modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // If detection ran and did not surface this CLI at all (no reg entry),
    // still include it (headless / partial detection fallback).
    choices.push({ cli, model: modelId, profile: name, costTier: p.costTier ?? null });
  }
  return choices;
}

const DEFAULT_LABEL = (choice) => `${choice.cli} (default)`;

// Interactive chooser: write the installed CLI + model table and read a
// selection from the TTY. Returns { profile, model } or null when no choice
// could be made (empty list, invalid input, or non-TTY). The model is '' when
// the user picked a "default" entry, letting the adapter pick its own model.
export async function presentWorkerChooser({ config, reg, defaultProfile } = {}) {
  const choices = buildWorkerChoices(config, reg);
  if (choices.length === 0) return null;
  const defaultIndex = Math.max(0, choices.findIndex((c) => c.profile === defaultProfile));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write('\nAvailable worker CLIs and models:\n');
    choices.forEach((c, i) => {
      const isDefault = i === defaultIndex;
      const tag = c.priceLabel ? ` [${c.priceLabel}]` : c.costTier ? ` [${c.costTier}]` : '';
      const label = c.model === `${c.cli} (default)` ? DEFAULT_LABEL(c) : c.model;
      process.stdout.write(`  ${isDefault ? '*' : ' '}${String(i + 1).padStart(2)}. ${c.cli}  ${label}${tag}\n`);
    });
    const ans = (await rl.question(`Select worker [1-${choices.length}] (Enter = ${choices[defaultIndex].cli} ${choices[defaultIndex].model}): `)).trim();
    let idx = defaultIndex;
    if (ans) {
      const n = Number.parseInt(ans, 10);
      if (!Number.isFinite(n) || n < 1 || n > choices.length) return null;
      idx = n - 1;
    }
    const chosen = choices[idx];
    if (!chosen.profile) return null;
    const model = chosen.model === `${chosen.cli} (default)` ? '' : chosen.model;
    return { profile: chosen.profile, model };
  } finally {
    rl.close();
  }
}

export function formatRegistryTable(reg) {
  const lines = ['Detected environment (pi-worker worker CLIs):', ''];
  for (const a of reg.adapters) {
    if (!a.installed) {
      lines.push(`  ${a.name.padEnd(10)} not installed (bin: ${a.bin})`);
      continue;
    }
    const priced = a.models.filter((m) => typeof m?.priceFactor === 'number');
    const free = priced.filter((m) => m.priceFactor === 0).length;
    const priceTag = priced.length > 0 ? `  (${free} free)` : '';
    lines.push(`  ${a.name.padEnd(10)} v${a.version ?? '?'}  ${a.models.length} model(s)${priceTag}`);
    for (const m of a.models) {
      // Price multipliers are the reason this list is worth printing: a free
      // model and a 1.4x model look identical in the CLI's own output.
      let suffix = '';
      if (typeof m?.priceFactor === 'number') {
        suffix = m.priceFactor === 0 ? '  [free]' : `  [${m.priceFactor}x]`;
        if (Array.isArray(m.contextWindows) && m.contextWindows.length > 0) {
          const tiers = m.contextWindows.map((w) => (w >= 1_000_000 ? `${w / 1_000_000}M` : `${Math.round(w / 1000)}K`));
          suffix += ` ctx ${tiers.join('/')}`;
        }
        if (Array.isArray(m.efforts) && m.efforts.length > 0) suffix += ` effort ${m.efforts.join('|')}`;
      }
      lines.push(`      - ${m.id}${suffix}`);
    }
  }
  return lines.join('\n');
}

// `pi-worker detect` handler: re-probe the environment and return a compact,
// machine-readable summary. Also prints a human-friendly table to stdout so a
// human at the terminal sees the installed CLIs + models at a glance.
export async function detectCommand(options = {}, runtime = {}) {
  const env = runtime.env ?? process.env;
  const paths = runtime.paths ?? resolveWorkerPaths(env);
  const reg = await detectEnvironment({ paths, env, force: true });
  process.stdout.write(`${formatRegistryTable(reg)}\n`);
  return {
    generatedAt: reg.generatedAt,
    adapters: reg.adapters.map((a) => ({
      name: a.name,
      installed: a.installed,
      version: a.version,
      modelCount: a.models.length,
      models: a.models.map((m) => m.id),
    })),
  };
}
