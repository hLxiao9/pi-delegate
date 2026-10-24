/*
 * spotworkers - Delegate bounded coding tasks to cheap agent workers
 * Copyright (C) 2026 hLxiao9
 *
 * Licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later).
 * See the LICENSE file at the repo root for full text.
 */

import { assertDelegableCapabilities } from './contracts.mjs';

export const DIFFICULTY_LEVELS = ['low', 'medium', 'high'];

export const COST_TIER_BY_DIFFICULTY = {
  low: 'cheap',
  medium: 'standard',
  high: 'premium',
};

// task domain dimension.for matching profile by model strength direction profile.
// orthogonal to costTier:different models within same costTier may have different strengths.
export const TASK_DOMAINS = ['frontend', 'backend', 'systems', 'algorithm', 'refactor', 'docs'];

// model supported input/output modalities.current Pi worker architecture forbids visual delegation,
// but field retained for future enabling vision-input/image-output can route when.
export const MODALITIES = ['text', 'vision', 'image-output'];

// keyword → domain inference table.match infers as that domain;multiple matches take first.
// only when task not explicitly declared domain used when.
const DOMAIN_KEYWORDS = [
  ['frontend', [/\bfront[- ]?end\b/i, /\bUI\b/i, /\bcomponent\b/i, /\bCSS\b/i, /\bReact\b/i, /\bVue\b/i, /\bSvelte\b/i, /\bSolid\b/i, /\bstyle\b/, /\bcomponent\b/, /\bpage\b/, /\bbutton\b/i, /\bform\b/i, /\bcanvas\b/i, /\bSVG\b/i]],
  ['backend', [/\bback[- ]?end\b/i, /\bAPI\b/i, /\bendpoint\b/i, /\bservice\b/i, /\bdatabase\b/i, /\bSQL\b/i, /\bORM\b/i, /\bserver\b/i, /\broute\b/i, /\binterface\b/, /\bserver-side\b/, /\bmigration\b/i, /\bschema\b/i]],
  ['systems', [/\bperformance\b/i, /\bconcurrency\b/i, /\bmemory\b/i, /\bcache\b/i, /\bruntime\b/i, /\bdaemon\b/i, /\bkernel\b/i, /\bperformance\b/, /\bconcurrency\b/, /\bmemory\b/, /\bcache\b/, /\bRuntime\b/i, /\bCLI\b/i, /\bbinary\b/i]],
  ['algorithm', [/\balgorithm\b/i, /\bsort(?:ing)?\b/i, /\bsearch(?:ing)?\b/i, /\bgraph\b/i, /\btree\b/i, /\bDP\b/i, /\bdynamic programming\b/i, /\balgorithm\b/, /\bsorting\b/, /\bsearch\b/, /\bcomplexity\b/i]],
  ['refactor', [/\brefactor\b/i, /\bcleanup\b/i, /\brestructure\b/i, /\bmodernize\b/i, /\bmigrate\b/i, /\brefactor\b/, /\bcleanup\b/, /\bmigration\b/]],
  ['docs', [/\bREADME\b/i, /\bdocumentation\b/i, /\bdocs\b/i, /\bCHANGELOG\b/i, /\bdocs\b/, /\bexplains\b/]],
];

// How much inherent difficulty a domain carries for a cheap worker.
// docs/refactor are mostly mechanical; systems/algorithm work needs the most
// reasoning. Unknown domain sits in the middle rather than the cheapest slot.
const DOMAIN_WEIGHT = {
  docs: 0,
  refactor: 1,
  frontend: 1,
  backend: 2,
  algorithm: 2,
  systems: 2,
};

// Difficulty used to be scored mostly from contract *size* — goal length,
// acceptance-criteria count, constraint count, path breadth. That created a
// perverse incentive: a carefully written contract scored high and was routed
// to the expensive model, while a short vague contract scored low and was
// routed to the cheapest one, which is exactly the combination that fails.
//
// Risk and domain are now the primary signals, and the size signals are capped
// at +2 so they can only tip a borderline task, never carry it on their own.
// A parent that knows better can state `difficulty` in the contract and skip
// inference entirely.
const SECONDARY_SIGNAL_CAP = 2;

