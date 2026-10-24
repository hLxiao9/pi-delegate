/*
 * spotworkers - Delegate bounded coding tasks to cheap agent workers
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

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
  registryFile: env.PI_WORKER_REGISTRY_FILE ?? path.join(home, '.cache', 'pi-worker', 'registry.json'),
  piBin: env.PI_WORKER_PI_BIN ?? 'pi',
  kimiBin: env.PI_WORKER_KIMI_BIN ?? 'kimi',
  traeBin: env.PI_WORKER_TRAE_BIN ?? 'traecli',
  qoderBin: env.PI_WORKER_QODER_BIN ?? 'qoderclicn',
  gitBin: env.PI_WORKER_GIT_BIN ?? 'git',
  };
}

// cheap/standard/premium are the three tiers that participate in automatic
// task-difficulty routing. "free" is an opt-in tier: profiles marked free never
// auto-route (no difficulty maps to it) but can be selected via --profile or
// referenced as fallback targets (e.g. the opencode free-model chain).
const VALID_COST_TIERS = new Set(['cheap', 'standard', 'premium', 'free']);

// Parent agents spotworkers recognises as a run's caller. Shared by run state
// (state.caller), dashboard grouping and per-caller profile preferences.
export const KNOWN_CALLERS = new Set(['trae', 'codex', 'claude-code', 'cursor', 'pi-recursive', 'cli', 'workbuddy']);

// Resolve the caller/source of a run. Precedence:
//   1. PARENT_AGENT / PI_WORKER_CALLER (explicit, set by the invoking agent)
//   2. WORKBUDDY / WORKBUDDY_AGENT (WorkBuddy shell integration marker)
//   3. 'cli' (a human at a TTY, no driving agent)
// Anything outside KNOWN_CALLERS collapses to 'unknown'.
export function resolveCallerEnv(env = process.env) {
  const explicit = env.PARENT_AGENT ?? env.PI_WORKER_CALLER;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (env.WORKBUDDY ?? env.WORKBUDDY_AGENT) return 'workbuddy';
  return 'cli';
}

export function normalizeCaller(value) {
  if (typeof value !== 'string') return 'unknown';
  const lower = value.toLowerCase().trim();
  return KNOWN_CALLERS.has(lower) ? lower : 'unknown';
}

// Personal routing preference: `callerProfiles` maps a caller to the profile
// it starts from when no --profile is given (e.g. Claude Code on free Qoder
// models while Codex keeps its own default). Lives in the user's own
// config.json, so every machine/user keeps its own taste; the shipped default
// config does not set it. Returns null when the caller has no preference.
export function preferredProfileForCaller(config, caller) {
  const name = config.callerProfiles?.[caller];
  return typeof name === 'string' && config.profiles?.[name] ? name : null;
}

// Files that define HOW a verification command executes rather than what it
// proves. Applied even when the config predates this key, because a silent
// opt-out would leave exactly the older installs unprotected. Set
// `alwaysLockedPaths: []` explicitly to disable the default entirely.
export const DEFAULT_ALWAYS_LOCKED_PATHS = [
  '.github/workflows/**',
  '.github/actions/**',
  '.gitlab-ci.yml',
  '.circleci/**',
  '**/vitest.config.*',
  '**/jest.config.*',
  '**/jest.setup.*',
  '**/playwright.config.*',
  '**/cypress.config.*',
  '**/.mocharc.*',
  '**/karma.conf.*',
  '**/pytest.ini',
  '**/tox.ini',
  '**/setup.cfg',
  '**/phpunit.xml*',
];

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
  // H5: concurrency limit range validation.optional,default 4,range 1-16.
  if (config.maxConcurrentRuns !== undefined) {
  invariant(Number.isInteger(config.maxConcurrentRuns) && config.maxConcurrentRuns >= 1 && config.maxConcurrentRuns <= 16, 'CONFIG_INVALID', 'maxConcurrentRuns must be an integer between 1 and 16');
  }
  // Self-review phase configuration.optional,enabled by default.enabled controls whether to go through self-reviewing status.
  // spotCheckCount is parent LLM must spot-check acceptance criterion lower bound count(prevent Pi all marked met when parent slacks off).
  // minDiffBytes trigger threshold:diff when too small self-review cost outweighs benefit,directly jumps to reviewing.
  if (config.selfReview !== undefined && config.selfReview !== null) {
  invariant(typeof config.selfReview === 'object' && !Array.isArray(config.selfReview), 'CONFIG_INVALID', 'selfReview must be an object');
  if (config.selfReview.enabled !== undefined) invariant(typeof config.selfReview.enabled === 'boolean', 'CONFIG_INVALID', 'selfReview.enabled must be boolean');
  if (config.selfReview.spotCheckCount !== undefined) {
  invariant(Number.isInteger(config.selfReview.spotCheckCount) && config.selfReview.spotCheckCount >= 0 && config.selfReview.spotCheckCount <= 10, 'CONFIG_INVALID', 'selfReview.spotCheckCount must be an integer between 0 and 10');
  }
  if (config.selfReview.minDiffBytes !== undefined) {
  invariant(Number.isInteger(config.selfReview.minDiffBytes) && config.selfReview.minDiffBytes >= 0 && config.selfReview.minDiffBytes <= 100_000_000, 'CONFIG_INVALID', 'selfReview.minDiffBytes must be an integer between 0 and 100,000,000');
  }
  // minSurfaceBytes gates on diff + changed-file bytes instead of the diff
  // alone, because a report on a small diff inside a big file is a net loss.
  if (config.selfReview.minSurfaceBytes !== undefined) {
  invariant(Number.isInteger(config.selfReview.minSurfaceBytes) && config.selfReview.minSurfaceBytes >= 0 && config.selfReview.minSurfaceBytes <= 100_000_000, 'CONFIG_INVALID', 'selfReview.minSurfaceBytes must be an integer between 0 and 100,000,000');
  }
  // spotCheckRatio: share of `met` criteria the parent must verify against the
  // real diff. A fixed count of 1 does not scale — on a 12-criterion contract it
  // lets a dishonest worker through 11 of 12 times.
  if (config.selfReview.spotCheckRatio !== undefined) {
  invariant(typeof config.selfReview.spotCheckRatio === 'number' && config.selfReview.spotCheckRatio >= 0 && config.selfReview.spotCheckRatio <= 1, 'CONFIG_INVALID', 'selfReview.spotCheckRatio must be a number between 0 and 1');
  }
  const extras = Object.keys(config.selfReview).filter((k) => !['enabled', 'spotCheckCount', 'spotCheckRatio', 'minDiffBytes', 'minSurfaceBytes'].includes(k));
  invariant(extras.length === 0, 'CONFIG_INVALID', 'selfReview contains unsupported fields', { extras });
  }
  invariant(config.limits && typeof config.limits === 'object', 'CONFIG_INVALID', 'limits is required');
  invariant(Number.isInteger(config.limits.piTimeoutSeconds) && config.limits.piTimeoutSeconds > 0, 'CONFIG_INVALID', 'limits.piTimeoutSeconds must be positive');
  invariant(Number.isInteger(config.limits.maxChangedFiles) && config.limits.maxChangedFiles > 0, 'CONFIG_INVALID', 'limits.maxChangedFiles must be positive');
  invariant(typeof config.limits.maxDeletedLineRatio === 'number' && config.limits.maxDeletedLineRatio >= 0 && config.limits.maxDeletedLineRatio <= 1, 'CONFIG_INVALID', 'limits.maxDeletedLineRatio must be between 0 and 1');
  // Optional: absolute ceiling on deleted lines, because a ratio alone cannot
  // catch "small percentage of a very large file".
  if (config.limits.maxDeletedLines !== undefined) {
  invariant(Number.isInteger(config.limits.maxDeletedLines) && config.limits.maxDeletedLines > 0, 'CONFIG_INVALID', 'limits.maxDeletedLines must be a positive integer');
  }
  invariant(Number.isInteger(config.limits.maxCapturedCharsPerStream) && config.limits.maxCapturedCharsPerStream > 0, 'CONFIG_INVALID', 'limits.maxCapturedCharsPerStream must be positive');
  invariant(Number.isInteger(config.limits.maxDiffBytes) && config.limits.maxDiffBytes > 0, 'CONFIG_INVALID', 'limits.maxDiffBytes must be positive');
  invariant(Array.isArray(config.verificationEnvAllowlist) && config.verificationEnvAllowlist.every((name) => /^[A-Z_][A-Z0-9_]*$/.test(name)), 'CONFIG_INVALID', 'verificationEnvAllowlist is invalid');
  invariant(Array.isArray(config.alwaysForbiddenPaths) && config.alwaysForbiddenPaths.every((item) => typeof item === 'string' && item.length > 0), 'CONFIG_INVALID', 'alwaysForbiddenPaths is invalid');
  // alwaysLockedPaths: files that define HOW verification runs, not what it
  // proves. Editing them lets a worker rewrite its own acceptance test.
  if (config.alwaysLockedPaths !== undefined) {
  invariant(Array.isArray(config.alwaysLockedPaths) && config.alwaysLockedPaths.every((item) => typeof item === 'string' && item.length > 0), 'CONFIG_INVALID', 'alwaysLockedPaths is invalid');
  }
  const rateCard = resolveRateCard(config);
  invariant(rateCard && typeof rateCard.model === 'string' && rateCard.model.length > 0 && typeof rateCard.source === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rateCard.effectiveDate), 'CONFIG_INVALID', 'parent rate card identity is invalid (set parentRateCard or codexRateCard)');
  for (const field of ['nonCachedInput', 'cachedInput', 'output']) invariant(typeof rateCard.creditsPerMillion?.[field] === 'number' && rateCard.creditsPerMillion[field] >= 0, 'CONFIG_INVALID', `rateCard.creditsPerMillion.${field} is invalid`);
  // parentRateCards[backend] lets each parent agent keep its own rate card.
  // Applying the Codex card to a Claude Code session silently produced
  // meaningless "credits saved" numbers.
  if (config.parentRateCards !== undefined) {
  invariant(config.parentRateCards && typeof config.parentRateCards === 'object' && !Array.isArray(config.parentRateCards), 'CONFIG_INVALID', 'parentRateCards must be an object keyed by parent backend');
  for (const [backend, card] of Object.entries(config.parentRateCards)) {
  invariant(typeof backend === 'string' && backend.length > 0, 'CONFIG_INVALID', 'parentRateCards keys must be non-empty backend names');
  invariant(card && typeof card.model === 'string' && card.model.length > 0 && typeof card.source === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(card.effectiveDate), 'CONFIG_INVALID', `parentRateCards.${backend} identity is invalid`);
  if (card.shape !== undefined) invariant(['cumulative', 'separate'].includes(card.shape), 'CONFIG_INVALID', `parentRateCards.${backend}.shape must be cumulative or separate`);
  for (const field of ['nonCachedInput', 'cachedInput', 'output']) invariant(typeof card.creditsPerMillion?.[field] === 'number' && card.creditsPerMillion[field] >= 0, 'CONFIG_INVALID', `parentRateCards.${backend}.creditsPerMillion.${field} is invalid`);
  }
  }
  const subscription = resolveSubscription(config);
  invariant(subscription && typeof subscription.plan === 'string' && subscription.plan.length > 0 && typeof subscription.monthlyUsd === 'number' && subscription.monthlyUsd >= 0, 'CONFIG_INVALID', 'parent subscription is invalid (set parentSubscription or codexSubscription)');
  invariant(config.profiles && typeof config.profiles === 'object', 'CONFIG_INVALID', 'profiles is required');
  invariant(config.profiles[config.defaultProfile], 'CONFIG_INVALID', 'defaultProfile does not exist');
  for (const [name, profile] of Object.entries(config.profiles)) {
  // provider + model are required; apiKeyEnv is OPTIONAL. Adapters whose
  // worker manages its own credentials (e.g. opencode, which reads its own
  // provider config) can omit apiKeyEnv entirely.
  // provider is required; model is required BUT may be an empty string, which
  // means "let the adapter/worker pick its own default" (zero-config path, used
  // by the opencode adapter). Adapters that need a pinned model simply declare one.
  invariant(typeof profile.provider === 'string' && profile.provider.length > 0, 'CONFIG_INVALID', `profiles.${name}.provider is required`);
  invariant(typeof profile.model === 'string', 'CONFIG_INVALID', `profiles.${name}.model must be a string (empty = adapter default)`);
  if (profile.apiKeyEnv !== undefined) invariant(typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0 && /^[A-Z_][A-Z0-9_]*$/.test(profile.apiKeyEnv), 'CONFIG_INVALID', `profiles.${name}.apiKeyEnv is invalid`);
  invariant(Array.isArray(profile.capabilities) && profile.capabilities.includes('text') && profile.capabilities.includes('code'), 'CONFIG_INVALID', `profiles.${name}.capabilities must include text and code`);
  // GLM vision capability hard ban lifted:users can declare per model actual capability capabilities/modalities.
  // if GLM if a model does not support vision,just in profile do not declare in vision-input/image-output and that's it.
  invariant(Array.isArray(profile.fallbackProfiles) && profile.fallbackProfiles.length <= 6, 'CONFIG_INVALID', `profiles.${name}.fallbackProfiles supports at most 6 entries`);
  invariant(profile.monthlyPlan && typeof profile.monthlyPlan.currency === 'string' && typeof profile.monthlyPlan.amount === 'number' && profile.monthlyPlan.amount >= 0, 'CONFIG_INVALID', `profiles.${name}.monthlyPlan is invalid`);
  if (profile.costTier !== undefined) invariant(VALID_COST_TIERS.has(profile.costTier), 'CONFIG_INVALID', `profiles.${name}.costTier must be one of: cheap, standard, premium, free`);
  // adapter field:specifies which CLI adapter(pi/kimi/trae/qoder/opencode),default pi
  if (profile.adapter !== undefined) {
  invariant(typeof profile.adapter === 'string' && ['pi', 'kimi', 'trae', 'qoder', 'opencode', 'codebuddy', 'zcode'].includes(profile.adapter), 'CONFIG_INVALID', `profiles.${name}.adapter must be one of: pi, kimi, trae, qoder, opencode, codebuddy, zcode`);
  }
  // adapter proprietary extension field(optional):
  // - providerType: Kimi/OpenAI etc. provider  type field(Kimi adapter use)
  // - baseUrl: override provider default base_url(Kimi adapter use)
  // - maxContextSize: model max context(Kimi adapter use, Qoder passes it as --context-window)
  // - reasoningEffort: thinking depth for CLIs that expose it (Qoder: --reasoning-effort)
  for (const extraField of ['providerType', 'baseUrl', 'maxContextSize', 'reasoningEffort']) {
  if (profile[extraField] !== undefined) {
  invariant(typeof profile[extraField] === 'string' || typeof profile[extraField] === 'number', 'CONFIG_INVALID', `profiles.${name}.${extraField} must be a string or number`);
  }
  }
  validateProfileFields(profile, name);
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
  for (const fallback of profile.fallbackProfiles) invariant(fallback !== name && config.profiles[fallback], 'CONFIG_INVALID', `profiles.${name} references an invalid fallback: ${fallback}`);
  }
  if (config.callerProfiles !== undefined) {
  invariant(config.callerProfiles && typeof config.callerProfiles === 'object' && !Array.isArray(config.callerProfiles), 'CONFIG_INVALID', 'callerProfiles must be an object mapping caller -> profile name');
  for (const [caller, name] of Object.entries(config.callerProfiles)) {
    invariant(KNOWN_CALLERS.has(caller), 'CONFIG_INVALID', `callerProfiles.${caller} is not a known caller (one of: ${[...KNOWN_CALLERS].join(', ')})`);
    invariant(typeof name === 'string' && config.profiles[name], 'CONFIG_INVALID', `callerProfiles.${caller} references an unknown profile: ${name}`);
  }
  }
  return config;
}

