import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './atomic-json.mjs';
import { WorkerError, invariant } from './errors.mjs';
import { validateProfileFields } from './contracts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resolveWorkerPaths(env = process.env, home = os.homedir()) {
  return {
    root,
    configFile: env.PI_WORKER_CONFIG ?? path.join(home, '.config', 'pi-worker', 'config.json'),
    modelsFile: env.PI_WORKER_MODELS_FILE ?? path.join(home, '.pi', 'agent', 'models.json'),
    stateRoot: env.PI_WORKER_STATE_DIR ?? path.join(home, '.local', 'state', 'pi-worker'),
    cacheRoot: env.PI_WORKER_CACHE_DIR ?? path.join(home, '.cache', 'pi-worker'),
    piBin: env.PI_WORKER_PI_BIN ?? 'pi',
    kimiBin: env.PI_WORKER_KIMI_BIN ?? 'kimi',
    traeBin: env.PI_WORKER_TRAE_BIN ?? 'traecli',
    qoderBin: env.PI_WORKER_QODER_BIN ?? 'qoderclicn',
    gitBin: env.PI_WORKER_GIT_BIN ?? 'git',
  };
}

const VALID_COST_TIERS = new Set(['cheap', 'standard', 'premium']);

function resolveRateCard(config) {
  return config.parentRateCard ?? config.codexRateCard;
}

function resolveSubscription(config) {
  return config.parentSubscription ?? config.codexSubscription;
}

