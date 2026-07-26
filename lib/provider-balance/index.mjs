/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

// Provider balance adapter registry.
//
// Each adapter reads the remaining subscription balance/quota for a specific
// provider (e.g. DeepSeek, OpenAI, Volcengine). Adapters are lazily registered
// and dynamically imported on first use so that optional HTTP dependencies
// never bloat the core CLI.
//
// To contribute a new adapter:
//   1. Create lib/provider-balance/<provider-name>.mjs
//   2. Export `name` and `fetchBalance({ apiKey, config })`.
//   3. Register it in the ADAPTERS map below.
//   4. Add `balanceAdapter: "<provider-name>"` to the profile in default-config.json.
//
// See references/provider-balance.md for the full contract and examples.

const ADAPTERS = {
  // Community-contributed adapters are registered here.
  // Example:
  //   'deepseek': () => import('./deepseek.mjs'),
  //   'openai': () => import('./openai.mjs'),
};

export function listBalanceAdapters() {
  return Object.keys(ADAPTERS);
}

export function isBalanceAdapterRegistered(name) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, name);
}

export async function fetchProviderBalance({ provider, adapterName, apiKey, config = {} }) {
  const name = adapterName ?? provider;
  const loader = ADAPTERS[name];
  if (!loader) {
    return {
      available: false,
      provider,
      reason: `No balance adapter registered for "${name}". See references/provider-balance.md to contribute one.`,
      at: new Date().toISOString(),
    };
  }
  if (!apiKey) {
    return {
      available: false,
      provider,
      reason: `Missing API key for balance query (provider: ${name})`,
      at: new Date().toISOString(),
    };
  }
  try {
    const mod = await loader();
    const result = await mod.fetchBalance({ apiKey, config });
    return {
      available: true,
      provider: name,
      ...result,
      at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      available: false,
      provider: name,
      reason: error?.message ?? String(error),
      at: new Date().toISOString(),
    };
  }
}
