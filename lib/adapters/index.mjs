import { WorkerError, invariant } from '../errors.mjs';
import { PiAdapter } from './pi.mjs';
import { KimiAdapter } from './kimi.mjs';
import { TraeAdapter } from './trae.mjs';
import { QoderAdapter } from './qoder.mjs';

// Adapter registry。每个 CLI 实现一个 adapter,在此注册。
// profile.adapter 字段指定使用哪个 adapter,默认 'pi'。
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

// 根据 profile 解析 adapter。profile.adapter 可选,默认 'pi'。
export function resolveAdapter(profile) {
  return getAdapter(profile?.adapter ?? 'pi');
}

// 根据 adapter 名解析可执行文件路径。
// 优先级:env.PI_WORKER_PI_BIN(兼容老配置) > env.<ADAPTER>_BIN > adapter.defaultBin
export function resolveBin(adapter, env) {
  const adapterName = adapter.name;
  const envKey = `PI_WORKER_${adapterName.toUpperCase()}_BIN`;
  // 兼容老的 PI_WORKER_PI_BIN
  const legacyKey = 'PI_WORKER_PI_BIN';
  return env[envKey] ?? env[legacyKey] ?? adapter.defaultBin;
}