function validateConfig(config) {
  invariant(config?.schemaVersion === 1, 'CONFIG_INVALID', 'config.schemaVersion must equal 1');
  invariant(/^\d+\.\d+\.\d+$/.test(config.minimumPiVersion), 'CONFIG_INVALID', 'minimumPiVersion must be an exact semantic version');
  invariant(typeof config.defaultProfile === 'string' && config.defaultProfile.length > 0, 'CONFIG_INVALID', 'defaultProfile is required');
  invariant(Number.isInteger(config.maxRevisionRounds) && config.maxRevisionRounds === 2, 'CONFIG_INVALID', 'maxRevisionRounds must equal 2 in v1');
  invariant(typeof config.autoIntegrateCleanSource === 'boolean', 'CONFIG_INVALID', 'autoIntegrateCleanSource must be Boolean');
  invariant(Array.isArray(config.retryDelaysMs) && config.retryDelaysMs.length === 1 && config.retryDelaysMs.every((value) => Number.isInteger(value) && value >= 0), 'CONFIG_INVALID', 'retryDelaysMs must contain exactly one non-negative retry delay');
  // H5: 并发限制范围校验。可选,默认 4,范围 1-16。
  if (config.maxConcurrentRuns !== undefined) {
    invariant(Number.isInteger(config.maxConcurrentRuns) && config.maxConcurrentRuns >= 1 && config.maxConcurrentRuns <= 16, 'CONFIG_INVALID', 'maxConcurrentRuns must be an integer between 1 and 16');
  }
  // Self-review 阶段配置。可选,默认启用。enabled 控制是否走 self-reviewing 状态。
  // spotCheckCount 是主控 LLM 必须抽检的 acceptance criterion 数量下限(防止 Pi 全标 met 时主控偷懒)。
  // minDiffBytes 触发阈值:diff 太小时 self-review 收益不抵成本,直接跳到 reviewing。
  if (config.selfReview !== undefined && config.selfReview !== null) {
    invariant(typeof config.selfReview === 'object' && !Array.isArray(config.selfReview), 'CONFIG_INVALID', 'selfReview must be an object');
    if (config.selfReview.enabled !== undefined) invariant(typeof config.selfReview.enabled === 'boolean', 'CONFIG_INVALID', 'selfReview.enabled must be boolean');
    if (config.selfReview.spotCheckCount !== undefined) {
      invariant(Number.isInteger(config.selfReview.spotCheckCount) && config.selfReview.spotCheckCount >= 0 && config.selfReview.spotCheckCount <= 10, 'CONFIG_INVALID', 'selfReview.spotCheckCount must be an integer between 0 and 10');
    }
    if (config.selfReview.minDiffBytes !== undefined) {
      invariant(Number.isInteger(config.selfReview.minDiffBytes) && config.selfReview.minDiffBytes >= 0 && config.selfReview.minDiffBytes <= 100_000_000, 'CONFIG_INVALID', 'selfReview.minDiffBytes must be an integer between 0 and 100,000,000');
    }
    const extras = Object.keys(config.selfReview).filter((k) => !['enabled', 'spotCheckCount', 'minDiffBytes'].includes(k));
    invariant(extras.length === 0, 'CONFIG_INVALID', 'selfReview contains unsupported fields', { extras });
  }
  invariant(config.limits && typeof config.limits === 'object', 'CONFIG_INVALID', 'limits is required');
  invariant(Number.isInteger(config.limits.piTimeoutSeconds) && config.limits.piTimeoutSeconds > 0, 'CONFIG_INVALID', 'limits.piTimeoutSeconds must be positive');
  invariant(Number.isInteger(config.limits.maxChangedFiles) && config.limits.maxChangedFiles > 0, 'CONFIG_INVALID', 'limits.maxChangedFiles must be positive');
  invariant(typeof config.limits.maxDeletedLineRatio === 'number' && config.limits.maxDeletedLineRatio >= 0 && config.limits.maxDeletedLineRatio <= 1, 'CONFIG_INVALID', 'limits.maxDeletedLineRatio must be between 0 and 1');
  invariant(Number.isInteger(config.limits.maxCapturedCharsPerStream) && config.limits.maxCapturedCharsPerStream > 0, 'CONFIG_INVALID', 'limits.maxCapturedCharsPerStream must be positive');
  invariant(Number.isInteger(config.limits.maxDiffBytes) && config.limits.maxDiffBytes > 0, 'CONFIG_INVALID', 'limits.maxDiffBytes must be positive');
  invariant(Array.isArray(config.verificationEnvAllowlist) && config.verificationEnvAllowlist.every((name) => /^[A-Z_][A-Z0-9_]*$/.test(name)), 'CONFIG_INVALID', 'verificationEnvAllowlist is invalid');
  invariant(Array.isArray(config.alwaysForbiddenPaths) && config.alwaysForbiddenPaths.every((item) => typeof item === 'string' && item.length > 0), 'CONFIG_INVALID', 'alwaysForbiddenPaths is invalid');
  const rateCard = resolveRateCard(config);
  invariant(rateCard && typeof rateCard.model === 'string' && rateCard.model.length > 0 && typeof rateCard.source === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rateCard.effectiveDate), 'CONFIG_INVALID', 'parent rate card identity is invalid (set parentRateCard or codexRateCard)');
  for (const field of ['nonCachedInput', 'cachedInput', 'output']) invariant(typeof rateCard.creditsPerMillion?.[field] === 'number' && rateCard.creditsPerMillion[field] >= 0, 'CONFIG_INVALID', `rateCard.creditsPerMillion.${field} is invalid`);
  const subscription = resolveSubscription(config);
  invariant(subscription && typeof subscription.plan === 'string' && subscription.plan.length > 0 && typeof subscription.monthlyUsd === 'number' && subscription.monthlyUsd >= 0, 'CONFIG_INVALID', 'parent subscription is invalid (set parentSubscription or codexSubscription)');
  invariant(config.profiles && typeof config.profiles === 'object', 'CONFIG_INVALID', 'profiles is required');
  invariant(config.profiles[config.defaultProfile], 'CONFIG_INVALID', 'defaultProfile does not exist');
  for (const [name, profile] of Object.entries(config.profiles)) {
    for (const field of ['provider', 'model', 'apiKeyEnv']) invariant(typeof profile[field] === 'string' && profile[field].length > 0, 'CONFIG_INVALID', `profiles.${name}.${field} is required`);
    invariant(/^[A-Z_][A-Z0-9_]*$/.test(profile.apiKeyEnv), 'CONFIG_INVALID', `profiles.${name}.apiKeyEnv is invalid`);
    invariant(Array.isArray(profile.capabilities) && profile.capabilities.includes('text') && profile.capabilities.includes('code'), 'CONFIG_INVALID', `profiles.${name}.capabilities must include text and code`);
    // GLM 视觉能力硬禁已解除:用户可按模型实际能力声明 capabilities/modalities。
    // 若 GLM 某型号不支持视觉,只需在 profile 里不声明 vision-input/image-output 即可。
    invariant(Array.isArray(profile.fallbackProfiles) && profile.fallbackProfiles.length <= 1, 'CONFIG_INVALID', `profiles.${name}.fallbackProfiles supports at most one entry`);
    invariant(profile.monthlyPlan && typeof profile.monthlyPlan.currency === 'string' && typeof profile.monthlyPlan.amount === 'number' && profile.monthlyPlan.amount >= 0, 'CONFIG_INVALID', `profiles.${name}.monthlyPlan is invalid`);
    if (profile.costTier !== undefined) invariant(VALID_COST_TIERS.has(profile.costTier), 'CONFIG_INVALID', `profiles.${name}.costTier must be cheap, standard, or premium`);
    // adapter 字段:指定使用哪个 CLI adapter(pi/kimi/trae),默认 pi
    if (profile.adapter !== undefined) {
      invariant(typeof profile.adapter === 'string' && ['pi', 'kimi', 'trae', 'qoder'].includes(profile.adapter), 'CONFIG_INVALID', `profiles.${name}.adapter must be one of: pi, kimi, trae`);
    }
    // adapter 专有扩展字段(可选):
    // - providerType: Kimi/OpenAI 等 provider 的 type 字段(Kimi adapter 用)
    // - baseUrl: 覆盖 provider 默认 base_url(Kimi adapter 用)
    // - maxContextSize: 模型最大上下文(Kimi adapter 用)
    for (const extraField of ['providerType', 'baseUrl', 'maxContextSize']) {
      if (profile[extraField] !== undefined) {
        invariant(typeof profile[extraField] === 'string' || typeof profile[extraField] === 'number', 'CONFIG_INVALID', `profiles.${name}.${extraField} must be a string or number`);
      }
    }
    validateProfileFields(profile, name);
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    for (const fallback of profile.fallbackProfiles) invariant(fallback !== name && config.profiles[fallback], 'CONFIG_INVALID', `profiles.${name} references an invalid fallback: ${fallback}`);
  }
  return config;
}

