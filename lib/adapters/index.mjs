/*
 * pi-delegate - Parent-agent-owned Pi implementation worker
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { WorkerError, invariant } from '../errors.mjs';
import { PiAdapter } from './pi.mjs';
import { KimiAdapter } from './kimi.mjs';
import { TraeAdapter } from './trae.mjs';
import { QoderAdapter } from './qoder.mjs';

// Adapter registry.each CLI implements a adapter,registered here.
// profile.adapter field specifies which adapter,default 'pi'.
const REGISTRY = {
  pi: PiAdapter,
  kimi: KimiAdapter,
  trae: TraeAdapter,
  qoder: QoderAdapter,
};

export function getAdapter(name) {
  const adapter = REGISTRY[name ?? 'pi'];
  invariant(adapter, 'CONFIG_INVALID', `Unknown adapter: ${name}. Supported: ${Object.keys(REGISTRY).join(', ')}`);
  return adapter;
}

export function listAdapters() {
  return Object.keys(REGISTRY).map((name) => ({
  name,
  supportsTokenUsage: REGISTRY[name].supportsTokenUsage,
  supportsStreaming: REGISTRY[name].supportsStreaming,
  supportsModelList: REGISTRY[name].supportsModelList,
  defaultBin: REGISTRY[name].defaultBin,
  }));
}

// based on profile parse adapter.profile.adapter optional,default 'pi'.
export function resolveAdapter(profile) {
  return getAdapter(profile?.adapter ?? 'pi');
}

// based on adapter name resolves executable path.
// Priority:env.<ADAPTER>_BIN > env.PI_WORKER_PI_BIN(legacy,only Pi adapter) > adapter.defaultBin
export function resolveBin(adapter, env) {
  const adapterName = adapter.name;
  const envKey = `PI_WORKER_${adapterName.toUpperCase()}_BIN`;
  // legacy PI_WORKER_PI_BIN only for Pi adapter takes effect,avoid Kimi/Trae/Qoder misuse Pi binary
  if (adapterName === 'pi') {
  return env[envKey] ?? env.PI_WORKER_PI_BIN ?? adapter.defaultBin;
  }
  return env[envKey] ?? adapter.defaultBin;
}