// Build the post-validation config object (fills selfReview defaults and the
// 'pi' adapter default per profile). Used both by loadConfig's primary path
// and by the ENOENT auto-install recovery path so they stay in sync.
function finalizeConfig(validated) {
  const selfReview = validated.selfReview
  ? {
  enabled: validated.selfReview.enabled ?? true,
  spotCheckCount: validated.selfReview.spotCheckCount ?? 1,
  spotCheckRatio: validated.selfReview.spotCheckRatio ?? 0.34,
  minDiffBytes: validated.selfReview.minDiffBytes ?? 500,
  minSurfaceBytes: validated.selfReview.minSurfaceBytes ?? 4000,
  }
  : { enabled: true, spotCheckCount: 1, spotCheckRatio: 0.34, minDiffBytes: 500, minSurfaceBytes: 4000 };
  // for each profile fill in adapter default value 'pi'
  for (const [name, profile] of Object.entries(validated.profiles)) {
  if (!profile.adapter) profile.adapter = 'pi';
  }
  return { ...validated, maxConcurrentRuns: validated.maxConcurrentRuns ?? 4, alwaysLockedPaths: validated.alwaysLockedPaths ?? DEFAULT_ALWAYS_LOCKED_PATHS, selfReview };
}

export async function loadConfig(paths = resolveWorkerPaths()) {
  try {
  const validated = validateConfig(await readJson(paths.configFile));
  return finalizeConfig(validated);
  } catch (error) {
  // Fix 9: auto-install default config on first run (ENOENT) so `spot
  // doctor` / `spot run` work out-of-the-box without forcing the user
  // through `spot init` first. The installer is idempotent and merges
  // with existing config, so this is safe even if a sibling process races
  // us. Re-validation goes through the normal path after install.
  if (error?.code === 'ENOENT') {
  await installDefaultConfiguration({ paths });
  const revalidated = validateConfig(await readJson(paths.configFile));
  return finalizeConfig(revalidated);
  }
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
  parentRateCards: { ...(defaultConfig.parentRateCards ?? {}), ...(existingConfig.parentRateCards ?? {}) },
  alwaysLockedPaths: existingConfig.alwaysLockedPaths ?? defaultConfig.alwaysLockedPaths ?? [],
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
