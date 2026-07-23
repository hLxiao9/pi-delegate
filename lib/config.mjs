import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './atomic-json.mjs';
import { WorkerError, invariant } from './errors.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resolveWorkerPaths(env = process.env, home = os.homedir()) {
  return {
    root,
    configFile: env.PI_WORKER_CONFIG ?? path.join(home, '.config', 'pi-worker', 'config.json'),
    modelsFile: env.PI_WORKER_MODELS_FILE ?? path.join(home, '.pi', 'agent', 'models.json'),
    stateRoot: env.PI_WORKER_STATE_DIR ?? path.join(home, '.local', 'state', 'pi-worker'),
    cacheRoot: env.PI_WORKER_CACHE_DIR ?? path.join(home, '.cache', 'pi-worker'),
    piBin: env.PI_WORKER_PI_BIN ?? 'pi',
    gitBin: env.PI_WORKER_GIT_BIN ?? 'git',
  };
}

function validateConfig(config) {
  invariant(config?.schemaVersion === 1, 'CONFIG_INVALID', 'config.schemaVersion must equal 1');
  invariant(/^\d+\.\d+\.\d+$/.test(config.minimumPiVersion), 'CONFIG_INVALID', 'minimumPiVersion must be an exact semantic version');
  invariant(typeof config.defaultProfile === 'string' && config.defaultProfile.length > 0, 'CONFIG_INVALID', 'defaultProfile is required');
  invariant(Number.isInteger(config.maxRevisionRounds) && config.maxRevisionRounds === 2, 'CONFIG_INVALID', 'maxRevisionRounds must equal 2 in v1');
  invariant(typeof config.autoIntegrateCleanSource === 'boolean', 'CONFIG_INVALID', 'autoIntegrateCleanSource must be Boolean');
  invariant(Array.isArray(config.retryDelaysMs) && config.retryDelaysMs.every((value) => Number.isInteger(value) && value >= 0), 'CONFIG_INVALID', 'retryDelaysMs must contain non-negative integers');
  invariant(config.limits && typeof config.limits === 'object', 'CONFIG_INVALID', 'limits is required');
  invariant(Number.isInteger(config.limits.piTimeoutSeconds) && config.limits.piTimeoutSeconds > 0, 'CONFIG_INVALID', 'limits.piTimeoutSeconds must be positive');
  invariant(Number.isInteger(config.limits.maxChangedFiles) && config.limits.maxChangedFiles > 0, 'CONFIG_INVALID', 'limits.maxChangedFiles must be positive');
  invariant(typeof config.limits.maxDeletedLineRatio === 'number' && config.limits.maxDeletedLineRatio >= 0 && config.limits.maxDeletedLineRatio <= 1, 'CONFIG_INVALID', 'limits.maxDeletedLineRatio must be between 0 and 1');
  invariant(Number.isInteger(config.limits.maxCapturedCharsPerStream) && config.limits.maxCapturedCharsPerStream > 0, 'CONFIG_INVALID', 'limits.maxCapturedCharsPerStream must be positive');
  invariant(Array.isArray(config.verificationEnvAllowlist) && config.verificationEnvAllowlist.every((name) => /^[A-Z_][A-Z0-9_]*$/.test(name)), 'CONFIG_INVALID', 'verificationEnvAllowlist is invalid');
  invariant(Array.isArray(config.alwaysForbiddenPaths) && config.alwaysForbiddenPaths.every((item) => typeof item === 'string' && item.length > 0), 'CONFIG_INVALID', 'alwaysForbiddenPaths is invalid');
  invariant(config.codexRateCard?.model === 'gpt-5.6-sol' && typeof config.codexRateCard.source === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(config.codexRateCard.effectiveDate), 'CONFIG_INVALID', 'codexRateCard identity is invalid');
  for (const field of ['nonCachedInput', 'cachedInput', 'output']) invariant(typeof config.codexRateCard.creditsPerMillion?.[field] === 'number' && config.codexRateCard.creditsPerMillion[field] >= 0, 'CONFIG_INVALID', `codexRateCard.creditsPerMillion.${field} is invalid`);
  invariant(config.codexSubscription?.plan === 'plus' && typeof config.codexSubscription.monthlyUsd === 'number' && config.codexSubscription.monthlyUsd >= 0, 'CONFIG_INVALID', 'codexSubscription is invalid');
  invariant(config.profiles && typeof config.profiles === 'object', 'CONFIG_INVALID', 'profiles is required');
  invariant(config.profiles[config.defaultProfile], 'CONFIG_INVALID', 'defaultProfile does not exist');
  for (const [name, profile] of Object.entries(config.profiles)) {
    for (const field of ['provider', 'model', 'apiKeyEnv']) invariant(typeof profile[field] === 'string' && profile[field].length > 0, 'CONFIG_INVALID', `profiles.${name}.${field} is required`);
    invariant(/^[A-Z_][A-Z0-9_]*$/.test(profile.apiKeyEnv), 'CONFIG_INVALID', `profiles.${name}.apiKeyEnv is invalid`);
    invariant(Array.isArray(profile.capabilities) && profile.capabilities.includes('text') && profile.capabilities.includes('code'), 'CONFIG_INVALID', `profiles.${name}.capabilities must include text and code`);
    if (/glm/i.test(profile.model)) invariant(!profile.capabilities.includes('vision-input') && !profile.capabilities.includes('image-output'), 'CONFIG_INVALID', `GLM profile ${name} cannot declare visual capabilities`);
    invariant(Array.isArray(profile.fallbackProfiles) && profile.fallbackProfiles.length <= 1, 'CONFIG_INVALID', `profiles.${name}.fallbackProfiles supports at most one entry`);
    invariant(profile.monthlyPlan && typeof profile.monthlyPlan.currency === 'string' && typeof profile.monthlyPlan.amount === 'number' && profile.monthlyPlan.amount >= 0, 'CONFIG_INVALID', `profiles.${name}.monthlyPlan is invalid`);
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    for (const fallback of profile.fallbackProfiles) invariant(fallback !== name && config.profiles[fallback], 'CONFIG_INVALID', `profiles.${name} references an invalid fallback: ${fallback}`);
  }
  return config;
}

export async function loadConfig(paths = resolveWorkerPaths()) {
  try {
    return validateConfig(await readJson(paths.configFile));
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
  const mergedConfig = {
    ...defaultConfig,
    ...existingConfig,
    limits: { ...defaultConfig.limits, ...(existingConfig.limits ?? {}) },
    codexRateCard: {
      ...defaultConfig.codexRateCard,
      ...(existingConfig.codexRateCard ?? {}),
      creditsPerMillion: {
        ...defaultConfig.codexRateCard.creditsPerMillion,
        ...(existingConfig.codexRateCard?.creditsPerMillion ?? {}),
      },
    },
    codexSubscription: { ...defaultConfig.codexSubscription, ...(existingConfig.codexSubscription ?? {}) },
    profiles,
  };
  await writeJsonAtomic(paths.configFile, mergedConfig);
  let models = { providers: {} };
  try {
    models = JSON.parse(await readFile(paths.modelsFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new WorkerError('CONFIG_INVALID', `Cannot parse ${paths.modelsFile}`, { cause: error.message });
  }
  invariant(models && typeof models === 'object' && !Array.isArray(models), 'CONFIG_INVALID', 'models.json must contain an object');
  invariant(models.providers === undefined || (models.providers && typeof models.providers === 'object' && !Array.isArray(models.providers)), 'CONFIG_INVALID', 'models.json providers must be an object');
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