export async function loadConfig(paths = resolveWorkerPaths()) {
  try {
    const validated = validateConfig(await readJson(paths.configFile));
    const selfReview = validated.selfReview
      ? {
          enabled: validated.selfReview.enabled ?? true,
          spotCheckCount: validated.selfReview.spotCheckCount ?? 1,
          minDiffBytes: validated.selfReview.minDiffBytes ?? 500,
        }
      : { enabled: true, spotCheckCount: 1, minDiffBytes: 500 };
    // 给每个 profile 补全 adapter 默认值 'pi'
    for (const [name, profile] of Object.entries(validated.profiles)) {
      if (!profile.adapter) profile.adapter = 'pi';
    }
    return { ...validated, maxConcurrentRuns: validated.maxConcurrentRuns ?? 4, selfReview };
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError('CONFIG_INVALID', `Cannot read ${paths.configFile}`, { cause: error.message });
  }
}

export function selectProfile(config, requestedName) {
  const name = requestedName ?? config.defaultProfile;
  const profile = config.profiles[name];
  invariant(profile, 'CONFIG_INVALID', `Unknown profile: ${name}`);
  return { name, ...profile };
}

export async function installDefaultConfiguration({ paths = resolveWorkerPaths() } = {}) {
  const defaultConfig = await readJson(path.join(root, 'fixtures', 'default-config.json'));
  const providerPatch = await readJson(path.join(root, 'fixtures', 'volcengine-provider.json'));
  let existingConfig = {};
  try {
    existingConfig = JSON.parse(await readFile(paths.configFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new WorkerError('CONFIG_INVALID', `Cannot parse ${paths.configFile}`, { cause: error.message });
  }
  invariant(existingConfig && typeof existingConfig === 'object' && !Array.isArray(existingConfig), 'CONFIG_INVALID', 'Existing worker config must contain an object');
  invariant(existingConfig.profiles === undefined || (existingConfig.profiles && typeof existingConfig.profiles === 'object' && !Array.isArray(existingConfig.profiles)), 'CONFIG_INVALID', 'Existing worker profiles must contain an object');
  const profileNames = new Set([...Object.keys(defaultConfig.profiles), ...Object.keys(existingConfig.profiles ?? {})]);
  const profiles = Object.fromEntries([...profileNames].map((name) => {
    const defaults = defaultConfig.profiles[name] ?? {};
    const existing = existingConfig.profiles?.[name] ?? {};
    return [name, {
      ...defaults,
      ...existing,
      monthlyPlan: { ...(defaults.monthlyPlan ?? {}), ...(existing.monthlyPlan ?? {}) },
    }];
  }));
  const defaultRateCard = defaultConfig.parentRateCard ?? defaultConfig.codexRateCard;
  const existingRateCard = existingConfig.parentRateCard ?? existingConfig.codexRateCard;
  const defaultSubscription = defaultConfig.parentSubscription ?? defaultConfig.codexSubscription;
  const existingSubscription = existingConfig.parentSubscription ?? existingConfig.codexSubscription;
  const mergedConfig = {
    ...defaultConfig,
    ...existingConfig,
    limits: { ...defaultConfig.limits, ...(existingConfig.limits ?? {}) },
    parentRateCard: {
      ...defaultRateCard,
      ...(existingRateCard ?? {}),
      creditsPerMillion: {
        ...defaultRateCard.creditsPerMillion,
        ...(existingRateCard?.creditsPerMillion ?? {}),
      },
    },
    parentSubscription: { ...defaultSubscription, ...(existingSubscription ?? {}) },
    profiles,
  };
  delete mergedConfig.codexRateCard;
  delete mergedConfig.codexSubscription;
  await writeJsonAtomic(paths.configFile, mergedConfig);
  let models = { providers: {} };
  try {
    models = JSON.parse(await readFile(paths.modelsFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new WorkerError('CONFIG_INVALID', `Cannot parse ${paths.modelsFile}`, { cause: error.message });
  }
  invariant(models && typeof models === 'object' && !Array.isArray(models), 'CONFIG_INVALID', 'models.json must contain an object');
  invariant(models.providers === undefined || (models.providers && typeof models.providers === 'object' && !Array.isArray(models.providers)), 'CONFIG_INVALID', 'models.json providers must contain an object');
  const patchProvider = providerPatch.providers['volcengine-plan'];
  const existingProvider = models.providers?.['volcengine-plan'];
  invariant(existingProvider === undefined || (existingProvider && typeof existingProvider === 'object' && !Array.isArray(existingProvider)), 'CONFIG_INVALID', 'Existing Volcengine provider must contain an object');
  invariant(existingProvider?.models === undefined || Array.isArray(existingProvider.models), 'CONFIG_INVALID', 'Existing Volcengine models must be an array');
  const existingModels = existingProvider?.models ?? [];
  const existingIds = new Set(existingModels.map((model) => model.id));
  const mergedProvider = existingProvider
    ? {
        ...patchProvider,
        ...existingProvider,
        models: [...existingModels, ...patchProvider.models.filter((model) => !existingIds.has(model.id))],
      }
    : patchProvider;
  const merged = {
    ...models,
    providers: {
      ...(models.providers ?? {}),
      'volcengine-plan': mergedProvider,
    },
  };
  await writeJsonAtomic(paths.modelsFile, merged);
  return { configFile: paths.configFile, modelsFile: paths.modelsFile };
}