export function inferDifficulty(task) {
  if (task.difficulty === 'low' || task.difficulty === 'medium' || task.difficulty === 'high') {
  return { difficulty: task.difficulty, score: null, signals: ['explicit'], source: 'explicit' };
  }

  let primary = 0;
  const signals = [];
  if (task.risk === 'high') { primary += 3; signals.push('risk=high'); }
  else if (task.risk === 'medium') { primary += 2; signals.push('risk=medium'); }

  const domain = typeof task.domain === 'string' && DOMAIN_WEIGHT[task.domain] !== undefined ? task.domain : null;
  primary += domain ? DOMAIN_WEIGHT[domain] : 1;
  signals.push(domain ? `domain=${domain}:${DOMAIN_WEIGHT[domain]}` : 'domain=unknown:1');

  let secondary = 0;
  if ((task.verification ?? []).length >= 3) { secondary += 1; signals.push(`verification=${(task.verification ?? []).length}`); }
  if ((task.acceptanceCriteria ?? []).length >= 8) { secondary += 1; signals.push(`acceptance=${(task.acceptanceCriteria ?? []).length}`); }
  if ((task.constraints ?? []).length >= 5) { secondary += 1; signals.push(`constraints=${(task.constraints ?? []).length}`); }
  if ((task.requiredCapabilities ?? []).includes('tool-use')) { secondary += 1; signals.push('tool-use'); }
  secondary = Math.min(secondary, SECONDARY_SIGNAL_CAP);
  if (secondary > 0) signals.push(`secondary=${secondary}`);

  const score = primary + secondary;
  let difficulty;
  if (score >= 5) difficulty = 'high';
  else if (score >= 2) difficulty = 'medium';
  else difficulty = 'low';
  return { difficulty, score, signals, source: 'inferred' };
}

// from task.goal text inference domain.task.domain explicit declaration preferred.
// return { domain, source } —— source for 'explicit' | 'inferred' | null.
export function inferTaskDomain(task) {
  if (typeof task.domain === 'string' && task.domain.length > 0) {
  return { domain: task.domain, source: 'explicit' };
  }
  const goal = task.goal ?? '';
  for (const [domain, patterns] of DOMAIN_KEYWORDS) {
  if (patterns.some((re) => re.test(goal))) {
  return { domain, source: 'inferred' };
  }
  }
  return { domain: null, source: null };
}

// legacy entry:only by difficulty costTier select,preserves backward compatibility.
export function selectProfileByDifficulty(config, difficulty) {
  const targetTier = COST_TIER_BY_DIFFICULTY[difficulty];
  if (!targetTier) return null;
  for (const [name, profile] of Object.entries(config.profiles)) {
  if (profile.costTier === targetTier) return { name, ...profile };
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
  if (profile.costTier && profile.costTier !== targetTier) continue;
  return { name, ...profile };
  }
  return null;
}

// comprehensive selection profile.three-layer matching:
//  1. explicit options.profile → return directly(user/caller override)
//  1b. options.caller → config.callerProfiles[caller](personal preference) when it can take the task
//  2. costTier filter candidates → domain ∈ strengths soft match(use on match,continue on miss)
//  3. modalities hard match:task.requiredCapabilities contains vision-input when,profile.modalities must contain vision
//  4. fallback:costTier first in candidate set;if no costTier config then defaultProfile
// note:only in config.profiles(user actually integrated models)pick from,do not assume any unconfigured model exists.
export function selectProfileForTask(config, task, options = {}) {
  // M5: high-risk tasks not delegated to Pi(unless explicitly specified profile),return directly null avoid invalid routing.
  if (task.risk === 'high' && !options.profile) return null;
  if (options.profile) {
  const named = config.profiles[options.profile];
  if (!named) throw new Error(`Unknown profile: ${options.profile}`);
  return { name: options.profile, ...named };
  }

  // Personal preference: config.callerProfiles[caller] wins over difficulty
  // routing when it can actually take the task (capabilities/modalities). A
  // vision task from a text-only preferred profile falls through to routing.
  const preferredName = options.caller ? config.callerProfiles?.[options.caller] : undefined;
  if (typeof preferredName === 'string' && config.profiles[preferredName]) {
  const preferred = { name: preferredName, ...config.profiles[preferredName] };
  let usable = true;
  try { assertDelegableCapabilities(task, preferred); } catch { usable = false; }
  if (usable) {
    return {
    ...preferred,
    fallbackProfiles: preferred.fallbackProfiles ?? [],
    routing: { matchReason: 'caller-preference', caller: options.caller, candidatesConsidered: [preferredName] },
    };
  }
  }

  const { difficulty, score, signals, source: difficultySource } = inferDifficulty(task);
  const { domain, source: domainSource } = inferTaskDomain(task);
  const targetTier = COST_TIER_BY_DIFFICULTY[difficulty];

  // candidate set:strict match costTier  profile.undeclared costTier  profile does not participate in auto routing
  // (legacy config without costTier uniformly goes through when defaultProfile fallback,avoid by Object.entries order misselection).
  let candidates = Object.entries(config.profiles)
  .filter(([, p]) => p.costTier === targetTier)
  .map(([name, p]) => ({ name, ...p }));

  // the costTier no candidates:if user provided no profile config costTier,fall back to defaultProfile;
  // if user configured other tier but missing this one tier,then degrade to all profile fallback(prioritize being able to select).
  const hasAnyCostTier = Object.values(config.profiles).some((p) => p.costTier);
  if (candidates.length === 0) {
  if (!hasAnyCostTier && config.defaultProfile && config.profiles[config.defaultProfile]) {
  const dp = config.profiles[config.defaultProfile];
  return {
  name: config.defaultProfile,
  provider: dp.provider,
  model: dp.model,
  thinking: dp.thinking,
  apiKeyEnv: dp.apiKeyEnv,
  capabilities: dp.capabilities,
  fallbackProfiles: dp.fallbackProfiles ?? [],
  costTier: dp.costTier ?? null,
  strengths: dp.strengths ?? [],
  modalities: dp.modalities ?? ['text'],
  monthlyPlan: dp.monthlyPlan ?? null,
  routing: {
  difficulty, difficultyScore: score, difficultySignals: signals, difficultySource,
  domain, domainSource, targetTier,
  matchReason: 'defaultProfile-no-tier-configured',
  candidatesConsidered: [config.defaultProfile],
  },
  };
  }
  candidates = Object.entries(config.profiles).map(([name, p]) => ({ name, ...p }));
  }

  // modalities hard match:vision/image tasks must route to declared modality  profile.
  // if candidate set does not have,means user did not configure vision/image model → routing failure,return null caller reports block.
  const needsVision = (task.requiredCapabilities ?? []).includes('vision-input');
  const needsImageOutput = (task.requiredCapabilities ?? []).includes('image-output');
  if (needsVision) {
  candidates = candidates.filter((p) => (p.modalities ?? ['text']).includes('vision'));
  }
  if (needsImageOutput) {
  candidates = candidates.filter((p) => (p.modalities ?? ['text']).includes('image-output'));
  }
  if (candidates.length === 0) return null;

  // domain strengths soft match:prioritize on match,keep original candidate set on miss.
  let selected = null;
  let matchReason = 'costTier-fallback';
  if (domain) {
  const strong = candidates.find((p) => Array.isArray(p.strengths) && p.strengths.includes(domain));
  if (strong) {
  selected = strong;
  matchReason = `strengths:${domain}`;
  }
  }
  if (!selected) {
  selected = candidates[0] ?? null;
  if (selected && domain && domainSource === 'inferred') {
  matchReason = `costTier-no-strength-match:${domain}`;
  } else if (selected) {
  matchReason = `costTier:${targetTier ?? 'none'}`;
  } else {
  matchReason = 'defaultProfile';
  }
  }

  // final fallback:defaultProfile.
  if (!selected && config.defaultProfile) {
  const dp = config.profiles[config.defaultProfile];
  if (dp) selected = { name: config.defaultProfile, ...dp };
  }

  return selected
  ? {
  name: selected.name,
  provider: selected.provider,
  model: selected.model,
  thinking: selected.thinking,
  apiKeyEnv: selected.apiKeyEnv,
  capabilities: selected.capabilities,
  fallbackProfiles: selected.fallbackProfiles ?? [],
  costTier: selected.costTier ?? null,
  strengths: selected.strengths ?? [],
  modalities: selected.modalities ?? ['text'],
  monthlyPlan: selected.monthlyPlan ?? null,
  routing: {
  difficulty,
  difficultyScore: score,
  difficultySource,
  difficultySignals: signals,
  domain,
  domainSource,
  targetTier,
  matchReason,
  candidatesConsidered: candidates.map((c) => c.name),
  },
  }
  : null;
}
